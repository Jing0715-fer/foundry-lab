// Agent orchestrator — deepseek-harness plan-execute-observe-reflect pattern.
// Server-only. Depends on llm.ts, agents.ts, tools.ts, bio-tools.ts.

import { chat, type ChatMessage } from "./llm";
import { getCompTool, extractToolCalls } from "./tools";
import { executeCompToolReal } from "./real-executor";
import { resolve } from "path";
import { runBio } from "./bio-tools";
import type { AgentDTO, ToolCall, DiscussionMessage } from "./types";

// Re-export so consumers can grab typed imports from a single entry point.
export type { AgentDTO, ToolCall, DiscussionMessage };

// --- Phase types ---

export interface PlanStep {
  id: string;
  description: string;
  agentTitle?: string; // which agent should execute this step
  toolCalls?: ToolCall[]; // tools to invoke
  dependencies?: string[]; // step IDs that must complete first
  status: "pending" | "running" | "completed" | "failed";
  result?: string;
}

export interface OrchestrationPlan {
  goal: string;
  steps: PlanStep[];
  reasoning: string;
}

export interface OrchestrationExecutionEntry {
  stepId: string;
  agentTitle: string;
  output: string;
  toolCalls?: ToolCall[];
  satisfactory?: boolean;
  attempts?: number;
}

export interface OrchestrationResult {
  plan: OrchestrationPlan;
  executionLog: OrchestrationExecutionEntry[];
  reflection: string;
  finalSummary: string;
  success: boolean;
}

// --- Planner ---

/** Plan a task by decomposing it into steps. Returns a structured plan. */
export async function planTask(
  agents: AgentDTO[],
  taskDescription: string,
): Promise<OrchestrationPlan> {
  const agentList = agents.map((a) => `- ${a.title}: ${a.expertise}`).join("\n");
  const systemPrompt = `You are a research planning agent. Decompose the given task into 2-5 concrete steps.
Available agents:
${agentList}

Available tools: RFdiffusion (de novo design), RFantibody (antibody design), ProteinMPNN/LigandMPNN/SolubleMPNN (inverse folding), Rosetta/PyRosetta (scoring), RF3/ESMFold/ColabFold (structure prediction), AlphaFold2 (structure prediction on the GPU cluster — sequence in, five pLDDT-ranked models out), BLAST/PDB/PubMed/UniProt (bio queries).

Respond in EXACTLY this JSON format (no prose, no markdown fences):
{
  "goal": "<the overall goal>",
  "reasoning": "<why this plan>",
  "steps": [
    {
      "id": "step1",
      "description": "<what to do>",
      "agentTitle": "<which agent from the list>",
      "dependencies": []
    }
  ]
}`;

  const reply = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: taskDescription },
    ],
    { temperature: 0.3, maxTokens: 1200 },
  );

  // Parse the JSON (strip markdown fences if present)
  const jsonStr = reply.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(jsonStr);
    return {
      goal: parsed.goal ?? taskDescription,
      reasoning: parsed.reasoning ?? "",
      steps: (parsed.steps ?? []).map(
        (s: { id?: string; description: string; agentTitle?: string; dependencies?: string[] }) => ({
          id: s.id ?? `step${Math.random().toString(36).slice(2, 6)}`,
          description: s.description,
          agentTitle: s.agentTitle,
          dependencies: s.dependencies ?? [],
          status: "pending" as const,
        }),
      ),
    };
  } catch {
    // Fallback: single step
    return {
      goal: taskDescription,
      reasoning: "Failed to parse plan, falling back to single step.",
      steps: [{ id: "step1", description: taskDescription, status: "pending" }],
    };
  }
}

// --- Executor ---

