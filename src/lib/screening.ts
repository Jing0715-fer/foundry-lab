// Screening (large-scale result evaluation & ranking) — server-only library.
//
// A Screening campaign = harvested set of design candidates (PDB/FASTA
// artifacts + numeric metrics) from completed workflow nodes, tool jobs, or
// REAL demo engine runs (scripts/algorithms/*.py — genuine algorithms, never
// simulated). This module:
//   1. harvests candidates from file lists (node ##OUTPUTS## trailers, ToolJob
//      outputFiles, demo engine runs),
//   2. maps raw engine metrics onto a canonical metric registry (plddt, ptm,
//      recovery, diversity, helix/strand %, clashes, rama_ll, symmetry_units
//      + auto-derived defs for unknown numeric keys),
//   3. serves DTOs with counts + freshly recomputed metric domains,
//   4. promotes picked candidates onto the workflow canvas as an "input" node
//      whose logs carry a ##OUTPUTS## trailer the workflow engine can parse
//      (autoWireToolInputs auto-wires pdb_path/fasta_path downstream).
//
// All candidate pdbPath/fastaPath live under <cwd>/outputs/ so
// /api/tools/file?path=<abs> can serve them.

import { execSync, spawn } from "child_process";
import { existsSync, promises as fsp } from "fs";
import { basename, dirname, extname, join, resolve, sep } from "path";
import { db } from "./db";
import { toNodeDTO } from "./workflow-engine";
import type {
  NodeDTO,
  PromoteResultDTO,
  ScreeningCandidateDTO,
  ScreeningCandidateStatus,
  ScreeningDTO,
  ScreeningMetricDef,
} from "./types";

// ── Paths / engine runtime ───────────────────────────────────────────────────

const CWD = process.cwd();
const OUTPUTS_ROOT = resolve(CWD, "outputs");
const SCREENING_ROOT = join(OUTPUTS_ROOT, "screening");
const ALGORITHMS_DIR = resolve(CWD, "scripts", "algorithms");
const ENGINE_TIMEOUT_MS = 120_000;

/** python3 candidates probed with `import numpy` (engine runtime requirement). */
const PYTHON_CANDIDATES = ["python3", "/home/z/.venv/bin/python3", "/usr/bin/python3"];
let cachedPython: string | null | undefined;

function resolveEnginePython(): string | null {
  if (cachedPython !== undefined) return cachedPython;
  for (const cand of PYTHON_CANDIDATES) {
    try {
      execSync(`${cand} -c "import numpy" 2>/dev/null`, { stdio: "pipe" });
      cachedPython = cand;
      return cand;
    } catch {
      /* try next */
    }
  }
  cachedPython = null;
  return null;
}

/** Invalidate the resolved-python cache (called after a runtime install
 * job completes so the next scan picks up the new interpreter). */
export function invalidateScreeningPython(): void {
  cachedPython = undefined;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Typed error carrying the HTTP status the route should respond with. */
export class ScreeningError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ScreeningError";
    this.status = status;
  }
}

/** Map any thrown value to a 4xx/5xx status (ScreeningError-aware). */
export function screeningErrorStatus(err: unknown): number {
  if (err instanceof ScreeningError) return err.status;
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" && s >= 400 && s < 600 ? s : 500;
}

// ── Canonical metric registry ────────────────────────────────────────────────

type MetricDefSeed = Omit<ScreeningMetricDef, "domain">;

const METRIC_REGISTRY: Record<string, MetricDefSeed> = {
  plddt: {
    key: "plddt",
    label: "pLDDT",
    higherIsBetter: true,
    good: 80,
    warn: 60,
    hint: "Predicted lDDT (per-residue confidence, 0-100)",
  },
  ptm: { key: "ptm", label: "pTM", higherIsBetter: true, good: 0.7, warn: 0.5 },
  recovery: { key: "recovery", label: "Recovery", higherIsBetter: true, good: 0.35, warn: 0.25 },
  diversity: { key: "diversity", label: "Diversity", higherIsBetter: true, good: 0.6, warn: 0.4 },
  helix_pct: {
    key: "helix_pct",
    label: "Helix %",
    unit: "%",
    higherIsBetter: true,
    good: 30,
    warn: 15,
  },
  strand_pct: {
    key: "strand_pct",
    label: "Strand %",
    unit: "%",
    higherIsBetter: true,
    good: 15,
    warn: 5,
  },
  clashes: {
    key: "clashes",
    label: "Clashes",
    higherIsBetter: false,
    good: 2,
    warn: 8,
    hint: "Steric clashes (lower is better)",
  },
  rama_ll: {
    key: "rama_ll",
    label: "Rama LL",
    higherIsBetter: true,
    hint: "Ramachandran log-likelihood",
  },
  symmetry_units: { key: "symmetry_units", label: "Sym Units", higherIsBetter: true },
  // Antibody-engine metrics (RFantibody fallback engine: germline Fv design).
  h3_len: {
    key: "h3_len",
    label: "CDR H3 Length",
    higherIsBetter: false,
    hint: "IMGT H3 loop length — shorter loops are typically more developable",
  },
  energy_kt: {
    key: "energy_kt",
    label: "Design Energy (kT)",
    higherIsBetter: false,
    hint: "Knowledge-based energy of the full Fv (lower is better)",
  },
  interface_sasa: {
    key: "interface_sasa",
    label: "VH/VL Interface (Å²)",
    higherIsBetter: true,
    hint: "Buried SASA across the VH/VL interface — more burial = more stable pairing",
  },
};

/** Stable display order: registry keys first, then auto keys alphabetically. */
const REGISTRY_ORDER = [
  "plddt",
  "ptm",
  "recovery",
  "diversity",
  "helix_pct",
  "strand_pct",
  "clashes",
  "rama_ll",
  "symmetry_units",
  "h3_len",
  "energy_kt",
  "interface_sasa",
];

/** Primary metrics default to weight 2; every other observed metric → 1. */
const PRIMARY_METRICS = ["plddt", "recovery", "rama_ll", "clashes"];

/** Raw engine metrics.json key → canonical metric key. */
const RAW_KEY_MAP: Record<string, string> = {
  plddt: "plddt",
  plddt_style_confidence: "plddt",
  ptm: "ptm",
  ptm_proxy: "ptm",
  recovery: "recovery",
  mean_recovery: "recovery",
  diversity: "diversity",
  clashes: "clashes",
  rama_ll: "rama_ll",
  symmetry_units: "symmetry_units",
};

