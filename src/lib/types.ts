// Shared TypeScript domain types for Foundry Lab.

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
  tool: string; // rfdiffusion | proteinmpnn | blast | pdb | ...
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
  | "comptool" | "biotool" | "input" | "output";

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
  /** for comptool: which tool key */
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

export type CompToolKey = "rfdiffusion" | "rfantibody" | "proteinmpnn" | "rosetta";
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
}
