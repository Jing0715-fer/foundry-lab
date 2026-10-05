// Shared TypeScript domain types for Foundry Lab.

import type { ClusterJobInfoDTO } from "./cluster/types";

export type AgentIcon =
  | "bot" | "flask-conical" | "dna" | "microscope" | "brain"
  | "calculator" | "atom" | "bug" | "leaf" | "beaker" | "cpu";

export interface AgentKnowledgeConfig {
  domainKnowledge: string[];
  capabilities: string[];
  webSearchEnabled: boolean;
  bioToolsEnabled: boolean;
  localSoftwarePaths?: Record<string, string>;
  defaultToolEnvs?: Record<string, string>;
}

/**
 * Per-agent runtime settings (the fine-tune dialog). Persisted on the
 * Agent row as JSON and applied by runAgentTurn as the DEFAULTS for every
 * LLM call this agent makes — callers can still override per-turn.
 */
export interface AgentRuntimeConfig {
  /** Sampling temperature (0–2, default 0.7). */
  temperature: number;
  /** Max completion tokens (default 2000). */
  maxTokens: number;
  /** Top-p nucleus sampling (0–1, default 0.9). */
  topP: number;
  /** Extra system-prompt suffix appended to the agent's persona prompt. */
  systemPromptSuffix?: string;
  /** Verbose mode (richer tool-call reporting in logs). */
  verbose?: boolean;
  /** Stream tokens to the client when the lane supports it. */
  streaming?: boolean;
}