/** Run-level metadata never copied into candidate metrics. */
const RUN_META_SKIP = new Set([
  "seed",
  "symmetry",
  "length",
  "recycles",
  "method",
  "mode",
  "temperature",
  "num_seq",
  "scorefn",
  "design",
]);

const LOWER_IS_BETTER_RE = /(clash|energy|rmsd|penalt|frustrat|ddg)/i;

function prettifyKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function autoMetricDef(key: string): MetricDefSeed {
  return {
    key,
    label: prettifyKey(key),
    higherIsBetter: !LOWER_IS_BETTER_RE.test(key),
  };
}

/** Domain rounding: ints for integer-valued metrics, else 3 significant digits. */
function roundDomainValue(v: number, allInteger: boolean): number {
  if (allInteger) return Math.round(v);
  const r = Number(v.toPrecision(3));
  return Object.is(r, -0) ? 0 : r;
}

function computeMetricDefs(metricValues: Record<string, number>[]): ScreeningMetricDef[] {
  const keys = new Set<string>();
  for (const m of metricValues) {
    for (const k of Object.keys(m)) keys.add(k);
  }
  const ordered = [
    ...REGISTRY_ORDER.filter((k) => keys.has(k)),
    ...[...keys].filter((k) => !METRIC_REGISTRY[k]).sort(),
  ];
  return ordered.map((key) => {
    const values: number[] = [];
    for (const m of metricValues) {
      const v = m[key];
      if (typeof v === "number" && Number.isFinite(v)) values.push(v);
    }
    let domain: [number, number] = [0, 0];
    if (values.length > 0) {
      const allInt = values.every((v) => Number.isInteger(v));
      domain = [
        roundDomainValue(Math.min(...values), allInt),
        roundDomainValue(Math.max(...values), allInt),
      ];
    }
    const seed = METRIC_REGISTRY[key] ?? autoMetricDef(key);
    return { ...seed, key, domain };
  });
}

function defaultWeightFor(key: string): number {
  return PRIMARY_METRICS.includes(key) ? 2 : 1;
}

