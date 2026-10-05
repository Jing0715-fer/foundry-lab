// Cross-platform host utilities — SERVER-SIDE ONLY.
//
// Shared by real-executor, install-jobs, foundry and /api/tools/scan so tool
// detection and installation behave the same on Windows, macOS and Linux:
//   - getPlatformInfo()  host OS summary for API responses / UI badges
//   - crossWhich(binary) PATH lookup that works on every platform (pure JS
//                        scan first, `where`/`which` fallback — NEVER a shell
//                        string; win32 probes the PATHEXT extensions)
//   - runCapture(cmd…)   spawnSync in ARRAY form (no shell) → stdout | null
//   - bashAvailable()    whether a bash exists (github-method one-click
//                        installs are bash scripts; Windows needs WSL/Git-Bash)
//
// Do NOT import this module from client components (node:os / node:path /
// node:child_process).

import { spawnSync } from "child_process";
import { accessSync, constants as fsConstants, existsSync } from "fs";
import * as os from "os";
import * as path from "path";

/** Host platform summary (JSON-serializable; client mirror in lib/types.ts). */
export interface PlatformInfo {
  /** process.platform — "win32" | "darwin" | "linux" | … */
  os: NodeJS.Platform;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  /** Human label, e.g. "Linux x64" / "macOS arm64" / "Windows x64". */
  label: string;
  /** path separator — "/" on POSIX, "\\" on win32. */
  pathSep: string;
}

/** One-shot host platform snapshot (cheap — no syscalls beyond os.type/arch). */
export function getPlatformInfo(): PlatformInfo {
  const pretty =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "macOS"
        : os.type(); // "Linux" (and honest passthrough for anything exotic)
  return {
    os: process.platform,
    isWindows: process.platform === "win32",
    isMac: process.platform === "darwin",
    isLinux: process.platform === "linux",
    label: `${pretty} ${os.arch()}`,
    pathSep: path.sep,
  };
}

/** win32 executable extensions, in PATHEXT order (uppercase by convention). */
const WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * Locate an executable on PATH — cross-platform `which`.
 *   1. Pure JS scan of $PATH split by path.delimiter; on win32 each directory
 *      is probed with the PATHEXT extensions, on POSIX the bare name is
 *      additionally checked for the executable bit.
 *   2. Fallback to the platform locator (`where` on win32, `which` elsewhere)
 *      — spawned in ARRAY form, never through a shell string.
 * Returns the first resolved path, or null.
 */
export function crossWhich(binary: string): string | null {
  if (!binary) return null;
  const isWin = process.platform === "win32";
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = isWin
    ? WINDOWS_PATHEXT.flatMap((ext) =>
        dirs.map((d) => path.join(d, `${binary}${ext}`)),
      )
    : dirs.map((d) => path.join(d, binary));
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    if (!isWin) {
      try {
        accessSync(cand, fsConstants.X_OK);
      } catch {
        continue; // present but not executable — not a match
      }
    }
    return cand;
  }
  try {
    const res = spawnSync(isWin ? "where" : "which", [binary], {
      stdio: "pipe",
      timeout: 5000,
    });
    if (res.status === 0 && res.stdout) {
      const first = res.stdout
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (first) return first;
    }
  } catch {
    /* locator unavailable — treat as not found */
  }
  return null;
}

/**
 * Run a command and capture stdout — spawnSync ARRAY form (no shell, no
 * string concatenation). Returns stdout, or null when the command fails,
 * times out, or cannot be spawned.
 */
export function runCapture(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
): string | null {
  try {
    const res = spawnSync(cmd, args, {
      stdio: "pipe",
      timeout: timeoutMs,
      shell: false,
      encoding: "utf8",
    });
    if (res.error || res.status !== 0) return null;
    return typeof res.stdout === "string" ? res.stdout : null;
  } catch {
    return null;
  }
}

/** Whether a bash is usable on this host (true on macOS/Linux; on Windows
 *  only when WSL or Git-Bash provides one). */
export function bashAvailable(): boolean {
  try {
    const res = spawnSync("bash", ["-lc", "echo ok"], {
      stdio: "pipe",
      timeout: 5000,
    });
    return res.status === 0 && !res.error;
  } catch {
    return false;
  }
}
