// Core execution helpers shared by API routes and the workflow engine.
// Server-only. Depends on llm.ts, agents.ts, tools.ts, bio-tools.ts.

import { chat, type ChatMessage } from "./llm";
import {
  generateAgentSystemPrompt,
  CRITIC_SYSTEM_PROMPT,
  roundPrompt,
  summaryPrompt,
} from "./agents";
import { getCompTool, buildCommand, extractToolCalls, type CompToolDef } from "./tools";
import { materializeSequence } from "./alphafold";
import { executeCompToolReal } from "./real-executor";
import { db } from "@/lib/db";
import { startClusterToolRun, reconcileClusterJobs, getRun } from "./cluster/cluster-run";
import type { ClusterRunTarget } from "./cluster/types";
import { resolve } from "path";
import { mkdirSync } from "fs";
import { runBio } from "./bio-tools";
import type {
  AgentDTO,
  AgentRuntimeConfig,
  DiscussionMessage,
  ToolCall,
} from "./types";

export interface AgentRunResult {
  text: string;
  toolCalls: ToolCall[];
  /** The reflected (final) text, if `reflect` was enabled. Same as `text` when not. */
  reflectedText?: string;
}

/** Options for `runAgentTurn`. */
export interface AgentRunOptions {
  temperature?: number;
  /** Max tool-calling rounds (default 3). */
  maxRounds?: number;
  /**
   * When true, after the tool-calling loop completes, run one more LLM call
   * asking the agent to review + improve its answer (deepseek-harness reflect step).
   * The reflected text becomes the returned `text`. Default `false` (backward-compat).
   */
  reflect?: boolean;
}

/** Parse an Agent row's knowledge JSON into the typed shape. */
export function parseKnowledge(raw: string | null | undefined): AgentDTO["knowledge"] {
  const base: AgentDTO["knowledge"] = {
    domainKnowledge: [],
    capabilities: [],
    webSearchEnabled: false,
    bioToolsEnabled: false,
  };
  if (!raw) return base;
  try {
    const obj = JSON.parse(raw);
    return {
      domainKnowledge: Array.isArray(obj.domainKnowledge) ? obj.domainKnowledge : [],
      capabilities: Array.isArray(obj.capabilities) ? obj.capabilities : [],
      webSearchEnabled: !!obj.webSearchEnabled,
      bioToolsEnabled: !!obj.bioToolsEnabled,
      localSoftwarePaths: obj.localSoftwarePaths ?? {},
      defaultToolEnvs: obj.defaultToolEnvs ?? {},
    };
  } catch {
    return base;
  }
}