/** Execute a single plan step using the assigned agent. */
export async function executeStep(
  step: PlanStep,
  agent: AgentDTO | undefined,
  context: string,
): Promise<{ output: string; toolCalls: ToolCall[] }> {
  if (!agent) {
    return { output: `No agent assigned for step: ${step.description}`, toolCalls: [] };
  }

  // Build the execution prompt
  const execPrompt = `Execute this research step:
${step.description}

Context from previous steps:
${context || "(none — this is the first step)"}

Use tools if needed by emitting fenced blocks:
\`\`\`tool
{"tool":"rfdiffusion","params":{"num_designs":4}}
\`\`\`
\`\`\`tool
{"tool":"alphafold","params":{"sequence":">name\nMKTAYIA..."}}
\`\`\`
\`\`\`bio
{"type":"pdb","query":"antibody"}
\`\`\`

After using tools, incorporate the results into your answer. Be specific and quantitative.`;

  // Use the enhanced runAgentTurn with reflection (maxRounds=3)
  const { runAgentTurn } = await import("./run-utils");
  const result = await runAgentTurn(
    agent,
    [{ role: "user", content: execPrompt }],
    { temperature: 0.6, maxRounds: 3, reflect: true },
  );
  return { output: result.text, toolCalls: result.toolCalls };
}

// --- Observer ---

/** Observe the execution result and decide if it's satisfactory. */
export async function observeStep(
  step: PlanStep,
  output: string,
  agent: AgentDTO | undefined,
): Promise<{ satisfactory: boolean; feedback: string }> {
  const systemPrompt = `You are an observer evaluating a research step's output.
Step: ${step.description}
Agent: ${agent?.title ?? "unassigned"}
Output: ${output.slice(0, 500)}

Is this output satisfactory (addresses the step, includes relevant detail)?
Respond in EXACTLY this JSON format:
{"satisfactory": true/false, "feedback": "<brief feedback>"}`;

  const reply = await chat(
    [{ role: "system", content: systemPrompt }],
    { temperature: 0.3, maxTokens: 300 },
  );
  try {
    const parsed = JSON.parse(reply.replace(/```json/g, "").replace(/```/g, "").trim());
    return { satisfactory: !!parsed.satisfactory, feedback: parsed.feedback ?? "" };
  } catch {
    return { satisfactory: true, feedback: "" };
  }
}

// --- Reflector ---

/** Reflect on the overall execution and suggest improvements. */
export async function reflectOnExecution(
  plan: OrchestrationPlan,
  executionLog: { stepId: string; agentTitle: string; output: string }[],
): Promise<string> {
  const transcript = executionLog
    .map((e) => `[${e.agentTitle}] ${e.output.slice(0, 300)}`)
    .join("\n\n");
  const reply = await chat(
    [
      {
        role: "system",
        content:
          "You are a reflection agent. Briefly assess what went well, what could improve, and key takeaways. Max 150 words.",
      },
      { role: "user", content: `Goal: ${plan.goal}\n\nExecution:\n${transcript}` },
    ],
    { temperature: 0.4, maxTokens: 400 },
  );
  return reply;
}

// --- Full orchestration loop ---

/**
 * Run the full plan-execute-observe-reflect loop.
 * Each step: plan → execute (with tool-calling loop) → observe → retry once if unsatisfactory.
 * After all steps: reflect on the whole execution + synthesize a final summary.
 */