// ── JSON / misc helpers ──────────────────────────────────────────────────────

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseJsonArray(raw: string | null | undefined): string[] {
  const v = parseJson<unknown>(raw, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function isoOrNull(v: Date | string | null): string | null {
  return v == null ? null : iso(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** ##OUTPUTS## trailer parser — MUST match workflow-engine.ts parseOutputsTrailer. */
function parseOutputsTrailer(logs: string): string[] {
  const m = logs.match(/##OUTPUTS## (\[[\s\S]*?\])/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Natural (human) ordering: design_2 before design_10. */
function naturalCompare(a: string, b: string): number {
  const ax: (string | number)[] = [];
  const bx: (string | number)[] = [];
  a.replace(/(\d+)|(\D+)/g, (_s, d: string, t: string) => {
    ax.push(d ? Number(d) : t);
    return "";
  });
  b.replace(/(\d+)|(\D+)/g, (_s, d: string, t: string) => {
    bx.push(d ? Number(d) : t);
    return "";
  });
  const n = Math.max(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i];
    const y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else {
      const c = String(x).localeCompare(String(y));
      if (c !== 0) return c;
    }
  }
  return 0;
}

async function readJsonIfExists(p: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await fsp.readFile(p, "utf-8");
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** FASTA text → bare sequence (headers stripped, lines joined). */
function parseFastaText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith(">"))
    .join("")
    .trim();
}

/**
 * Cheap structural parse of a PDB text (no deps): unique CA residues
 * (residue = chain char + resSeq), unique chains, ATOM line count.
 */
async function parsePdbStats(p: string): Promise<{
  residues: number;
  chains: number;
  atoms: number;
}> {
  let text: string;
  try {
    text = await fsp.readFile(p, "utf-8");
  } catch {
    return { residues: 0, chains: 0, atoms: 0 };
  }
  const resKeys = new Set<string>();
  const chainSet = new Set<string>();
  let atoms = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("ATOM")) continue;
    atoms++;
    const chain = line[21] ?? "";
    const resSeq = parseInt(line.slice(22, 26), 10);
    if (chain) chainSet.add(chain);
    if (line.slice(12, 16).trim() === "CA" && Number.isFinite(resSeq)) {
      resKeys.add(`${chain}:${resSeq}`);
    }
  }
  return { residues: resKeys.size, chains: chainSet.size, atoms };
}

// ── Row shapes (structural — Prisma row or include projection) ───────────────

interface ScreeningRow {
  id: string;
  name: string;
  description: string | null;
  sourceType: string;
  sourceRef: string | null;
  sourceLabel: string | null;
  weights: string;
  metricDefs: string;
  status: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface CandidateRow {
  id: string;
  screeningId: string;
  name: string;
  source: string;
  sourceLabel: string | null;
  pdbPath: string | null;
  fastaPath: string | null;
  sequence: string | null;
  length: number | null;
  metrics: string;
  starred: boolean;
  status: string;
  tags: string | null;
  notes: string | null;
  fileCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

/** Candidate projection needed for screening counts + domain recomputation. */
interface CandidateLite {
  metrics: string;
  starred: boolean;
  status: string;
}

// ── DTO mapping ──────────────────────────────────────────────────────────────

function toCandidateDTO(c: CandidateRow): ScreeningCandidateDTO {
  return {
    id: c.id,
    screeningId: c.screeningId,
    name: c.name,
    source: c.source,
    sourceLabel: c.sourceLabel,
    pdbPath: c.pdbPath,
    fastaPath: c.fastaPath,
    sequence: c.sequence,
    length: c.length,
    metrics: parseJson<Record<string, number>>(c.metrics, {}),
    starred: c.starred,
    status: c.status as ScreeningCandidateStatus,
    tags: parseJson<string[]>(c.tags, []),
    notes: c.notes,
    fileCount: c.fileCount,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

/** Serialize a screening row + its candidates → DTO (domains recomputed NOW). */
function toScreeningDTO(row: ScreeningRow, candidates: CandidateLite[]): ScreeningDTO {
  const metricValues = candidates.map((c) => parseJson<Record<string, number>>(c.metrics, {}));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    sourceLabel: row.sourceLabel,
    weights: parseJson<Record<string, number>>(row.weights, {}),
    metricDefs: computeMetricDefs(metricValues),
    status: row.status,
    candidateCount: candidates.length,
    starredCount: candidates.filter((c) => c.starred).length,
    shortlistedCount: candidates.filter((c) => c.status === "shortlisted").length,
    rejectedCount: candidates.filter((c) => c.status === "rejected").length,
    promotedCount: candidates.filter((c) => c.status === "promoted").length,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function sortCandidates(rows: CandidateRow[]): CandidateRow[] {
  return [...rows].sort((a, b) => naturalCompare(a.name, b.name));
}

// ── Harvester ────────────────────────────────────────────────────────────────

interface HarvestOptions {
  /** Explicit run-label derivation from a directory (demo run dirs). */
  runLabelOf?: (dir: string) => string | undefined;
}

interface HarvestedCandidate {
  name: string;
  sourceLabel: string | null;
  pdbPath: string | null;
  fastaPath: string | null;
  sequence: string | null;
  length: number | null;
  metrics: Record<string, number>;
  fileCount: number;
}

/**
 * Copy a file that lives OUTSIDE <cwd>/outputs/ into
 * outputs/screening/<screeningId>/ (keeps basename; prefixes an index on
 * collision; reuses an identical-size copy so rescans stay idempotent).
 */
async function copyIntoScreeningDir(stagingDir: string, src: string): Promise<string> {
  await fsp.mkdir(stagingDir, { recursive: true }).catch(() => {});
  const dest = join(stagingDir, basename(src));
  if (!existsSync(dest)) {
    await fsp.copyFile(src, dest).catch(() => {});
    return existsSync(dest) ? dest : src;
  }
  try {
    const [s1, s2] = await Promise.all([fsp.stat(src), fsp.stat(dest)]);
    if (s1.size === s2.size) return dest; // same file copied on an earlier harvest
  } catch {
    /* fall through to index prefix */
  }
  for (let i = 1; i < 1000; i++) {
    const alt = join(stagingDir, `${i}_${basename(src)}`);
    if (!existsSync(alt)) {
      await fsp.copyFile(src, alt).catch(() => {});
      return existsSync(alt) ? alt : src;
    }
  }
  return src;
}

/** Sort run dirs by mtime (then path) for stable runN assignment. */
async function sortDirsByMtime(dirs: string[]): Promise<string[]> {
  const stamped = await Promise.all(
    dirs.map(async (d) => {
      const st = await fsp.stat(d).catch(() => null);
      return { d, mtime: st ? st.mtimeMs : 0 };
    }),
  );
  return stamped.sort((a, b) => a.mtime - b.mtime || (a.d < b.d ? -1 : 1)).map((x) => x.d);
}

/**
 * Stable run-label resolution:
 *   1. dirs already carrying candidates keep their existing label,
 *   2. else an explicit runLabelOf (demo run dirs),
 *   3. else the next free run<N> (N continues past the highest existing one).
 */
async function resolveRunLabels(
  screeningId: string,
  dirs: string[],
  runLabelOf?: (dir: string) => string | undefined,
): Promise<Map<string, string>> {
  const existing = await db.screeningCandidate.findMany({
    where: { screeningId },
    select: { name: true, pdbPath: true, fastaPath: true },
  });
  const dirToLabel = new Map<string, string>();
  let maxRun = 0;
  for (const c of existing) {
    const m = /^run(\d+)\//.exec(c.name);
    if (m) maxRun = Math.max(maxRun, parseInt(m[1], 10));
    const p = c.pdbPath ?? c.fastaPath;
    if (p) {
      const d = dirname(resolve(p));
      if (!dirToLabel.has(d)) dirToLabel.set(d, c.name.split("/")[0]);
    }
  }
  const labels = new Map<string, string>();
  let next = maxRun + 1;
  for (const d of await sortDirsByMtime(dirs)) {
    const label = dirToLabel.get(d) ?? runLabelOf?.(d) ?? `run${next++}`;
    labels.set(d, label);
  }
  return labels;
}

/**
 * Apply a run's metrics.json / ranking_debug.json onto one PDB candidate.
 * Returns the design length when the metrics carry it (else null).
 */
function applyRunMetrics(
  metrics: Record<string, number>,
  stem: string,
  runJson: Record<string, unknown> | null,
  ranking: { plddts?: number[]; order?: number[] } | null,
): number | null {
  let length: number | null = null;

  // 1) Diffusion / antibody engines: designs[] array — design_N.pdb (and
  //    antibody fv_design_N.pdb) → entry design === N+1, else designs[N].
  const designs =
    runJson && Array.isArray(runJson.designs) ? (runJson.designs as Record<string, unknown>[]) : null;
  if (designs) {
    const m = /design[_-]?(\d+)$/i.exec(stem);
    if (m) {
      const idx = parseInt(m[1], 10);
      const entry =
        designs.find((d) => numOrNull(d.design) === idx + 1) ?? designs[idx];
      if (entry) {
        // Antibody engine entries carry vh_len/vl_len (two-chain Fv).
        const vhLen = numOrNull(entry.vh_len);
        const vlLen = numOrNull(entry.vl_len);
        if (vhLen != null && vlLen != null) {
          length = vhLen + vlLen;
          const h3Len = numOrNull(entry.h3_len);
          if (h3Len != null) metrics.h3_len = h3Len;
          const energy = numOrNull(entry.energy_kT);
          if (energy != null) metrics.energy_kt = energy;
          const ifaceSasa = numOrNull(entry.vl_vh_buried_sasa);
          if (ifaceSasa != null) metrics.interface_sasa = ifaceSasa;
        } else {
          length = numOrNull(entry.length);
        }
        const helical = numOrNull(entry.helical);
        const extended = numOrNull(entry.extended);
        if (length && helical != null) {
          metrics.helix_pct = Math.round((helical / length) * 1000) / 10;
        }
        if (length && extended != null) {
          metrics.strand_pct = Math.round((extended / length) * 1000) / 10;
        }
        for (const k of ["clashes", "rama_ll", "symmetry_units"] as const) {
          const v = numOrNull(entry[k]);
          if (v != null) metrics[k] = v;
        }
      }
    }
  }

  // 2) Top-level known raw keys (fold engine: plddt_style_confidence/ptm_proxy,
  //    mpnn: mean_recovery/diversity, score engine: clashes…).
  if (runJson) {
    for (const [raw, canon] of Object.entries(RAW_KEY_MAP)) {
      if (!(raw in runJson)) continue;
      const v = numOrNull(runJson[raw]);
      if (v != null && metrics[canon] === undefined) metrics[canon] = v;
    }
    // 3) Other numeric keys → auto-derived metrics (score_engine total/rama…).
    for (const [k, v] of Object.entries(runJson)) {
      if (RUN_META_SKIP.has(k) || rawInMap(k)) continue;
      const n = numOrNull(v);
      if (n != null && metrics[k] === undefined) metrics[k] = n;
    }
  }

  // 4) AlphaFold cluster runs: ranking_debug.json {plddts, order?} for ranked_N.pdb.
  if (ranking?.plddts?.length) {
    const m = /^ranked[_-]?(\d+)$/i.exec(stem);
    if (m) {
      const n = parseInt(m[1], 10);
      const order = Array.isArray(ranking.order) ? ranking.order : null;
      const modelIdx =
        order && typeof order[n] === "number" ? (order[n] as number) : n;
      const v = numOrNull(ranking.plddts[modelIdx]);
      if (v != null && metrics.plddt === undefined) metrics.plddt = v;
    }
  }
  return length;
}

function rawInMap(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(RAW_KEY_MAP, key);
}

/** Run detail shown as candidate sourceLabel (seed/symmetry or dir name). */
function buildRunDetail(runJson: Record<string, unknown> | null, dir: string): string {
  const seed = numOrNull(runJson?.seed);
  const symmetry = runJson?.symmetry;
  if (seed != null && typeof symmetry === "string") {
    return `seed ${seed} · symmetry ${symmetry || "none"}`;
  }
  return basename(dir);
}

/**
 * Harvest candidates from a list of files (node ##OUTPUTS## trailers, job
 * outputFiles, demo engine runs). Only existing files are kept; files outside
 * outputs/ are copied into outputs/screening/<id>/; remaining files are
 * grouped by parent directory ("run") and turned into candidates:
 *   - every *.pdb → one candidate (metrics from the run's metrics.json /
 *     ranking_debug.json; cheap structural PDB parse as fallback for length;
 *     paired <stem>.fasta/.fa → fastaPath + sequence),
 *   - *.fasta/*.fa without a same-basename sibling .pdb → sequence candidate.
 * Existing (screeningId, name) rows are NEVER duplicated — only new rows are
 * created. Returns the number of candidates added.
 */
async function harvestFromFiles(
  screeningId: string,
  files: string[],
  source: string,
  _sourceLabel: string | null,
  opts: HarvestOptions = {},
): Promise<number> {
  // 1. Keep only files that exist on disk (missing ones are skipped silently).
  const existingFiles: string[] = [];
  let missing = 0;
  for (const f of files) {
    if (typeof f !== "string" || !f.trim()) continue;
    try {
      if (existsSync(f)) existingFiles.push(resolve(f));
      else missing++;
    } catch {
      missing++;
    }
  }

  // 2. Files outside outputs/ → copy into outputs/screening/<id>/.
  const stagingDir = join(SCREENING_ROOT, screeningId);
  const placed: string[] = [];
  for (const f of existingFiles) {
    if (f.startsWith(OUTPUTS_ROOT + sep)) {
      placed.push(f);
    } else {
      placed.push(await copyIntoScreeningDir(stagingDir, f));
    }
  }

  // 3. Group by parent directory ("run").
  const byDir = new Map<string, string[]>();
  for (const f of placed) {
    const d = dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }

  // 4. Stable run labels.
  const labels = await resolveRunLabels(screeningId, [...byDir.keys()], opts.runLabelOf);

  // 5. Existing candidate names (rescan dedup).
  const existingRows = await db.screeningCandidate.findMany({
    where: { screeningId },
    select: { name: true },
  });
  const existingNames = new Set(existingRows.map((c) => c.name));

  // 6. Build candidate rows per run.
  const harvested: HarvestedCandidate[] = [];
  for (const [dir, runFiles] of byDir) {
    const label = labels.get(dir)!;
    const runJson = await readJsonIfExists(join(dir, "metrics.json"));
    const ranking = await readJsonIfExists(join(dir, "ranking_debug.json"));
    const rankingCasted = ranking as { plddts?: number[]; order?: number[] } | null;
    const runDetail = buildRunDetail(runJson, dir);

    // 6a. PDB candidates.
    const pdbFiles = runFiles.filter((f) => /\.pdb$/i.test(f));
    pdbFiles.sort((a, b) => naturalCompare(basename(a), basename(b)));
    for (const pdb of pdbFiles) {
      const stem = basename(pdb, extname(pdb));
      const name = `${label}/${stem}`;
      if (existingNames.has(name)) continue;
      const metrics: Record<string, number> = {};
      let length = applyRunMetrics(metrics, stem, runJson, rankingCasted);
      // Cheap structural fallback parse (fills length when unknown).
      const stats = await parsePdbStats(pdb);
      if (length == null && stats.residues > 0) length = stats.residues;
      // Paired FASTA (design_N.pdb ↔ design_N.fasta, model_s0.pdb ↔ model_s0.fasta).
      let fastaPath: string | null = null;
      let sequence: string | null = null;
      for (const ext of [".fasta", ".fa"]) {
        const p = join(dir, stem + ext);
        if (existsSync(p)) {
          fastaPath = p;
          sequence = parseFastaText(await fsp.readFile(p, "utf-8").catch(() => "")) || null;
          break;
        }
      }
      harvested.push({
        name,
        sourceLabel: runDetail,
        pdbPath: pdb,
        fastaPath,
        sequence,
        length,
        metrics,
        fileCount: 1 + (fastaPath ? 1 : 0),
      });
    }

    // 6b. Orphan FASTA candidates (no same-basename sibling .pdb).
    const fastaFiles = runFiles.filter((f) => /\.(fasta|fa)$/i.test(f));
    fastaFiles.sort((a, b) => naturalCompare(basename(a), basename(b)));
    for (const fa of fastaFiles) {
      const stem = basename(fa, extname(fa));
      if (existsSync(join(dir, stem + ".pdb"))) continue; // paired with a pdb candidate
      const name = `${label}/${stem}`;
      if (existingNames.has(name)) continue;
      const metrics: Record<string, number> = {};
      applyRunMetrics(metrics, stem, runJson, rankingCasted);
      const sequence = parseFastaText(await fsp.readFile(fa, "utf-8").catch(() => ""));
      harvested.push({
        name,
        sourceLabel: runDetail,
        pdbPath: null,
        fastaPath: fa,
        sequence: sequence || null,
        length: sequence ? sequence.length : null,
        metrics,
        fileCount: 1,
      });
    }
  }

  // 7. Persist new candidates (names are unique per screening by construction).
  if (harvested.length > 0) {
    await db.screeningCandidate.createMany({
      data: harvested.map((h) => ({
        screeningId,
        name: h.name,
        source,
        sourceLabel: h.sourceLabel,
        pdbPath: h.pdbPath,
        fastaPath: h.fastaPath,
        sequence: h.sequence,
        length: h.length,
        metrics: JSON.stringify(h.metrics),
        tags: "[]",
        fileCount: h.fileCount,
      })),
    });
  }
  void missing; // skipped-missing count (informational only)
  return harvested.length;
}

/** Refresh metricDefs + fill default weights for newly observed metric keys. */
async function refreshScreeningMetrics(id: string): Promise<void> {
  const row = await db.screening.findUnique({ where: { id } });
  if (!row) return;
  const candidates = await db.screeningCandidate.findMany({
    where: { screeningId: id },
    select: { metrics: true },
  });
  const metricValues = candidates.map((c) => parseJson<Record<string, number>>(c.metrics, {}));
  const defs = computeMetricDefs(metricValues);
  const weights = parseJson<Record<string, number>>(row.weights, {});
  for (const d of defs) {
    if (!(d.key in weights)) weights[d.key] = defaultWeightFor(d.key);
  }
  await db.screening.update({
    where: { id },
    data: { weights: JSON.stringify(weights), metricDefs: JSON.stringify(defs) },
  });
}

// ── Demo engine runs (REAL algorithms — no simulation) ──────────────────────

interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runEngineProcess(
  py: string,
  scriptPath: string,
  payload: string,
): Promise<ProcResult> {
  return new Promise((resolvePromise) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(py, [scriptPath, payload], { cwd: CWD, shell: false });
    } catch (e) {
      resolvePromise({
        stdout: "",
        stderr: `Failed to spawn ${py}: ${(e as Error).message}`,
        exitCode: 1,
      });
      return;
    }
    const out: string[] = [];
    const err: string[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      err.push(`\n[TIMEOUT after ${ENGINE_TIMEOUT_MS / 1000}s — killed]`);
    }, ENGINE_TIMEOUT_MS);
    proc.stdout?.on("data", (d) => out.push(d.toString()));
    proc.stderr?.on("data", (d) => err.push(d.toString()));
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: out.join(""),
        stderr: err.join(""),
        exitCode: code ?? 1,
      });
    };
    proc.on("error", (e) => {
      err.push(`Failed to spawn process: ${e.message}`);
      finish(1);
    });
    proc.on("close", (code) => finish(code));
  });
}

/**
 * Spawn a real built-in algorithm engine (same pattern as real-executor.ts:
 * `<python> <script> '<json payload>'` with { params, workdir }). The engine
 * prints a ##OUTPUTS## file list; non-zero exit or missing outputs →
 * descriptive ScreeningError(500).
 */
async function runRealEngine(
  script: string,
  params: Record<string, unknown>,
  workdir: string,
  label: string,
): Promise<string[]> {
  const py = resolveEnginePython();
  if (!py) {
    throw new ScreeningError(
      "python3 with numpy is not available — cannot run the real demo engine",
      500,
    );
  }
  await fsp.mkdir(workdir, { recursive: true }).catch(() => {});
  const payload = JSON.stringify({ params, workdir });
  const res = await runEngineProcess(py, join(ALGORITHMS_DIR, script), payload);
  const files = parseOutputsTrailer(res.stdout);
  const fail =
    res.exitCode !== 0 ||
    files.length === 0 ||
    files.some((f) => !existsSync(f));
  if (fail) {
    const tail = res.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
    throw new ScreeningError(
      `Demo engine run failed (${label}): exit ${res.exitCode}, ${files.length} output file(s)` +
        (tail ? ` — ${tail}` : ""),
      500,
    );
  }
  return files;
}

/** Large-scale scaffold campaign — REAL diffusion engine × 3 runs (~60 candidates). */
const SCAFFOLD_RUNS = [
  { seed: 42, symmetry: "none", length: 100, designs: 20 },
  { seed: 137, symmetry: "C3", length: 100, designs: 20 },
  { seed: 2024, symmetry: "D2", length: 90, designs: 20 },
] as const;

async function runScaffoldDemo(screeningId: string): Promise<string[]> {
  const files: string[] = [];
  for (let i = 0; i < SCAFFOLD_RUNS.length; i++) {
    const r = SCAFFOLD_RUNS[i];
    const workdir = join(SCREENING_ROOT, screeningId, "runs", `run${i + 1}`);
    const runFiles = await runRealEngine(
      "diffusion_engine.py",
      { seed: r.seed, symmetry: r.symmetry, total_length: r.length, num_designs: r.designs },
      workdir,
      `scaffold run ${i + 1} (seed ${r.seed}, symmetry ${r.symmetry}, ${r.length} aa × ${r.designs})`,
    );
    files.push(...runFiles);
  }
  return files;
}

/**
 * AF2-style model ranking — 4 realistic sequences × 5 seeds through the REAL
 * fold engine (Chou-Fasman + Ramachandran/NeRF). Engine outputs are renamed
 * predicted.pdb → model_s<N>.pdb / input.fasta → model_s<N>.fasta so the
 * harvester produces `seqX/model_s<N>` candidates with paired FASTA.
 */
const MODEL_SEQS: { name: string; seq: string }[] = [
  {
    name: "seqA",
    seq: "MKALELKQKAQELGKALKEQLAEKFAKGGSGSEELSKLKAELKAYGSGEQGAAALEKLAGGSGEAAAKLLAEHG",
  },
  {
    name: "seqB",
    seq: "MKTLLKFLKVQGELIKAQGRTLYDAAKGLLKEEKKLKQAEEFIKGNLNQKDSGTVSVKGDNLKEALEKFGKVSDEEEKEK",
  },
  {
    name: "seqC",
    seq: "MQYTWNNQETDVLKQAFDKHKGVLYSTSAKNQGSKLNVVEGAEVKGKLPGVDETKNVTGWGNQTVQDGLKEVKAG",
  },
  {
    name: "seqD",
    seq: "MKHLPEEMLKKLGEEIDLAQQKVPWLDRTGKGTVSGKVLPEFQKLKEKMDTSGKKGKVDWVKELPGKDNVKEILGQE",
  },
];
const MODEL_SEEDS = [0, 1, 2, 3, 4];

async function runModelsDemo(screeningId: string): Promise<string[]> {
  const files: string[] = [];
  for (const s of MODEL_SEQS) {
    for (const seed of MODEL_SEEDS) {
      const workdir = join(SCREENING_ROOT, screeningId, "runs", `${s.name}_s${seed}`);
      const runFiles = await runRealEngine(
        "fold_engine.py",
        { sequence: s.seq, seed, _tool: "alphafold" },
        workdir,
        `models run ${s.name} seed ${seed} (${s.seq.length} aa)`,
      );
      const pdb = join(workdir, "predicted.pdb");
      const fa = join(workdir, "input.fasta");
      const modelPdb = join(workdir, `model_s${seed}.pdb`);
      const modelFa = join(workdir, `model_s${seed}.fasta`);
      if (existsSync(pdb) && !existsSync(modelPdb)) await fsp.rename(pdb, modelPdb).catch(() => {});
      if (existsSync(fa) && !existsSync(modelFa)) await fsp.rename(fa, modelFa).catch(() => {});
      files.push(
        ...runFiles.map((f) => (f === pdb ? modelPdb : f === fa ? modelFa : f)),
      );
    }
  }
  return files;
}

/** Run dir → run label for demo harvests (deterministic across rescans). */
function demoHarvestOpts(demo: string | null): HarvestOptions {
  if (demo === "models") {
    return {
      runLabelOf: (dir) => {
        const m = /^(.+)_s\d+$/.exec(basename(dir));
        return m ? m[1] : undefined;
      },
    };
  }
  if (demo === "scaffold") {
    return {
      runLabelOf: (dir) => {
        const b = basename(dir);
        return /^run\d+$/.test(b) ? b : undefined;
      },
    };
  }
  return {};
}

/** Walk the demo dir (outputs/screening/<id>/) collecting artifact files. */
async function listDemoFiles(screeningId: string): Promise<string[]> {
  const base = join(SCREENING_ROOT, screeningId);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  const walk = async (dir: string) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(pdb|fasta|fa|json)$/i.test(e.name)) out.push(full);
    }
  };
  await walk(base);
  return out.sort();
}

