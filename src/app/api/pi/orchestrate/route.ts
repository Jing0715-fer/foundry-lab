// POST /api/pi/orchestrate — the Principal Investigator (PI) orchestrator.
//
// Plan-Execute-Observe pattern (inspired by deepseek-harness):
//   1. PLAN  — the PI decomposes the user's request into concrete steps.
//   2. ACT   — emits JSON action blocks (create_node / create_edge / run_workflow).
//   3. RUN   — server-side executes the create_* actions; run_workflow is
//              returned to the frontend so it can refresh the canvas first
//              and then trigger the workflow run.
//   4. REPORT — the PI's prose reply (with the actions block stripped) is
//              returned to the chat UI for display.
//
// The PI agent is looked up by title "Principal Investigator" (created by
// /api/seed). The current canvas state (node names + types + statuses) is
// injected into the system prompt so the PI can reason about what's already
// there before creating new nodes.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { toAgentDTO } from "@/lib/run-utils";
import { chat, type ChatMessage } from "@/lib/llm";

export const runtime = "nodejs";

interface OrchestrateRequest {
  message: string;
  workflowId: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

interface PiAction {
  type: "create_node" | "create_edge" | "run_node" | "run_workflow";
  // For create_node:
  nodeType?: string;
  nodeName?: string;
  nodeRefTitle?: string; // for agent nodes — resolved to refId by title
  params?: Record<string, unknown>;
  // For create_edge:
  fromNodeName?: string;
  toNodeName?: string;
  fromPort?: string;
  toPort?: string;
  // For run_node:
  // (nodeName is reused)
}

interface OrchestrateResponse {
  reply: string;
  actions: PiAction[];
  plan: string[];
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as OrchestrateRequest;
  const { message, workflowId, history = [] } = body;

  if (typeof message !== "string" || !message.trim()) {
    return NextResponse.json(
      { error: "message is required" },
      { status: 400 },
    );
  }
  if (typeof workflowId !== "string" || !workflowId) {
    return NextResponse.json(
      { error: "workflowId is required" },
      { status: 400 },
    );
  }

  // Find the PI agent.
  const piAgent = await db.agent.findFirst({
    where: { title: "Principal Investigator" },
  });
  if (!piAgent) {
    return NextResponse.json(
      { error: "PI agent not found. Run /api/seed first." },
      { status: 404 },
    );
  }
  // Build a typed DTO (also validates the knowledge JSON parses).
  void toAgentDTO(piAgent);

  // Fetch current workflow state to give the PI context.
  const workflow = await db.workflow.findUnique({
    where: { id: workflowId },
    include: { nodes: true, edges: true },
  });
  if (!workflow) {
    return NextResponse.json(
      { error: "Workflow not found" },
      { status: 404 },
    );
  }
  const currentNodeNames =
    workflow.nodes.length > 0
      ? workflow.nodes
          .map((n) => `- ${n.name} (${n.type}, status=${n.status})`)
          .join("\n")
      : "(empty canvas)";

  // Build the PI's orchestration system prompt.
  const systemPrompt = `You are the Principal Investigator (PI) orchestrating a protein design research workflow.

Your capabilities:
1. PLAN: Decompose the user's request into concrete steps.
2. CREATE NODES: You can create nodes on the workflow canvas by emitting JSON action blocks.
3. CONNECT: You can connect nodes with edges.
4. RUN: You can run individual nodes or the whole workflow.
5. REPORT: After execution, summarize the results for the user.

Available node types:
- "input" — a text/sequence input node (params: {text: "..."})
- "agent" — an agent persona node (nodeRefTitle: "Principal Investigator" | "Computational Biologist" | "Bioinformatician" | "Immunologist" | "Structural Biologist" | "Machine Learning Engineer" | "Biochemist" | "Cell Biologist")
- "meeting" — a team meeting node (params: {agenda: "...", numRounds: 3, temperature: 0.7})
- "research" — a deep research pipeline (params: {topic: "...", numRounds: 2, temperature: 0.6})
- "alphafold" — AlphaFold2 structure prediction (params: {sequence: ">name\nMKT...", output_dir: "name_AF2", max_template_date: "2021-07-20", gpu: "0"}). Runs on the GPU cluster (mgt → salloc → gpu05 → module load alphafold2) when routed via the inspector, else locally with the built-in engine.
- "biotool" — bioinformatics query (params: {bioKey: "blast|pdb|pubmed|uniprot", query: "...", maxResults: 5})
- "output" — final result display

To execute actions, emit a fenced code block with JSON:
\`\`\`actions
{
  "plan": ["Step 1: ...", "Step 2: ..."],
  "actions": [
    {"type": "create_node", "nodeType": "input", "nodeName": "Target", "params": {"text": "..."}},
    {"type": "create_node", "nodeType": "agent", "nodeName": "CompBio", "nodeRefTitle": "Computational Biologist"},
    {"type": "create_node", "nodeType": "alphafold", "nodeName": "AlphaFold", "params": {"sequence": ">target\nMKTAYIA..."}},
    {"type": "create_edge", "fromNodeName": "Target", "toNodeName": "AlphaFold", "fromPort": "text", "toPort": "input"},
    {"type": "run_workflow"}
  ]
}
\`\`\`

IMPORTANT: For "agent" nodes, the "nodeRefTitle" field must be a TOP-LEVEL key on the action object (not nested inside "params").

Current canvas state:
${currentNodeNames}

Workflow: When the user asks for a protein task:
1. Create an input node with the target sequence or specification.
2. If discussion is needed, create a meeting node + connect 2-3 agent nodes + the input.
3. Create an "alphafold" node for structure prediction — paste the FASTA sequence into its sequence param.
4. Connect the nodes into a pipeline.
5. Emit "run_workflow" to execute.
6. After the workflow completes, the frontend will fetch results and you'll be called again to summarize (outputs include five models ranked by pLDDT — ranked_0.pdb is the highest-confidence prediction).

Be concise in your prose. Put the structured plan + actions in the JSON block. After the block, write 1-2 sentences explaining what you're doing.`;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map(
      (h) => ({ role: h.role, content: h.content }) as ChatMessage,
    ),
    { role: "user", content: message },
  ];