export async function orchestrate(
  agents: AgentDTO[],
  taskDescription: string,
): Promise<OrchestrationResult> {
  // 1. PLAN
  const plan = await planTask(agents, taskDescription);

  // 2. EXECUTE + OBSERVE each step
  const executionLog: OrchestrationExecutionEntry[] = [];
  const stepOutputs = new Map<string, string>();
  const agentByTitle = new Map(agents.map((a) => [a.title, a]));

  for (const step of plan.steps) {
    step.status = "running";
    // Gather context from completed dependencies
    const context = (step.dependencies ?? [])
      .map((depId) => stepOutputs.get(depId))
      .filter(Boolean)
      .join("\n---\n");

    const agent = step.agentTitle ? agentByTitle.get(step.agentTitle) : undefined;
    const { output, toolCalls } = await executeStep(step, agent, context);

    // Observe
    const observation = await observeStep(step, output, agent);
    let finalOutput = output;
    let finalToolCalls = toolCalls;
    let attempts = 1;

    // Retry once with feedback if unsatisfactory and not already an error.
    if (!observation.satisfactory && !output.includes("Error")) {
      const retryResult = await executeStep(
        { ...step, description: `${step.description}\n\nFeedback: ${observation.feedback}` },
        agent,
        context,
      );
      finalOutput = retryResult.output;
      finalToolCalls = retryResult.toolCalls;
      attempts = 2;
    }

    executionLog.push({
      stepId: step.id,
      agentTitle: agent?.title ?? "unassigned",
      output: finalOutput,
      toolCalls: finalToolCalls,
      satisfactory: observation.satisfactory,
      attempts,
    });
    stepOutputs.set(step.id, finalOutput);
    step.status = "completed";
    step.result = finalOutput;
  }

  // 3. REFLECT
  const reflection = await reflectOnExecution(plan, executionLog);

  // 4. SUMMARIZE
  const finalSummary = await chat(
    [
      {
        role: "system",
        content:
          "You are a summarizer. Given a goal + execution log + reflection, produce a concise final report (max 200 words) with key findings.",
      },
      {
        role: "user",
        content:
          `Goal: ${plan.goal}\n\nExecution:\n${executionLog
            .map((e) => `- ${e.agentTitle}: ${e.output.slice(0, 200)}`)
            .join("\n")}\n\nReflection: ${reflection}`,
      },
    ],
    { temperature: 0.4, maxTokens: 500 },
  );

  return {
    plan,
    executionLog,
    reflection,
    finalSummary,
    success: true,
  };
}

// --- Direct tool invocation helpers (used by the executor indirectly via runAgentTurn,
//     but exposed for orchestrator consumers that want to call tools directly). ---

/** Run a single comp tool directly via the REAL execution engine. */
export async function runCompToolDirect(
  toolKey: string,
  params: Record<string, unknown>,
): Promise<{ stdout: string; toolCalls: ToolCall[] } | null> {
  const def = getCompTool(toolKey);
  if (!def) return null;
  const workDir = resolve(process.cwd(), "outputs", toolKey, `direct-${Date.now()}`);
  const res = await executeCompToolReal(toolKey, params, workDir);
  const tc: ToolCall = {
    kind: "comp",
    tool: toolKey,
    params,
    result: res.stdout || res.stderr,
    status: res.exitCode === 0 ? "completed" : "failed",
  };
  return { stdout: res.stdout || res.stderr, toolCalls: [tc] };
}

/** Run a single bio tool directly. Returns the hit summary + tool call record. */
export async function runBioToolDirect(
  type: "blast" | "pdb" | "pubmed" | "uniprot",
  params: Record<string, unknown>,
): Promise<{ summary: string; toolCalls: ToolCall[] }> {
  try {
    const res = await runBio(type, params);
    const summary = res.hits.map((h) => `- ${h.id}: ${h.title}`).join("\n");
    const tc: ToolCall = {
      kind: "bio",
      tool: type,
      params,
      result: summary,
      status: "completed",
    };
    return { summary, toolCalls: [tc] };
  } catch (e) {
    const tc: ToolCall = {
      kind: "bio",
      tool: type,
      params,
      result: `Error: ${(e as Error).message}`,
      status: "failed",
    };
    return { summary: `Error: ${(e as Error).message}`, toolCalls: [tc] };
  }
}

/** Extract tool calls from a free-text LLM reply (convenience passthrough). */
export function extractCalls(text: string) {
  return extractToolCalls(text);
}

// Build a ChatMessage array helper (typed re-export for callers that want it).
export function buildMessages(
  system: string,
  user: string,
): ChatMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