// ── Public API ───────────────────────────────────────────────────────────────

export type ScreeningSourceInput =
  | { kind: "node"; nodeId: string }
  | { kind: "job"; jobId: string }
  | { kind: "demo"; demo: "scaffold" | "models" };

export interface CreateScreeningInput {
  source: ScreeningSourceInput;
  name?: string;
  description?: string;
}

export async function listScreenings(): Promise<ScreeningDTO[]> {
  const rows = await db.screening.findMany({
    orderBy: { createdAt: "desc" },
    include: { candidates: { select: { metrics: true, starred: true, status: true } } },
  });
  return rows.map((r) => toScreeningDTO(r, r.candidates));
}

export async function getScreeningDetail(
  id: string,
): Promise<{ screening: ScreeningDTO; candidates: ScreeningCandidateDTO[] } | null> {
  const row = await db.screening.findUnique({
    where: { id },
    include: { candidates: true },
  });
  if (!row) return null;
  const candidates = sortCandidates(row.candidates as CandidateRow[]);
  return { screening: toScreeningDTO(row, candidates), candidates: candidates.map(toCandidateDTO) };
}

export async function createScreening(input: CreateScreeningInput): Promise<ScreeningDTO> {
  const source = input.source;
  if (!source || typeof source !== "object") {
    throw new ScreeningError("source is required", 400);
  }

  let sourceType: "node" | "job" | "demo";
  let sourceRef: string | null = null;
  let sourceFamily: string;
  let sourceLabel: string | null;
  let defaultName: string;
  let files: string[] = [];
  let opts: HarvestOptions = {};

  if (source.kind === "node") {
    if (typeof source.nodeId !== "string" || !source.nodeId.trim()) {
      throw new ScreeningError("source.nodeId is required for node sources", 400);
    }
    const node = await db.node.findUnique({ where: { id: source.nodeId } });
    if (!node) throw new ScreeningError("Source node not found", 404);
    sourceType = "node";
    sourceRef = node.id;
    sourceFamily = node.type;
    sourceLabel = node.name;
    defaultName = node.name;
    files = parseOutputsTrailer(node.logs ?? "");
  } else if (source.kind === "job") {
    if (typeof source.jobId !== "string" || !source.jobId.trim()) {
      throw new ScreeningError("source.jobId is required for job sources", 400);
    }
    const job = await db.toolJob.findUnique({ where: { id: source.jobId } });
    if (!job) throw new ScreeningError("Source tool job not found", 404);
    sourceType = "job";
    sourceRef = job.id;
    sourceFamily = job.tool;
    sourceLabel = job.presetName ?? `${job.tool} run`;
    defaultName = `${job.tool} run`;
    files = parseJsonArray(job.outputFiles);
  } else if (source.kind === "demo") {
    if (source.demo !== "scaffold" && source.demo !== "models") {
      throw new ScreeningError('source.demo must be "scaffold" or "models"', 400);
    }
    sourceType = "demo";
    sourceRef = source.demo;
    sourceFamily = source.demo === "scaffold" ? "rfdiffusion" : "alphafold";
    sourceLabel =
      source.demo === "scaffold" ? "demo: scaffold campaign" : "demo: AF2 model ranking";
    defaultName = source.demo === "scaffold" ? "Scaffold Campaign" : "AF2 Model Ranking";
    opts = demoHarvestOpts(source.demo);
  } else {
    throw new ScreeningError(
      'source.kind must be "node", "job" or "demo"',
      400,
    );
  }

  const name = input.name?.trim() || defaultName;
  const description = input.description ?? null;

  const screening = await db.screening.create({
    data: {
      name,
      description,
      sourceType,
      sourceRef,
      sourceLabel,
      weights: "{}",
      metricDefs: "[]",
      status: "harvesting",
    },
  });

  try {
    if (sourceType === "demo" && sourceRef === "scaffold") {
      files = await runScaffoldDemo(screening.id);
    } else if (sourceType === "demo" && sourceRef === "models") {
      files = await runModelsDemo(screening.id);
    }
    await harvestFromFiles(screening.id, files, sourceFamily, sourceLabel, opts);
    await refreshScreeningMetrics(screening.id);
    const updated = await db.screening.update({
      where: { id: screening.id },
      data: { status: "ready" },
    });
    const candidates = await db.screeningCandidate.findMany({
      where: { screeningId: screening.id },
      select: { metrics: true, starred: true, status: true },
    });
    return toScreeningDTO(updated, candidates);
  } catch (err) {
    await db.screening
      .update({ where: { id: screening.id }, data: { status: "failed" } })
      .catch(() => {});
    throw err;
  }
}