export interface AgentDTO {
  id: string;
  title: string;
  expertise: string;
  goal: string;
  role: string;
  model: string;
  color: string;
  icon: string;
  knowledge: AgentKnowledgeConfig;
  runtime?: AgentRuntimeConfig;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageDTO {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

export interface ToolCall {
  kind: "comp" | "bio";
  tool: string; // rfdiffusion | proteinmpnn | alphafold | blast | pdb | ...
  params: Record<string, unknown>;
  result?: string;
  status?: "pending" | "running" | "completed" | "failed";
  jobId?: string;
}

export type TaskType = "general" | "design" | "analysis" | "research";
export type RunStatus =
  | "queued" | "draft" | "idle" | "pending"
  | "running" | "planning" | "researching" | "writing"
  | "completed" | "failed" | "cancelled";

export interface TaskDTO {
  id: string;
  title: string;
  prompt: string;
  taskType: TaskType;
  agentIds: string[];
  status: RunStatus;
  result: string | null;
  logs: string;
  tags: string[];
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DiscussionMessage {
  agentName: string;
  agentColor?: string;
  message: string;
  roundIndex: number;
  toolCalls?: ToolCall[];
  phase?: string;
}

export interface MeetingDTO {
  id: string;
  type: "team" | "individual";
  agenda: string;
  saveName: string | null;
  numRounds: number;
  temperature: number;
  leadId: string | null;
  memberIds: string[];
  status: RunStatus;
  summary: string | null;
  messages: DiscussionMessage[];
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchReportDTO {
  id: string;
  topic: string;
  description: string | null;
  numRounds: number;
  temperature: number;
  leadId: string | null;
  memberIds: string[];
  status: RunStatus;
  discussion: DiscussionMessage[];
  report: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// --- Workflow canvas ---------------------------------------------------------

export type NodeType =
  | "agent" | "task" | "meeting" | "research"
  | "alphafold" | "biotool" | "input" | "output"
  // Per-tool node types — each comp tool is its own canvas node (the old
  // generic "comptool" node was removed; these are the standalone commands).
  | "rfdiffusion" | "rfantibody" | "proteinmpnn" | "ligandmpnn" | "solublempnn"
  | "rosetta" | "pyrosetta"
  | "rf3" | "esmfold" | "colabfold";

export type NodeStatus =
  | "idle" | "pending" | "running" | "completed" | "failed";

export type PortKind =
  | "agent" | "text" | "context" | "summary"
  | "report" | "params" | "files" | "query" | "results" | "*";

export interface PortSpec {
  name: string;
  label: string;
  kind?: PortKind;
  accepts?: (PortKind | "*")[];
  multiple?: boolean;
}

export type ParamType = "number" | "select" | "bool" | "text" | "path" | "textarea";

export interface ParamSchema {
  key: string;
  label: string;
  type: ParamType;
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: string[];
  hint?: string;
  placeholder?: string;
  advanced?: boolean;
}

// ---------------------------------------------------------------------------
// Parameter sweep (campaign mode) — expand one tool node's parameter grid
// into N variant nodes that inherit its upstream wiring.
// ---------------------------------------------------------------------------

export type SweepValue = string | number | boolean;

/** One axis of the sweep: a param key + the values it should take. */
export interface SweepAxisDTO {
  key: string;
  values: SweepValue[];
}

/** POST /api/workflow/nodes/[id]/sweep response. */
export interface SweepResponseDTO {
  sourceId: string;
  /** number of combinations actually materialized as variant nodes */
  combinations: number;
  /** shared sweepGroup id stamped on every created variant */
  sweepGroup: string;
  nodes: NodeDTO[];
  edges: EdgeDTO[];
}

// --- Sweep comparison (GET /api/workflow/nodes/[id]/sweep-group) --------------

/** One variant row of the sweep compare table. */
export interface SweepVariantRowDTO {
  nodeId: string;
  name: string;
  status: NodeStatus;
  /** Full node params (params columns are derived from axisKeys). */
  params: Record<string, string | number | boolean>;
  /** Output files listed in the variant's ##OUTPUTS## trailer. */
  files: string[];
  /** Aggregated run metrics (means over the variant's output dirs). */
  metrics: Record<string, number>;
  completedAt: string | null;
}

/** Metric column of the sweep compare table (label + direction + domain). */
export interface SweepMetricColumnDTO {
  key: string;
  label: string;
  unit?: string;
  higherIsBetter: boolean;
  domain: [number, number];
  hint?: string;
}

/** GET sweep-group response — everything the compare dialog needs. */
export interface SweepGroupDTO {
  groupId: string;
  workflowId: string;
  nodeType: NodeType;
  toolLabel: string;
  /** Param keys that vary across the variants (table param columns). */
  axisKeys: string[];
  variants: SweepVariantRowDTO[];
  metrics: SweepMetricColumnDTO[];
  completedCount: number;
  totalOutputFiles: number;
}

export interface NodeSpec {
  type: NodeType;
  label: string;
  icon: string; // lucide icon name
  color: string; // teal | violet | amber | rose | emerald | cyan | slate | orange | pink
  description: string;
  category: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  params: ParamSchema[];
  /** does this node require an LLM call to run */
  usesLLM?: boolean;
  /** for tool nodes: which tool key (every comp-tool node spec) */
  toolKey?: string;
  /** for biotool: which bio api */
  bioKey?: string;
}

export interface NodeDTO {
  id: string;
  workflowId: string;
  type: NodeType;
  refId: string | null;
  name: string;
  x: number;
  y: number;
  status: NodeStatus;
  progress: number;
  params: Record<string, string | number | boolean>;
  result: string | null;
  logs: string;
  /** Shared id of the parameter-sweep group this variant belongs to (null = standalone node). */
  sweepGroup: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EdgeDTO {
  id: string;
  workflowId: string;
  fromNodeId: string;
  toNodeId: string;
  fromPort: string | null;
  toPort: string | null;
  createdAt: string;
}

export interface WorkflowDTO {
  id: string;
  name: string;
  nodes: NodeDTO[];
  edges: EdgeDTO[];
  createdAt: string;
  updatedAt: string;
}

// --- Tools -------------------------------------------------------------------

export type CompToolKey =
  | "alphafold"
  | "rfdiffusion" | "rfantibody" | "proteinmpnn" | "ligandmpnn" | "solublempnn"
  | "rosetta" | "pyrosetta"
  | "rf3" | "esmfold" | "colabfold";
export type BioToolKey = "blast" | "pdb" | "pubmed" | "uniprot";

export interface ToolEnvironmentDTO {
  id: string;
  name: string;
  tool: string;
  runtime: string;
  wslDistro: string | null;
  condaEnv: string | null;
  workDir: string | null;
  exePath: string | null;
  extraEnv: Record<string, string>;
  enabled: boolean;
}

export interface ToolPresetDTO {
  id: string;
  name: string;
  tool: string;
  params: Record<string, unknown>;
  builtin: boolean;
}

export interface ToolJobDTO {
  id: string;
  tool: string;
  presetName: string | null;
  params: Record<string, unknown>;
  status: RunStatus;
  pid: number | null;
  stdout: string;
  stderr: string;
  outputFiles: string[];
  exitCode: number | null;
  command: string | null;
  triggeredBy: string;
  agentId: string | null;
  environmentId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Cluster-run projection — present when this job was dispatched to an
   *  SSH-reachable cluster (connection, mode, phase, tails, synced files). */
  cluster?: ClusterJobInfoDTO | null;
}

// --- Environment scan (GET /api/tools/scan) ----------------------------------

/**
 * Host platform snapshot included in the scan response (client-safe mirror
 * of the server-side getPlatformInfo() in lib/platform.ts).
 */
export interface PlatformInfoDTO {
  /** process.platform — "win32" | "darwin" | "linux" | … */
  os: string;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  /** Human label, e.g. "Linux x64" / "macOS arm64" / "Windows x64". */
  label: string;
  /** Path separator — "/" on POSIX, "\\" on win32. */
  pathSep: string;
}

// --- Screening (large-scale result evaluation & ranking) ----------------------

export type ScreeningCandidateStatus =
  | "new" | "shortlisted" | "rejected" | "promoted";

/** One metric column of a screening (derived from real harvested metrics). */
export interface ScreeningMetricDef {
  /** Canonical metric key, e.g. plddt | ptm | recovery | diversity | helix_pct | clashes | rama_ll … */
  key: string;
  /** Human label, e.g. "pLDDT". */
  label: string;
  unit?: string;
  /** Direction — clashes is the main lower-is-better metric. */
  higherIsBetter: boolean;
  /** Observed domain across this screening's candidates: [min, max]. */
  domain: [number, number];
  /** Quality thresholds in RAW units. For higherIsBetter: v ≥ good → emerald,
   *  v ≥ warn → amber, else rose. For lower-is-better: v ≤ good → emerald,
   *  v ≤ warn → amber, else rose. Optional — metrics without thresholds are neutral. */
  good?: number;
  warn?: number;
  /** Short explanation for tooltips (e.g. "predicted lDDT per-residue mean"). */
  hint?: string;
}

export interface ScreeningCandidateDTO {
  id: string;
  screeningId: string;
  name: string;
  /** Tool family: rfdiffusion | alphafold | proteinmpnn | rosetta | manual … */
  source: string;
  /** Sub-label (run seed/symmetry, model rank, …). */
  sourceLabel: string | null;
  pdbPath: string | null;
  fastaPath: string | null;
  sequence: string | null;
  length: number | null;
  /** Raw metric values keyed by canonical metric key. */
  metrics: Record<string, number>;
  starred: boolean;
  status: ScreeningCandidateStatus;
  tags: string[];
  notes: string | null;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScreeningDTO {
  id: string;
  name: string;
  description: string | null;
  /** node | job | demo */
  sourceType: string;
  sourceRef: string | null;
  sourceLabel: string | null;
  /** metricKey → weight (0–5). Composite = 100 · Σ(w·norm)/Σw. */
  weights: Record<string, number>;
  metricDefs: ScreeningMetricDef[];
  status: string;
  candidateCount: number;
  starredCount: number;
  shortlistedCount: number;
  rejectedCount: number;
  promotedCount: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/screening/[id]/promote response. */
export interface PromoteResultDTO {
  /** The created canvas node (type "input", status "completed") whose logs
   *  embed the promoted files in a ##OUTPUTS## trailer — downstream tool
   *  nodes auto-wire pdb_path/fasta_path from it. */
  node: NodeDTO;
  promotedIds: string[];
  files: string[];
}