/** Parse an Agent row's runtime JSON into the typed shape (fine-tune settings). */
export function parseRuntime(raw: string | null | undefined): AgentDTO["runtime"] {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const rt: AgentRuntimeConfig = {
      temperature: clampNum(obj.temperature, 0, 2, 0.7),
      maxTokens: Math.max(64, Math.floor(Number(obj.maxTokens) || 2000)),
      topP: clampNum(obj.topP, 0, 1, 0.9),
      verbose: !!obj.verbose,
      streaming: obj.streaming !== false,
    };
    if (typeof obj.systemPromptSuffix === "string" && obj.systemPromptSuffix.trim()) {
      rt.systemPromptSuffix = obj.systemPromptSuffix;
    }
    return rt;
  } catch {
    return undefined;
  }
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Map a Prisma Agent row to a DTO. */
export function toAgentDTO(a: {
  id: string;
  title: string;
  expertise: string;
  goal: string;
  role: string;
  model: string;
  color: string;
  icon: string;
  knowledge: string | null;
  runtime?: string | null;
  builtin: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AgentDTO {
  return {
    id: a.id,
    title: a.title,
    expertise: a.expertise,
    goal: a.goal,
    role: a.role,
    model: a.model,
    color: a.color,
    icon: a.icon,
    knowledge: parseKnowledge(a.knowledge),
    runtime: parseRuntime(a.runtime),
    builtin: a.builtin,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Resolve the effective LLM options for an agent turn: the agent's saved
 *  runtime settings (fine-tune dialog) act as DEFAULTS; explicit per-turn
 *  opts win. Returns null when nothing is configured (callers use their own
 *  defaults). */
function resolveAgentLLMOptions(
  agent: AgentDTO,
  opts: { temperature?: number; maxTokens?: number; topP?: number },
): { temperature?: number; maxTokens?: number; topP?: number } | null {
  const rt = agent.runtime;
  if (!rt) return null;
  const out: { temperature?: number; maxTokens?: number; topP?: number } = {};
  if (opts.temperature === undefined && rt.temperature !== undefined) out.temperature = rt.temperature;
  if (opts.maxTokens === undefined && rt.maxTokens !== undefined) out.maxTokens = rt.maxTokens;
  if (opts.topP === undefined && rt.topP !== undefined) out.topP = rt.topP;
  return Object.keys(out).length > 0 ? out : null;
}

/** Build the agent's system prompt, appending the fine-tune dialog's
 *  systemPromptSuffix when the agent has one saved. */
function buildAgentSystemPrompt(agent: AgentDTO): string {
  const base = generateAgentSystemPrompt(agent);
  const suffix = agent.runtime?.systemPromptSuffix?.trim();
  if (!suffix) return base;
  return `${base}\n\n--- Additional operator instructions ---\n${suffix}`;
}

/**
 * Run a single agent turn with a tool-calling loop (up to `maxRounds`).
 * Each round: call LLM → extract tool fences → execute tools → feed results back.
 * When `opts.reflect` is true, run one final self-critique pass (deepseek-harness reflect).
 * Temperature / maxTokens / topP default to the agent's saved runtime config
 * (fine-tune dialog) when the caller doesn't specify them.
 */
export async function runAgentTurn(
  agent: AgentDTO,
  history: { role: "user" | "assistant"; content: string }[],
  opts: AgentRunOptions = {},
): Promise<AgentRunResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const llmDefaults = resolveAgentLLMOptions(agent, opts) ?? {};
  const temperature = opts.temperature ?? llmDefaults.temperature ?? 0.7;
  const llmOpts = {
    temperature,
    ...(llmDefaults.maxTokens !== undefined ? { maxTokens: llmDefaults.maxTokens } : {}),
    ...(llmDefaults.topP !== undefined ? { topP: llmDefaults.topP } : {}),
  };
  const system = buildAgentSystemPrompt(agent);
  const toolCalls: ToolCall[] = [];
  const convo: ChatMessage[] = [
    { role: "system", content: system },
    ...history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  let lastText = "";
  for (let round = 0; round < maxRounds; round++) {
    const reply = await chat(convo, llmOpts);
    lastText = reply;
    const { comp, bio } = extractToolCalls(reply);
    if (comp.length === 0 && bio.length === 0) break;

    // Execute comp tool calls (real algorithms via the execution engine).
    for (const c of comp) {
      const def = getCompTool(c.tool);
      if (!def) continue;
      const workDir = resolve(process.cwd(), "outputs", c.tool, `agent-${Date.now()}`);
      let resultText = "";
      let status: ToolCall["status"] = "completed";
      try {
        const res = await executeCompToolReal(c.tool, c.params, workDir);
        resultText = res.stdout || res.stderr;
        status = res.exitCode === 0 ? "completed" : "failed";
      } catch (e) {
        resultText = `Error: ${(e as Error).message}`;
        status = "failed";
      }
      const tc: ToolCall = {
        kind: "comp",
        tool: c.tool,
        params: c.params,
        result: resultText,
        status,
      };
      toolCalls.push(tc);
      convo.push({ role: "assistant", content: reply });
      convo.push({
        role: "user",
        content: `[Tool result for ${c.tool}]\n${resultText}\n\nRevise your answer using these results.`,
      });
    }
    // Execute bio tool calls.
    for (const b of bio) {
      try {
        const res = await runBio(b.type as "blast" | "pdb" | "pubmed" | "uniprot", b as Record<string, unknown>);
        const summary = res.hits
          .map((h) => `- ${h.id}: ${h.title}`)
          .join("\n");
        const tc: ToolCall = {
          kind: "bio",
          tool: b.type,
          params: b as Record<string, unknown>,
          result: summary,
          status: "completed",
        };
        toolCalls.push(tc);
        convo.push({ role: "assistant", content: reply });
        convo.push({
          role: "user",
          content: `[Bio tool ${b.type} returned ${res.count} hits]\n${summary}\n\nIncorporate these into your answer.`,
        });
      } catch (e) {
        toolCalls.push({
          kind: "bio",
          tool: b.type,
          params: b as Record<string, unknown>,
          result: `Error: ${(e as Error).message}`,
          status: "failed",
        });
      }
    }
  }

  // After the tool-calling loop, optionally reflect (deepseek-harness reflect step).
  if (opts.reflect) {
    const reflectionReply = await chat(
      [
        ...convo,
        {
          role: "user",
          content:
            "Review your answer above. Is it accurate, complete, and well-structured? " +
            "If needed, provide an improved final answer. Otherwise, restate your answer concisely.",
        },
      ],
      { temperature: 0.4 },
    );
    // Keep the pre-reflection text available for debugging/transparency.
    const preReflect = lastText;
    lastText = reflectionReply;
    return { text: lastText, toolCalls, reflectedText: preReflect };
  }

  return { text: lastText, toolCalls };
}

export interface MeetingRunResult {
  messages: DiscussionMessage[];
  summary: string;
}

/** Run a multi-round team debate. */
export async function runTeamMeeting(
  lead: AgentDTO,
  members: AgentDTO[],
  agenda: string,
  opts: { numRounds?: number; temperature?: number } = {},
): Promise<MeetingRunResult> {
  const numRounds = opts.numRounds ?? 3;
  const temperature = opts.temperature ?? 0.7;
  const order = [lead, ...members];
  const messages: DiscussionMessage[] = [];

  for (let r = 0; r < numRounds; r++) {
    for (let i = 0; i < order.length; i++) {
      const agent = order[i];
      const isFirstSpeaker = i === 0;
      const prompt = roundPrompt(r, numRounds, agenda, isFirstSpeaker);
      const history = [
        { role: "user" as const, content: prompt },
        ...messages.map((m) => ({
          role: (m.agentName === agent.title ? "assistant" : "user") as "user" | "assistant",
          content: `${m.agentName}: ${m.message}`,
        })),
      ];
      const { text, toolCalls } = await runAgentTurn(agent, history, { temperature, maxRounds: 1 });
      messages.push({
        agentName: agent.title,
        agentColor: agent.color,
        message: text,
        roundIndex: r,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      });
    }
  }
  const summary = await chat(
    [
      { role: "system", content: summaryPrompt(agenda) },
      {
        role: "user",
        content: messages.map((m) => `**${m.agentName} (R${m.roundIndex + 1})**: ${m.message}`).join("\n\n"),
      },
    ],
    { temperature: 0.4 },
  );
  return { messages, summary };
}

/** Run an individual meeting — 3 rounds with the Scientific Critic. */
export async function runIndividualMeeting(
  agent: AgentDTO,
  agenda: string,
  opts: { temperature?: number } = {},
): Promise<MeetingRunResult> {
  const temperature = opts.temperature ?? 0.7;
  const critic: AgentDTO = {
    id: "critic",
    title: "Scientific Critic",
    expertise: "Critical review",
    goal: "Pressure-test the agent's answer.",
    role: "Adversarial reviewer",
    model: "default",
    color: "#ef4444",
    icon: "bug",
    knowledge: { domainKnowledge: [], capabilities: [], webSearchEnabled: false, bioToolsEnabled: false },
    builtin: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const messages: DiscussionMessage[] = [];
  for (let r = 0; r < 3; r++) {
    const agentPrompt =
      r === 0
        ? `Round 1/3. Address the agenda.\n\nAgenda:\n${agenda}\n\n(≤250 words)`
        : `Round ${r + 1}/3. The Critic has challenged your last answer. Revise or defend (≤200 words).`;
    const agentHistory = [
      { role: "user" as const, content: agentPrompt },
      ...messages.map((m) => ({
        role: (m.agentName === agent.title ? "assistant" : "user") as "user" | "assistant",
        content: `${m.agentName}: ${m.message}`,
      })),
    ];
    const { text } = await runAgentTurn(agent, agentHistory, { temperature, maxRounds: 1 });
    messages.push({ agentName: agent.title, agentColor: agent.color, message: text, roundIndex: r });

    const criticPrompt =
      r === 2
        ? `Final critique. Summarize the strongest remaining weakness in one sentence (≤80 words). End with 'Verdict: REVISE | ACCEPT | REJECT'.`
        : `Critique the agent's last answer. Find the weakest link and demand evidence (≤150 words).`;
    const criticHistory = [
      { role: "system" as const, content: CRITIC_SYSTEM_PROMPT },
      { role: "user" as const, content: criticPrompt },
      ...messages.map((m) => ({
        role: (m.agentName === "Scientific Critic" ? "assistant" : "user") as "user" | "assistant",
        content: `${m.agentName}: ${m.message}`,
      })),
    ];
    const criticText = await chat(criticHistory, { temperature: 0.5 });
    messages.push({ agentName: "Scientific Critic", agentColor: critic.color, message: criticText, roundIndex: r });
  }
  const summary = await chat(
    [
      { role: "system", content: summaryPrompt(agenda) },
      {
        role: "user",
        content: messages.map((m) => `**${m.agentName} (R${m.roundIndex + 1})**: ${m.message}`).join("\n\n"),
      },
    ],
    { temperature: 0.4 },
  );
  return { messages, summary };
}

export interface ResearchRunResult {
  messages: DiscussionMessage[];
  report: string;
}

/** Run the 3-phase research pipeline. */
export async function runResearch(
  lead: AgentDTO,
  members: AgentDTO[],
  topic: string,
  description: string | null,
  opts: { numRounds?: number; temperature?: number } = {},
): Promise<ResearchRunResult> {
  const numRounds = opts.numRounds ?? 2;
  const temperature = opts.temperature ?? 0.6;
  const all = [lead, ...members];
  const messages: DiscussionMessage[] = [];

  // Phase 1: Planning
  messages.push({ agentName: lead.title, agentColor: lead.color, message: `**[Planning]** Topic: ${topic}\n${description ?? ""}`, roundIndex: 0, phase: "planning" });
  for (const a of members) {
    const { text } = await runAgentTurn(
      a,
      [
        { role: "user", content: `[Planning phase] Propose a research plan for: ${topic}. ${description ?? ""} (≤200 words)` },
      ],
      { temperature, maxRounds: 1 },
    );
    messages.push({ agentName: a.title, agentColor: a.color, message: text, roundIndex: 0, phase: "planning" });
  }

  // Phase 2: Research (debate rounds)
  for (let r = 0; r < numRounds; r++) {
    for (const a of all) {
      const history = [
        { role: "user" as const, content: `[Research phase, round ${r + 1}/${numRounds}] Contribute findings, evidence, or critique to the research on: ${topic} (≤200 words)` },
        ...messages.map((m) => ({
          role: (m.agentName === a.title ? "assistant" : "user") as "user" | "assistant",
          content: `${m.agentName}: ${m.message}`,
        })),
      ];
      const { text } = await runAgentTurn(a, history, { temperature, maxRounds: 1 });
      messages.push({ agentName: a.title, agentColor: a.color, message: text, roundIndex: r, phase: "researching" });
    }
  }

  // Phase 3: Compilation — lead writes the report.
  const transcript = messages.map((m) => `**${m.agentName}** [${m.phase}]: ${m.message}`).join("\n\n");
  const report = await chat(
    [
      {
        role: "system",
        content:
          `You are ${lead.title}. Compile a comprehensive Markdown research report on the topic below, ` +
          `synthesizing the planning + research transcript. Use sections: # Summary, ## Background, ## Key Findings, ## Methods, ## Open Questions, ## References. Be specific and cite agent contributions.`,
      },
      { role: "user", content: `Topic: ${topic}\n\nDescription: ${description ?? "(none)"}\n\nTranscript:\n${transcript}` },
    ],
    { temperature: 0.4, maxTokens: 2000 },
  );
  messages.push({ agentName: lead.title, agentColor: lead.color, message: report, roundIndex: numRounds, phase: "compilation" });

  return { messages, report };
}

/** Validate a cluster run target from untrusted input (POST /api/tools/run
 *  body.cluster, or a workflow node's `_cluster` param — string or object).
 *  Returns null when the raw value carries no usable connectionId. */
export function extractClusterTarget(raw: unknown): ClusterRunTarget | null {
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const connectionId = typeof o.connectionId === "string" ? o.connectionId.trim() : "";
  if (!connectionId) return null;

  const target: ClusterRunTarget = {
    connectionId,
    mode: o.mode === "slurm" ? "slurm" : o.mode === "salloc" ? "salloc" : "direct",
  };
  if (typeof o.partition === "string" && o.partition.trim()) {
    target.partition = o.partition.trim();
  }
  // Tutorial-flow fields: compute node to ssh into (gpu05), environment
  // module (alphafold2), CUDA card pinning (CUDA_VISIBLE_DEVICES).
  if (typeof o.node === "string" && o.node.trim()) {
    target.node = o.node.trim();
  }
  if (typeof o.module === "string" && o.module.trim()) {
    target.module = o.module.trim();
  }
  if (typeof o.cudaDevice === "string" && o.cudaDevice.trim()) {
    target.cudaDevice = o.cudaDevice.trim().replace(/[^0-9,]/g, "");
  }
  const int = (v: unknown, min: number): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : undefined;
  };
  const gpus = int(o.gpus, 0);
  if (gpus !== undefined) target.gpus = gpus;
  const ntasks = int(o.ntasks, 1);
  if (ntasks !== undefined) target.ntasks = ntasks;
  const cpusPerTask = int(o.cpusPerTask, 1);
  if (cpusPerTask !== undefined) target.cpusPerTask = cpusPerTask;
  if (o.timeLimitMin === null) target.timeLimitMin = null;
  else {
    const timeLimitMin = int(o.timeLimitMin, 1);
    if (timeLimitMin !== undefined) target.timeLimitMin = timeLimitMin;
  }
  return target;
}

/** Run a comp tool via the REAL execution engine (native → built-in real
 *  algorithm). With opts.cluster, dispatch to the HPC cluster instead and
 *  poll to completion — the workflow engine's canvas node stays "running"
 *  until the remote job finishes. Returns {summary, stdout, files, command}. */
export async function executeCompTool(
  toolKey: string,
  params: Record<string, unknown>,
  opts: { cluster?: ClusterRunTarget } = {},
): Promise<{ summary: string; stdout: string; files: string[]; command: string; exitCode: number }> {
  const def = getCompTool(toolKey);
  if (!def) {
    return { summary: `Unknown tool: ${toolKey}`, stdout: "", files: [], command: "", exitCode: 1 };
  }
  if (opts.cluster) {
    return executeCompToolOnCluster(def, toolKey, params, opts.cluster);
  }
  const workDir = resolve(process.cwd(), "outputs", toolKey, `wf-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
  const res = await executeCompToolReal(toolKey, params, workDir);
  const summary = def.resultSummary(params, res.stdout);
  // Honest failure surfacing: non-zero exits carry stderr + a clear banner
  // so the node logs show the REAL error (never a silent success).
  const stdout =
    res.exitCode === 0
      ? `$ ${res.command}\n${res.executor === "builtin-engine" ? "\n[built-in real algorithm engine]\n" : ""}${res.stdout}`
      : `$ ${res.command}\n\n[exit ${res.exitCode} — TOOL FAILED]\n${res.stdout}` +
        `${res.stderr ? `\n\n[stderr]\n${res.stderr}` : ""}`;
  return {
    summary,
    stdout,
    files: res.outputFiles.map((f) => f),
    command: res.command,
    exitCode: res.exitCode,
  };
}

/** Cluster lane for workflow comptool nodes: create the ToolJob row, dispatch
 *  fire-and-forget, then poll (sweep + row read) until the job settles —
 *  synchronous completion from the caller's point of view. 30-minute ceiling. */
async function executeCompToolOnCluster(
  def: CompToolDef,
  toolKey: string,
  params: Record<string, unknown>,
  target: ClusterRunTarget,
): Promise<{ summary: string; stdout: string; files: string[]; command: string }> {
  // (a) Job row first — its id keys the workDir, run record, and poll target.
  let jobId: string;
  try {
    const job = await db.toolJob.create({
      data: {
        tool: toolKey,
        params: JSON.stringify({
          ...params,
          _meta: {
            executor: "cluster",
            realToolUsed: true,
            cluster: true,
            connectionId: target.connectionId,
            mode: target.mode,
          },
        }),
        status: "running",
        stdout: "",
        stderr: "",
        outputFiles: JSON.stringify([]),
        triggeredBy: "workflow",
        startedAt: new Date(),
      },
    });
    jobId = job.id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      summary: `Cluster run failed: could not create job row (${msg})`,
      stdout: `Cluster dispatch failed: ${msg}\n`,
      files: [],
      command: "",
    };
  }
  const workDir = resolve(process.cwd(), "outputs", toolKey, jobId);

  // (a2) AlphaFold: materialize a pasted FASTA sequence into a local input
  // file so the staging lane uploads it like any other path input.
  const dispatchParams = { ...params };
  if (toolKey === "alphafold") {
    mkdirSync(workDir, { recursive: true });
    materializeSequence(dispatchParams, workDir);
  }

  // (b) Dispatch (startClusterToolRun never throws; failures mark the row).
  const started = await startClusterToolRun({ jobId, toolKey, params: dispatchParams, workDir, target });
  if (!started.ok) {
    return {
      summary: `Cluster run failed: ${started.error}`,
      stdout: `Cluster dispatch failed: ${started.error}\n`,
      files: [],
      command: "",
      exitCode: 1,
    };
  }

  // (c) Poll loop: sweep the cluster + read the row every 3s. Real AF2
  // predictions (MSA + 5 models + relax) legitimately take hours — the
  // ceiling is per-tool; the timeout reports honestly either way.
  const deadline = Date.now() + (toolKey === "alphafold" ? 120 : 30) * 60 * 1000;
  let lastTail = "";
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 3000));
    await reconcileClusterJobs().catch(() => {});

    const row = await db.toolJob.findUnique({ where: { id: jobId } }).catch(() => null);
    if (row) {
      lastTail = row.stdout;
      if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
        let files: string[] = [];
        try {
          const parsed = row.outputFiles ? JSON.parse(row.outputFiles) : [];
          if (Array.isArray(parsed)) files = parsed.map(String);
        } catch {
          files = [];
        }
        const commandPrefix = row.command ? `$ ${row.command}\n` : "";
        const stdout =
          `${commandPrefix}[cluster run · job ${jobId}]\n${row.stdout}` +
          (row.stderr ? `\n\n[stderr]\n${row.stderr}` : "");
        const summary =
          row.status === "completed"
            ? def.resultSummary(params, row.stdout)
            : row.status === "cancelled"
              ? `Cluster run cancelled (job ${jobId}).`
              : `Cluster run failed${row.exitCode != null ? ` (exit ${row.exitCode})` : ""} — see logs.`;
        return {
          summary,
          stdout,
          files,
          command: row.command ?? "",
          exitCode: row.status === "completed" ? 0 : (row.exitCode ?? 1),
        };
      }
    } else {
      // Row vanished (db reset) — fall back to the run record.
      const run = getRun(jobId);
      if (run) {
        lastTail = run.logTailOut || lastTail;
        if (run.phase === "done" || run.phase === "failed" || run.phase === "cancelled") {
          return {
            summary:
              run.phase === "done"
                ? def.resultSummary(params, run.logTailOut)
                : `Cluster run ${run.phase} (job ${jobId}).`,
            stdout: `$ ${run.command}\n[cluster run · job ${jobId}]\n${run.logTailOut}`,
            files: run.syncedFiles,
            command: run.command,
            exitCode: run.phase === "done" ? 0 : 1,
          };
        }
      }
    }
  }

  // Timeout — the remote job may genuinely still be running; report honestly
  // instead of failing it (the user can watch/stop it from the Jobs panel).
  const run = getRun(jobId);
  const tail = lastTail || run?.logTailOut || "";
  return {
    summary:
      `Cluster run still in progress after the poll ceiling (job ${jobId}) — ` +
      "watch it on the AlphaFold / Jobs panel.",
    stdout: `$ ${run?.command ?? ""}\n[cluster run · job ${jobId} — poll timeout]\n${tail}`,
    files: [],
    command: run?.command ?? "",
  };
}