export async function rescanScreening(
  id: string,
): Promise<{
  screening: ScreeningDTO;
  candidates: ScreeningCandidateDTO[];
  added: number;
} | null> {
  const row = await db.screening.findUnique({ where: { id } });
  if (!row) return null;

  let files: string[] = [];
  let sourceFamily = "manual";
  let opts: HarvestOptions = {};

  if (row.sourceType === "node" && row.sourceRef) {
    const node = await db.node.findUnique({ where: { id: row.sourceRef } });
    if (node) {
      files = parseOutputsTrailer(node.logs ?? "");
      sourceFamily = node.type;
    }
  } else if (row.sourceType === "job" && row.sourceRef) {
    const job = await db.toolJob.findUnique({ where: { id: row.sourceRef } });
    if (job) {
      files = parseJsonArray(job.outputFiles);
      sourceFamily = job.tool;
    }
  } else if (row.sourceType === "demo") {
    files = await listDemoFiles(id);
    sourceFamily = row.sourceRef === "scaffold" ? "rfdiffusion" : "alphafold";
    opts = demoHarvestOpts(row.sourceRef);
  }

  const added = await harvestFromFiles(id, files, sourceFamily, row.sourceLabel, opts);
  await refreshScreeningMetrics(id);

  const updated = await db.screening.findUniqueOrThrow({ where: { id } });
  const candidates = sortCandidates(
    (await db.screeningCandidate.findMany({ where: { screeningId: id } })) as CandidateRow[],
  );
  return {
    screening: toScreeningDTO(updated, candidates),
    candidates: candidates.map(toCandidateDTO),
    added,
  };
}