  const reply = await chat(messages, { temperature: 0.4, maxTokens: 1500 });

  // Parse the actions block from the reply.
  const actionsMatch = reply.match(/```actions\s*\n([\s\S]*?)```/);
  let plan: string[] = [];
  let actions: PiAction[] = [];
  if (actionsMatch) {
    try {
      const parsed = JSON.parse(actionsMatch[1].trim());
      if (Array.isArray(parsed.plan)) {
        plan = parsed.plan.filter((s: unknown) => typeof s === "string");
      }
      if (Array.isArray(parsed.actions)) {
        actions = parsed.actions as PiAction[];
      }
    } catch {
      // ignore parse errors — the PI's prose is still useful
    }
  }

  // Execute the actions server-side (create nodes, edges).
  // run_workflow is returned to the frontend so it can refresh the canvas
  // and then trigger the workflow run via POST /api/workflow/run.
  const executedActions: PiAction[] = [];
  const nodeNameToId = new Map<string, string>();
  // Seed the map with existing node names → ids so create_edge can find them.
  for (const n of workflow.nodes) nodeNameToId.set(n.name, n.id);

  for (const action of actions) {
    try {
      if (action.type === "create_node") {
        if (
          typeof action.nodeType !== "string" ||
          typeof action.nodeName !== "string"
        ) {
          continue;
        }
        // Skip if a node with the same name already exists — the PI may
        // accidentally re-emit the same create_node in a follow-up turn.
        if (nodeNameToId.has(action.nodeName)) {
          executedActions.push(action);
          continue;
        }
        // Resolve agent refId by title. The PI's prompt asks for
        // nodeRefTitle as a top-level field, but the LLM occasionally
        // nests it inside params — check both as a robustness fallback.
        let refId: string | null = null;
        const refTitle =
          action.nodeType === "agent"
            ? (action.nodeRefTitle ??
              (action.params as { nodeRefTitle?: string } | undefined)
                ?.nodeRefTitle)
            : undefined;
        if (refTitle) {
          const agent = await db.agent.findFirst({
            where: { title: refTitle },
          });
          if (agent) refId = agent.id;
        }
        // Position nodes in a grid — column based on order, row based on count.
        const existingCount = nodeNameToId.size;
        const col = Math.floor(existingCount / 4);
        const row = existingCount % 4;
        const x = 80 + col * 320;
        const y = 80 + row * 170;
        const node = await db.node.create({
          data: {
            workflowId,
            type: action.nodeType,
            name: action.nodeName,
            x,
            y,
            refId,
            params: action.params
              ? JSON.stringify(action.params)
              : "{}",
            status: "idle",
          },
        });
        nodeNameToId.set(node.name, node.id);
        executedActions.push(action);
      } else if (action.type === "create_edge") {
        const fromId = action.fromNodeName
          ? nodeNameToId.get(action.fromNodeName)
          : undefined;
        const toId = action.toNodeName
          ? nodeNameToId.get(action.toNodeName)
          : undefined;
        if (!fromId || !toId) {
          // Skip silently — the PI may reference a node name we don't have.
          continue;
        }
        // The Edge model has a unique constraint on
        // [workflowId, fromNodeId, toNodeId, fromPort, toPort], so a
        // duplicate edge will throw — that's caught below.
        await db.edge.create({
          data: {
            workflowId,
            fromNodeId: fromId,
            toNodeId: toId,
            fromPort: action.fromPort ?? null,
            toPort: action.toPort ?? null,
          },
        });
        executedActions.push(action);
      } else if (action.type === "run_workflow") {
        // Don't run here — return the action so the frontend can trigger it
        // after refreshing the canvas (so the user sees the new nodes first).
        executedActions.push(action);
      } else if (action.type === "run_node") {
        // Returned to frontend; not executed server-side here.
        executedActions.push(action);
      }
    } catch (e) {
      // log + continue — one bad action shouldn't abort the rest.
      console.error("[pi-orchestrate] action failed:", action, e);
    }
  }

  // Strip the actions block from the reply for display.
  const displayReply = reply
    .replace(/```actions\s*\n[\s\S]*?```/, "")
    .trim();

  return NextResponse.json({
    reply: displayReply,
    actions: executedActions,
    plan,
  } as OrchestrateResponse);
}
