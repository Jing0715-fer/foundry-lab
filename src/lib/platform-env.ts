// Cross-platform environment layer — OS detection, package-manager discovery,
// shell-less binary resolution, and install-lane selection so external tool
// DETECTION and INSTALLATION work on Linux, macOS, and Windows (native cmd
// lane + WSL lane for POSIX-flavored installs).
//
// Everything here is cached per process (stashed on globalThis so dev-server
// hot reloads don't re-probe).

import { execSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { delimiter as pathDelimiter, join } from "path";

export type OsKey = "linux" | "macos" | "windows";

export interface PackageManagerInfo {
  /** Stable key matching the registry's system-install maps (e.g. "brew"). */
  key: string;
  label: string;
  kind: "system" | "python" | "universal";
  available: boolean;
}

export interface PythonResolution {
  /** Invocation command (may contain a space, e.g. "py -3"), or null. */
  command: string | null;
  version: string | null;
}

export interface PlatformInfo {
  os: OsKey;
  /** Human label, e.g. "Ubuntu 22.04.4 LTS" / "macOS 14.2" / "Windows 11". */
  osLabel: string;
  arch: string;
  /** Lane used for simple installs: bash (posix) or cmd (windows). */
  shell: "bash" | "cmd";
  isPosix: boolean;
  /** Windows only: a usable WSL distro is present (POSIX lane available). */
  wsl: boolean;
  python: PythonResolution;
  packageManagers: PackageManagerInfo[];
}

// ── OS detection ────────────────────────────────────────────────────────────

export function osKey(): OsKey {
  const p = process.platform;
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux";
}

export function isPosix(): boolean {
  return osKey() !== "windows";
}

function detectOsLabel(): string {
  try {
    if (process.platform === "linux") {
      const raw = readFileSync("/etc/os-release", "utf8");
      const line = raw
        .split("\n")
        .find((l) => l.startsWith("PRETTY_NAME="));
      return line ? line.slice("PRETTY_NAME=".length).trim().replace(/^"|"$/g, "") : "Linux";
    }
    if (process.platform === "darwin") {
      const v = quietRun("sw_vers -productVersion") ?? "?";
      return `macOS ${v}`;
    }
    if (process.platform === "win32") {
      // `ver` works in the default cmd shell used by execSync on Windows.
      const v = quietRun("ver") ?? "";
      const m = v.match(/(\d+\.\d+\.\d+)/);
      if (m) {
        const build = Number(m[1].split(".")[2] ?? 0);
        const major = m[1].startsWith("10.0") ? (build >= 22000 ? "Windows 11" : "Windows 10") : `Windows ${m[1].split(".")[0]}`;
        return `${major} (build ${m[1]})`;
      }
      return "Windows";
    }
  } catch {
    /* fall through */
  }
  return process.platform;
}

// ── Shell-less command resolution (a `which` that works everywhere) ─────────

/**
 * Resolve a bare command name to an executable path by scanning PATH
 * (+ PATHEXT extensions on Windows) with the fs — no shell involved, so it
 * behaves identically on Linux / macOS / Windows.
 * Absolute or relative paths are checked directly.
 */
export function resolveCommandPath(binary: string): string | null {
  if (!binary) return null;
  if (binary.includes("/") || binary.includes("\\")) {
    return isExecutableFile(binary) ? binary : null;
  }
  const dirs = (process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
  const exts =
    osKey() === "windows"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, `${binary}${ext}`);
      if (isExecutableFile(p)) return p;
    }
  }
  return null;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    const st = statSync(p);
    if (!st.isFile()) return false;
    // POSIX: check any exec bit; Windows: files with exec extensions are
    // covered by PATHEXT above.
    return osKey() === "windows" ? true : (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** execSync with output captured (never printed) and errors swallowed.
 *  NOTE: on Windows the default execSync shell is cmd.exe — only pass
 *  cmd-compatible command strings (no `2>/dev/null` etc.). */
export function quietRun(cmd: string, timeoutMs = 8000): string | null {
  try {
    return execSync(cmd, { stdio: "pipe", timeout: timeoutMs }).toString().trim();
  } catch {
    return null;
  }
}

// ── Python resolution ───────────────────────────────────────────────────────

/** Interpreter candidates, most-preferred first, per OS. */
function pythonCandidates(): string[] {
  if (osKey() === "windows") {
    return ["py -3", "python", "python3"];
  }
  return [
    "/home/z/.venv/bin/python3",
    "python3",
    "/usr/bin/python3",
    "python",
  ];
}

function commandExists(cmd: string): boolean {
  const first = cmd.split(" ")[0];
  return resolveCommandPath(first) !== null;
}

/** Any usable python interpreter (no numpy requirement). */
export function resolveAnyPython(): PythonResolution {
  for (const cand of pythonCandidates()) {
    if (!commandExists(cand)) continue;
    const version = quietRun(`${cand} --version`) ?? quietRun(`${cand} -V`);
    if (version) return { command: cand, version: version.split("\n")[0] };
  }
  return { command: null, version: null };
}

/** The python the ENGINES will run on — the first candidate that has numpy.
 *  Falls back to any python so pip installs still have a target. */
export function resolveEnginePythonCmd(): PythonResolution {
  for (const cand of pythonCandidates()) {
    if (!commandExists(cand)) continue;
    if (quietRun(`${cand} -c "import numpy"`) !== null) {
      const version = quietRun(`${cand} --version`) ?? "";
      return { command: cand, version: version.split("\n")[0] || null };
    }
  }
  // No numpy-capable interpreter — degrade to any python (installs will
  // target it; engines will self-test FAIL until numpy lands).
  return resolveAnyPython();
}

// ── Package managers ────────────────────────────────────────────────────────

const PM_PROBES: { key: string; label: string; kind: PackageManagerInfo["kind"]; binary: string }[] = [
  // POSIX system managers
  { key: "apt-get", label: "apt (Debian/Ubuntu)", kind: "system", binary: "apt-get" },
  { key: "dnf", label: "dnf (Fedora/RHEL)", kind: "system", binary: "dnf" },
  { key: "yum", label: "yum (RHEL legacy)", kind: "system", binary: "yum" },
  { key: "pacman", label: "pacman (Arch)", kind: "system", binary: "pacman" },
  { key: "zypper", label: "zypper (openSUSE)", kind: "system", binary: "zypper" },
  { key: "apk", label: "apk (Alpine)", kind: "system", binary: "apk" },
  { key: "nix-env", label: "nix", kind: "system", binary: "nix-env" },
  { key: "brew", label: "Homebrew", kind: "system", binary: "brew" },
  // Windows system managers
  { key: "winget", label: "winget", kind: "system", binary: "winget" },
  { key: "choco", label: "Chocolatey", kind: "system", binary: "choco" },
  { key: "scoop", label: "Scoop", kind: "system", binary: "scoop" },
  // Universal env managers (any OS)
  { key: "conda", label: "conda", kind: "universal", binary: "conda" },
  { key: "mamba", label: "mamba", kind: "universal", binary: "mamba" },
  { key: "uv", label: "uv", kind: "universal", binary: "uv" },
  { key: "pixi", label: "pixi", kind: "universal", binary: "pixi" },
];

function detectPackageManagers(): PackageManagerInfo[] {
  const found = PM_PROBES.map((p) => ({
    key: p.key,
    label: p.label,
    kind: p.kind,
    available: resolveCommandPath(p.binary) !== null,
  }));
  // Python-tier: pip through the resolved interpreter.
  const py = resolveEnginePythonCmd().command;
  if (py) {
    found.push({
      key: "pip",
      label: `pip (${py})`,
      kind: "python",
      available: quietRun(`${py} -m pip --version`) !== null,
    });
  }
  return found;
}

/** The first AVAILABLE system package manager, or null. Order = PM_PROBES. */
export function firstSystemPackageManager(): PackageManagerInfo | null {
  const pms = getPlatformInfo().packageManagers;
  const idx = PM_PROBES.findIndex((p) => p.key === pms.find((x) => x.key === p.key && x.available)?.key);
  if (idx < 0) return null;
  return pms.find((x) => x.key === PM_PROBES[idx].key && x.available) ?? null;
}

// ── WSL (Windows POSIX lane) ────────────────────────────────────────────────

function detectWsl(): boolean {
  if (osKey() !== "windows") return false;
  if (!resolveCommandPath("wsl")) return false;
  // Confirm a distro actually boots.
  return quietRun('wsl -e sh -c "echo ok"', 10000) === "ok";
}

// ── Cached platform info ────────────────────────────────────────────────────

const globalStore = globalThis as unknown as {
  __foundryPlatformInfo?: PlatformInfo;
};

export function getPlatformInfo(): PlatformInfo {
  if (globalStore.__foundryPlatformInfo) return globalStore.__foundryPlatformInfo;
  const info: PlatformInfo = {
    os: osKey(),
    osLabel: detectOsLabel(),
    arch: process.arch,
    shell: osKey() === "windows" ? "cmd" : "bash",
    isPosix: isPosix(),
    wsl: detectWsl(),
    python: resolveEnginePythonCmd(),
    packageManagers: detectPackageManagers(),
  };
  globalStore.__foundryPlatformInfo = info;
  return info;
}

/** Reset the cached platform info (incl. the python/package-manager
 *  resolution). Called after a SUCCESSFUL one-click install — the install
 *  may have added python/numpy/pip that the cached negative resolution
 *  still denies. The next getPlatformInfo() call re-probes everything. */
export function resetPlatformInfoCache(): void {
  globalStore.__foundryPlatformInfo = undefined;
}

// ── System-tier install hints (per package manager) ─────────────────────────

/** Per-package-manager install commands for system-managed runtime deps. */
export const SYSTEM_INSTALL_COMMANDS: Record<string, Record<string, string>> = {
  python3: {
    "apt-get": "sudo apt-get install -y python3 python3-pip",
    dnf: "sudo dnf install -y python3 python3-pip",
    yum: "sudo yum install -y python3",
    pacman: "sudo pacman -S --noconfirm python python-pip",
    zypper: "sudo zypper install -y python3 python3-pip",
    apk: "apk add --no-cache python3 py3-pip",
    "nix-env": "nix-env -iA nixpkgs.python3",
    brew: "brew install python3",
    winget: "winget install -e --id Python.Python.3.12",
    choco: "choco install -y python3",
    scoop: "scoop install python",
  },
  git: {
    "apt-get": "sudo apt-get install -y git",
    dnf: "sudo dnf install -y git",
    yum: "sudo yum install -y git",
    pacman: "sudo pacman -S --noconfirm git",
    zypper: "sudo zypper install -y git",
    apk: "apk add --no-cache git",
    "nix-env": "nix-env -iA nixpkgs.git",
    brew: "brew install git",
    winget: "winget install -e --id Git.Git",
    choco: "choco install -y git",
    scoop: "scoop install git",
  },
};

/**
 * Resolve the effective one-click install command for a system-tier entry
 * from the package managers actually present on this machine.
 * Returns null when no known package manager can provide it.
 */
export function resolveSystemInstall(
  key: string,
): { command: string; viaLabel: string } | null {
  const map = SYSTEM_INSTALL_COMMANDS[key];
  if (!map) return null;
  for (const p of getPlatformInfo().packageManagers) {
    if (p.available && map[p.key]) {
      return { command: map[p.key], viaLabel: p.label };
    }
  }
  return null;
}

// ── Install lane selection ──────────────────────────────────────────────────

export interface InstallLane {
  file: string;
  args: string[];
  /** Shown in the job log so users see which lane ran. */
  label: string;
}

/** Heuristic: does this command need a POSIX shell (test-bracket if, source,
 *  .sh scripts, venv bin paths, export…)? Such commands cannot run in cmd. */
export function isPosixFlavored(command: string): boolean {
  return /(^|[;&|]\s*)(if\s+\[|source\s|\.\/|export\s)|(mkdir\s+-p)|(\.sh\b)|(\/bin\/)|(\/\.venv\/)|(`\$\()/.test(
    command,
  );
}

/**
 * Pick the execution lane for an install command:
 * - POSIX systems → bash (sh fallback).
 * - Windows + simple chain (pip/uv/conda) → cmd.exe (supports && / ||).
 * - Windows + POSIX-flavored → WSL bash when available, else null
 *   (caller surfaces a "needs WSL / Linux / macOS" hint).
 */
export function resolveInstallLane(command: string): InstallLane | null {
  const os = osKey();
  if (os !== "windows") {
    const bash = resolveCommandPath("bash") ? "bash" : "sh";
    return { file: bash, args: ["-c", command], label: bash };
  }
  if (isPosixFlavored(command)) {
    if (detectWsl()) {
      return {
        file: "wsl.exe",
        args: ["-e", "bash", "-c", command],
        label: "WSL bash",
      };
    }
    return null;
  }
  return { file: "cmd.exe", args: ["/d", "/s", "/c", command], label: "cmd" };
}

// ── Effective install spec resolution (shared by scan + install) ────────────

/** Structural slice of a registry entry's install spec — enough to resolve
 *  the effective command without importing the whole registry (avoids
 *  import cycles). */
export interface InstallSpecLike {
  label?: string;
  install: {
    method: string;
    command: string;
    commandByOs?: Partial<Record<OsKey, string>>;
    label: string;
    docs: string;
    oneClick: boolean;
    systemKey?: string;
  };
}

/** Resolve the effective install command for an entry on THIS machine:
 *  per-OS variant → system-tier package-manager command → default.
 *  Shared by the scan route (what the UI shows) and startInstall (what the
 *  button runs), so they can never disagree. */
export function resolveInstallSpec(
  entry: InstallSpecLike | null | undefined,
): {
  command: string;
  label: string;
  oneClick: boolean;
  error?: string;
} {
  if (!entry) return { command: "", label: "", oneClick: false };
  const spec = entry.install;
  const os = osKey();
  const command = spec.commandByOs?.[os] ?? spec.command;
  const label = spec.label;

  if (spec.method === "system") {
    const resolved = spec.systemKey ? resolveSystemInstall(spec.systemKey) : null;
    if (!resolved) {
      const pmHint = getPlatformInfo().packageManagers.filter((p) => p.available);
      return {
        command: "",
        label,
        oneClick: false,
        error:
          `No supported package manager detected for ${entry.label ?? "this dependency"}. ` +
          (pmHint.length
            ? `Available here: ${pmHint.map((p) => p.label).join(", ")} — none of them provides it. `
            : "") +
          `Install manually: ${spec.docs}`,
      };
    }
    return {
      command: resolved.command,
      label: `${spec.label} via ${resolved.viaLabel}`,
      oneClick: true,
    };
  }

  if (!spec.oneClick || !command) {
    return {
      command,
      label,
      oneClick: false,
      error: `"${entry.label ?? "Tool"}" cannot be installed from here — see ${spec.docs} (${label}).`,
    };
  }
  return { command, label, oneClick: spec.oneClick };
}