export async function patchScreening(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    weights?: Record<string, number>;
  },
): Promise<ScreeningDTO | null> {
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) {
      throw new ScreeningError("name must be a non-empty string", 400);
    }
    data.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    data.description = patch.description === null ? null : String(patch.description);
  }
  if (patch.weights !== undefined) {
    if (!patch.weights || typeof patch.weights !== "object" || Array.isArray(patch.weights)) {
      throw new ScreeningError("weights must be an object of metricKey → number (0–5)", 400);
    }
    const w: Record<string, number> = {};
    for (const [k, v] of Object.entries(patch.weights)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new ScreeningError(`weight for "${k}" must be a finite number (0–5)`, 400);
      }
      w[k] = Math.min(5, Math.max(0, v));
    }
    data.weights = JSON.stringify(w);
  }

  const existing = await db.screening.findUnique({ where: { id } });
  if (!existing) return null;
  const row = await db.screening.update({ where: { id }, data });
  const candidates = await db.screeningCandidate.findMany({
    where: { screeningId: id },
    select: { metrics: true, starred: true, status: true },
  });
  return toScreeningDTO(row, candidates);
}

export async function deleteScreening(id: string): Promise<void> {
  const existing = await db.screening.findUnique({ where: { id } });
  if (!existing) throw new ScreeningError("Screening not found", 404);
  await db.screening.delete({ where: { id } });
  // Best-effort cleanup of the campaign's harvested engine artifacts
  // (outputs/screening/<id>/ can reach hundreds of MB for demo runs).
  // Failure is logged and ignored — the DB row is already gone.
  try {
    await fsp.rm(join(SCREENING_ROOT, id), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `[screening] deleteScreening: failed to remove artifacts for ${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

const CANDIDATE_STATUSES: readonly string[] = [
  "new",
  "shortlisted",
  "rejected",
  "promoted",
];

function validateStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v)) {
    throw new ScreeningError(`${field} must be an array of strings`, 400);
  }
  return v.map(String);
}

export async function patchCandidates(
  id: string,
  ids: string[],
  patch: {
    starred?: boolean;
    status?: ScreeningCandidateStatus;
    addTags?: string[];
    removeTags?: string[];
    notes?: string | null;
  },
): Promise<{ updated: number; candidates: ScreeningCandidateDTO[] }> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== "string")) {
    throw new ScreeningError("ids must be a non-empty array of candidate ids", 400);
  }
  const uniqueIds = [...new Set(ids)];
  const screening = await db.screening.findUnique({ where: { id } });
  if (!screening) throw new ScreeningError("Screening not found", 404);

  const rows = await db.screeningCandidate.findMany({
    where: { screeningId: id, id: { in: uniqueIds } },
    select: { id: true },
  });
  if (rows.length !== uniqueIds.length) {
    throw new ScreeningError("All ids must belong to this screening", 400);
  }

  if (patch.status !== undefined && !CANDIDATE_STATUSES.includes(patch.status)) {
    throw new ScreeningError(
      `status must be one of ${CANDIDATE_STATUSES.join(" | ")}`,
      400,
    );
  }
  const addTags =
    patch.addTags !== undefined ? validateStringArray(patch.addTags, "patch.addTags") : [];
  const removeTags =
    patch.removeTags !== undefined
      ? validateStringArray(patch.removeTags, "patch.removeTags")
      : [];

  await db.$transaction(async (tx) => {
    if (patch.starred !== undefined) {
      if (typeof patch.starred !== "boolean") {
        throw new ScreeningError("patch.starred must be a boolean", 400);
      }
      await tx.screeningCandidate.updateMany({
        where: { id: { in: uniqueIds } },
        data: { starred: patch.starred },
      });
    }
    if (patch.status !== undefined) {
      await tx.screeningCandidate.updateMany({
        where: { id: { in: uniqueIds } },
        data: { status: patch.status },
      });
    }
    if (patch.notes !== undefined) {
      await tx.screeningCandidate.updateMany({
        where: { id: { in: uniqueIds } },
        data: { notes: patch.notes === null ? null : String(patch.notes) },
      });
    }
    if (addTags.length > 0 || removeTags.length > 0) {
      const current = await tx.screeningCandidate.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, tags: true },
      });
      for (const c of current) {
        const tags = new Set(parseJson<string[]>(c.tags, []));
        for (const t of addTags) tags.add(t);
        for (const t of removeTags) tags.delete(t);
        await tx.screeningCandidate.update({
          where: { id: c.id },
          data: { tags: JSON.stringify([...tags]) },
        });
      }
    }
  });

  const candidates = sortCandidates(
    (await db.screeningCandidate.findMany({ where: { screeningId: id } })) as CandidateRow[],
  );
  return { updated: uniqueIds.length, candidates: candidates.map(toCandidateDTO) };
}

// ── Promotion → canvas "input" node ──────────────────────────────────────────

function fmtMetricValue(v: number): string {
  return String(Math.round(v * 100) / 100);
}

export async function promoteCandidates(
  id: string,
  ids: string[],
  nodeName?: string,
  workflowId?: string,
): Promise<PromoteResultDTO> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== "string")) {
    throw new ScreeningError("ids must be a non-empty array of candidate ids", 400);
  }
  const uniqueIds = [...new Set(ids)];
  if (nodeName !== undefined && (typeof nodeName !== "string" || !nodeName.trim())) {
    throw new ScreeningError("nodeName must be a non-empty string", 400);
  }

  const screening = await db.screening.findUnique({ where: { id } });
  if (!screening) throw new ScreeningError("Screening not found", 404);
  const picked = await db.screeningCandidate.findMany({
    where: { screeningId: id, id: { in: uniqueIds } },
  });
  if (picked.length !== uniqueIds.length) {
    throw new ScreeningError("All ids must belong to this screening", 400);
  }
  const byId = new Map(picked.map((c) => [c.id, c as CandidateRow]));
  const ordered = uniqueIds
    .map((cid) => byId.get(cid))
    .filter((c): c is CandidateRow => c !== undefined);

  // Collect existing files: fastaPath first (preferred for AF2/MPNN chaining),
  // then pdbPath, in candidate order. Limit 20 files.
  const files: string[] = [];
  for (const c of ordered) {
    for (const p of [c.fastaPath, c.pdbPath]) {
      if (files.length >= 20) break;
      if (!p || !existsSync(p)) continue;
      if (!files.includes(p)) files.push(p);
    }
    if (files.length >= 20) break;
  }

  // Placement: max node x + 340, y 60 (fallback 120/80). Target workflow =
  // the client-specified workflowId (validated) so promoted nodes land on
  // the workflow the user is actually looking at; fallback = first workflow
  // (multi-workflow apps would otherwise scatter "phantom" nodes).
  const wf =
    typeof workflowId === "string" && workflowId
      ? await db.workflow.findUnique({
          where: { id: workflowId },
          include: { nodes: true },
        })
      : await db.workflow.findFirst({
          orderBy: { createdAt: "asc" },
          include: { nodes: true },
        });
  if (workflowId && !wf) {
    throw new ScreeningError(
      `Workflow not found: ${workflowId}`,
      400,
    );
  }
  if (!wf) {
    throw new ScreeningError("No workflow exists to place the promoted node on", 404);
  }
  const nodeXs = wf.nodes.map((n) =>
    typeof n.x === "number" ? n.x : (n.x as { toNumber(): number }).toNumber(),
  );
  const x = nodeXs.length > 0 ? Math.max(...nodeXs) + 340 : 120;
  const y = wf.nodes.length > 0 ? 60 : 80;

  // Markdown summary listing each promoted candidate + score-relevant metrics.
  const weights = parseJson<Record<string, number>>(screening.weights, {});
  const defs = computeMetricDefs(
    ordered.map((c) => parseJson<Record<string, number>>(c.metrics, {})),
  );
  const title = nodeName?.trim() || `Screening Picks — ${screening.name}`;
  const mdLines: string[] = [
    `# ${title}`,
    "",
    `${ordered.length} candidate(s) promoted from screening "${screening.name}"` +
      `${screening.sourceLabel ? ` (${screening.sourceLabel})` : ""}.`,
    "",
  ];
  for (const c of ordered) {
    const metrics = parseJson<Record<string, number>>(c.metrics, {});
    const parts = defs
      .filter((d) => metrics[d.key] !== undefined && (weights[d.key] ?? 1) > 0)
      .map((d) => `${d.label} ${fmtMetricValue(metrics[d.key])}`);
    const meta = [c.length != null ? `${c.length} aa` : null, ...parts]
      .filter((s): s is string => s !== null)
      .join(" · ");
    mdLines.push(`- **${c.name}**${meta ? ` — ${meta}` : ""}`);
    const linked = [c.fastaPath, c.pdbPath].filter((p) => p && existsSync(p));
    if (linked.length > 0) mdLines.push(`  - Files: ${linked.join(", ")}`);
  }
  const markdown = mdLines.join("\n");

  const summary =
    `Promoted ${ordered.length} candidate(s) from screening "${screening.name}" — ` +
    `${files.length} artifact file(s) available to downstream nodes ` +
    "(see the ##OUTPUTS## trailer in logs).";
  const logs =
    `Screening promotion: ${ordered.length} candidates from "${screening.name}".\n` +
    `##OUTPUTS## ${JSON.stringify(files)}\n`;

  const now = new Date();
  const nodeRow = await db.node.create({
    data: {
      workflowId: wf.id,
      type: "input",
      name: nodeName?.trim() || `Screening Picks — ${screening.name}`,
      refId: screening.id,
      x,
      y,
      status: "completed",
      progress: 100,
      params: JSON.stringify({ text: markdown }),
      result: summary,
      logs,
      startedAt: now,
      completedAt: now,
    },
  });

  await db.screeningCandidate.updateMany({
    where: { id: { in: uniqueIds } },
    data: { status: "promoted" },
  });

  const node: NodeDTO = toNodeDTO(nodeRow);
  return { node, promotedIds: uniqueIds, files };
}
