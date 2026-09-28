// Cluster environment probe — ONE serialized exec per stage, and every stage
// degrades individually: a failing stage fills its own null/empty bucket and
// never throws the whole probe. Stage 1 (login shell identity) is the only
// load-bearing one — it decides probe.ok.
//
// Stage 7 (tool availability) batches ~5 registry checks per exec so probing
// all 10 external tools costs 2 round trips instead of 10.

import { TOOL_REGISTRY } from "../tool-registry";
import { exec, shQuote, expandTilde } from "./ssh";
import type {
  ClusterConnection,
  ClusterPartition,
  ClusterProbe,
  ClusterToolProbe,
} from "./types";

const STAGE_TIMEOUT_MS = 25_000;

export async function probeCluster(c: ClusterConnection): Promise<ClusterProbe> {
  const startedAt = Date.now();
  const probe: ClusterProbe = {
    ok: false,
    testedAt: new Date().toISOString(),
    durationMs: 0,
    uname: "",
    hostname: "",
    user: "",
    homeDir: "",
    dateEpoch: 0,
    python3: null,
    conda: null,
    moduleSystem: "none",
    tools: [],
    slurm: { available: false, partitions: [] },
    gpus: [],
  };
  let probeError: string | undefined;

  // ── Stage 1: login shell identity (the gate). ────────────────────────────
  const s1 = await exec(
    c,
    `echo "$USER@$(hostname)"; echo "FL_HOME=$HOME"; uname -a; date +%s`,
    { timeoutMs: STAGE_TIMEOUT_MS },
  );
  const lines1 = s1.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (s1.error) {
    probeError = `SSH connection failed: ${s1.error}`;
  } else if (lines1.length < 3) {
    probeError = `unexpected login shell output (${lines1.length} lines)`;
  } else {
    const idLine = lines1[0];
    const at = idLine.indexOf("@");
    probe.user = at > 0 ? idLine.slice(0, at) : c.username;
    probe.hostname = at >= 0 && at < idLine.length - 1 ? idLine.slice(at + 1) : c.host;
    const homeIdx = lines1.findIndex((l) => l.startsWith("FL_HOME="));
    probe.homeDir = homeIdx >= 0 ? lines1[homeIdx].slice("FL_HOME=".length) : "";
    // date +%s is the last command — the last purely numeric line.
    const dateLine = [...lines1].reverse().find((l) => /^\d+$/.test(l));
    probe.dateEpoch = dateLine ? parseInt(dateLine, 10) : 0;
    if (homeIdx >= 0 && homeIdx + 1 < lines1.length && !/^\d+$/.test(lines1[homeIdx + 1])) {
      probe.uname = lines1[homeIdx + 1];
    }
    probe.ok = probe.user.length > 0 && probe.dateEpoch > 0;
    if (!probe.ok) probeError = "could not parse login shell identity";
  }

  // SSH is dead → the remaining stages would all time out; skip them.
  if (!s1.error) {
    // ── Stage 2: python3 + numpy. ──────────────────────────────────────────
    const s2 = await exec(
      c,
      `python3 --version 2>&1; python3 -c "import numpy; print('NUMPY_OK')" 2>/dev/null && echo NPY=yes || echo NPY=no`,
      { timeoutMs: STAGE_TIMEOUT_MS },
    );
    if (!s2.error) {
      const m = /Python\s+(\S+)/.exec(s2.stdout);
      probe.python3 = {
        ok: !!m,
        version: m ? m[1] : "",
        numpy: s2.stdout.includes("NPY=yes"),
      };
    }

    // ── Stage 3: conda. ────────────────────────────────────────────────────
    const s3 = await exec(
      c,
      `command -v conda >/dev/null 2>&1 && echo CONDA=yes || echo CONDA=no; conda info --base 2>/dev/null`,
      { timeoutMs: STAGE_TIMEOUT_MS },
    );
    if (!s3.error) {
      const base = s3.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("CONDA="));
      probe.conda = { ok: s3.stdout.includes("CONDA=yes"), root: base ?? "" };
    }

    // ── Stage 4: module system (lmod vs envmodules). ───────────────────────
    const s4 = await exec(
      c,
      `type module >/dev/null 2>&1 && echo MOD=yes || echo MOD=no; module --version 2>&1 | head -1`,
      { timeoutMs: STAGE_TIMEOUT_MS },
    );
    if (!s4.error && s4.stdout.includes("MOD=yes")) {
      const vline = (s4.stdout + "\n" + s4.stderr)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && /modules|lua|version/i.test(l) && !l.startsWith("MOD="));
      probe.moduleSystem = vline && /lua|lmod/i.test(vline) ? "lmod" : "envmodules";
    }

    // ── Stage 5: SLURM + partitions. ───────────────────────────────────────
    const s5 = await exec(
      c,
      `command -v sbatch >/dev/null 2>&1 && command -v squeue >/dev/null 2>&1 && echo SLURM=yes || echo SLURM=no; sinfo -h -o '%P|%D|%G|%T|%l' 2>/dev/null`,
      { timeoutMs: STAGE_TIMEOUT_MS },
    );
    if (!s5.error) {
      probe.slurm.available = s5.stdout.includes("SLURM=yes");
      const parts: ClusterPartition[] = [];
      for (const line of s5.stdout.split("\n")) {
        const t = line.trim();
        if (!t.includes("|") || t.startsWith("SLURM=")) continue;
        const [name, nodes, gres, state, maxTime] = t.split("|");
        // gres "gpu:A100:2(S)" (or the shorthand "gpu:2") → gpusPerNode.
        const gpuMatch = /gpu(?::[^:]*)?:(\d+)/i.exec((gres ?? "").trim());
        parts.push({
          name: (name ?? "").trim(),
          nodes: parseInt(nodes ?? "0", 10) || 0,
          gpusPerNode: gpuMatch ? parseInt(gpuMatch[1], 10) || 0 : 0,
          state: (state ?? "").trim(),
          maxTime: (maxTime ?? "").trim(),
        });
      }
      probe.slurm.partitions = parts.filter((p) => p.name.length > 0).slice(0, 24);
    }

    // ── Stage 6: GPUs (best-effort; grouped by model). ──────────────────────
    const s6 = await exec(
      c,
      `nvidia-smi --query-gpu=count,name --format=csv,noheader 2>/dev/null | head -8`,
      { timeoutMs: 15_000 },
    );
    let gpuNames = parseGpuNames(s6.error ? "" : s6.stdout);
    if (gpuNames.length === 0) {
      // Most drivers reject the 'count' query field — retry with name only
      // (one CSV line per GPU) so the model still surfaces.
      const s6b = await exec(
        c,
        `nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -8`,
        { timeoutMs: 15_000 },
      );
      gpuNames = parseGpuNames(s6b.error ? "" : s6b.stdout);
    }
    const byModel = new Map<string, number>();
    for (const name of gpuNames) byModel.set(name, (byModel.get(name) ?? 0) + 1);
    probe.gpus = [...byModel.entries()].map(([model, count]) => ({ model, count }));

    // ── Stage 7: external tool availability (batched ~5 checks per exec). ──
    probe.tools = await probeTools(c, probe.homeDir);
  }

  probe.durationMs = Date.now() - startedAt;
  if (probeError) probe.error = probeError;
  return probe;
}

function parseGpuNames(stdout: string): string[] {
  const names: string[] = [];
  for (const raw of stdout.split("\n")) {
    const l = raw.trim();
    if (!l || /^NVIDIA-SMII?$/i.test(l)) continue;
    // `--query-gpu=count,name` rows look like "2, NVIDIA A100-…": expand to
    // N copies of the model so the per-model aggregation below counts right.
    const csv = /^(\d+)\s*,\s*(.+)$/.exec(l);
    if (csv) {
      const n = Math.min(16, Math.max(1, parseInt(csv[1], 10) || 1));
      for (let i = 0; i < n; i++) names.push(csv[2].trim());
    } else {
      names.push(l);
    }
  }
  return names;
}

interface ToolCheck {
  key: string;
  label: string;
  via: string;
  cmd: string;
}

/** Batched registry checks. `remoteToolsDir` is expanded to an absolute path
 *  (quoting would defeat `~` expansion). */
async function probeTools(c: ClusterConnection, homeDir: string): Promise<ClusterToolProbe[]> {
  const remoteToolsDir = expandTilde(c.remoteToolsDir.trim(), homeDir);
  const checks: ToolCheck[] = [];

  for (const entry of TOOL_REGISTRY) {
    if (entry.detect.clusterCheck) {
      // Module-provided tools (AlphaFold2) only exist after `module load` —
      // the check runs inside a login shell so the module function is
      // defined, exactly like a user typing the tutorial commands.
      checks.push({
        key: entry.key,
        label: entry.label,
        via: "module",
        cmd:
          `bash -lc ${shQuote(`${entry.detect.clusterCheck} && ` +
            `echo "TOOL:${entry.key}:yes:module" || echo "TOOL:${entry.key}:no:module"`)} `,
      });
    } else if (entry.detect.type === "binary" && entry.detect.binary) {
      checks.push({
        key: entry.key,
        label: entry.label,
        via: "command",
        cmd:
          `command -v ${entry.detect.binary} >/dev/null 2>&1 && ` +
          `echo "TOOL:${entry.key}:yes:${entry.detect.binary}" || echo "TOOL:${entry.key}:no:PATH"`,
      });
    } else if (entry.detect.type === "python" && entry.detect.pythonModule) {
      checks.push({
        key: entry.key,
        label: entry.label,
        via: "module",
        cmd:
          `python3 -c "import ${entry.detect.pythonModule}" >/dev/null 2>&1 && ` +
          `echo "TOOL:${entry.key}:yes:${entry.detect.pythonModule}" || echo "TOOL:${entry.key}:no:module"`,
      });
    } else if (entry.detect.type === "path" && entry.detect.path) {
      const name = entry.detect.path.replace(/^external-tools\//, "");
      checks.push({
        key: entry.key,
        label: entry.label,
        via: "dir",
        cmd:
          `[ -d ${shQuote(`${remoteToolsDir}/${name}`)} ] && ` +
          `echo "TOOL:${entry.key}:yes:dir" || echo "TOOL:${entry.key}:no:dir"`,
      });
    }
  }

  const tools: ClusterToolProbe[] = [];
  for (let i = 0; i < checks.length; i += 5) {
    const batch = checks.slice(i, i + 5);
    const res = await exec(c, batch.map((b) => b.cmd).join("\n"), { timeoutMs: 30_000 });
    if (res.error) continue;
    const viaByKey = new Map(batch.map((b) => [b.key, b.via] as const));
    const labelByKey = new Map(batch.map((b) => [b.key, b.label] as const));
    for (const line of res.stdout.split("\n")) {
      const m = /^TOOL:([A-Za-z0-9_-]+):(yes|no):(.*)$/.exec(line.trim());
      if (!m) continue;
      tools.push({
        key: m[1],
        label: labelByKey.get(m[1]) ?? m[1],
        installed: m[2] === "yes",
        via: viaByKey.get(m[1]) ?? "command",
        detail: m[3],
      });
    }
  }
  return tools;
}
