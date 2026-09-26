// Workflow template definitions — pre-built research workflows that users can
// load with a single click from the Templates gallery.
//
// Each template defines nodes (positions + optional refId/params) and edges
// (indices into the nodes array). When the user loads a template, the gallery
// component:
//   1. DELETEs every existing node in the workflow (cascades edges).
//   2. POSTs each template node (resolving refTitle → real agent ID via
//      GET /api/agents).
//   3. POSTs each template edge using the returned real node IDs.
//   4. Refreshes the workflow + switches to the Canvas panel.

export interface WorkflowTemplateNode {
  type: string;
  name: string;
  x: number;
  y: number;
  /** If set, this node references an existing agent by ID. */
  refId?: string;
  /** If set, the loader resolves this title → an existing agent's ID (preferred over refId). */
  refTitle?: string;
  /** Optional node params (e.g. comptool.toolKey, biotool.bioKey). */
  params?: Record<string, string | number | boolean>;
}

export interface WorkflowTemplateEdge {
  /** Index into the template's `nodes[]` array. */
  from: number;
  /** Index into the template's `nodes[]` array. */
  to: number;
  fromPort?: string;
  toPort?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: "research" | "design" | "analysis";
  nodes: WorkflowTemplateNode[];
  edges: WorkflowTemplateEdge[];
}

// Layout constants — card is 248x116, so 320 horizontal / 160 vertical gives
// generous spacing for ports + edge routing.
const COL = 320;
const ROW = 180;

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // 1. Nanobody Design Pipeline ---------------------------------------------
  // Input → Agent (Computational Biologist) → CompTool (RFdiffusion) → Output
  {
    id: "nanobody-design",
    name: "Nanobody Design Pipeline",
    description:
      "A linear computational protein-design workflow: an input prompt feeds a Computational Biologist agent who authors an RFdiffusion run, whose outputs land in a final report.",
    category: "design",
    nodes: [
      { type: "input", name: "Design Brief", x: 0, y: ROW },
      {
        type: "agent",
        name: "Computational Biologist",
        x: COL,
        y: ROW,
        refTitle: "Computational Biologist",
      },
      {
        type: "comptool",
        name: "RFdiffusion",
        x: COL * 2,
        y: ROW,
        params: { toolKey: "rfdiffusion" },
      },
      { type: "output", name: "Design Report", x: COL * 3, y: ROW },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "context" },
      { from: 1, to: 2, fromPort: "message", toPort: "input" },
      { from: 2, to: 3, fromPort: "summary", toPort: "value" },
    ],
  },

  // 2. Team Research Meeting -------------------------------------------------
  // Input → Meeting (connected to 2 Agent nodes: PI + Bioinformatician) → Output
  {
    id: "team-research-meeting",
    name: "Team Research Meeting",
    description:
      "A PI and a Bioinformatician debate an agenda sourced from an Input node. The meeting produces a structured summary that flows into the Output node.",
    category: "research",
    nodes: [
      { type: "input", name: "Agenda", x: 0, y: ROW },
      {
        type: "agent",
        name: "Principal Investigator",
        x: COL,
        y: 0,
        refTitle: "Principal Investigator",
      },
      {
        type: "agent",
        name: "Bioinformatician",
        x: COL,
        y: ROW * 2,
        refTitle: "Bioinformatician",
      },
      { type: "meeting", name: "Team Meeting", x: COL * 2, y: ROW },
      { type: "output", name: "Meeting Summary", x: COL * 3, y: ROW },
    ],
    edges: [
      { from: 0, to: 3, fromPort: "text", toPort: "agenda" },
      { from: 1, to: 3, fromPort: "message", toPort: "agents" },
      { from: 2, to: 3, fromPort: "message", toPort: "agents" },
      { from: 3, to: 4, fromPort: "summary", toPort: "value" },
    ],
  },

  // 3. Structure Analysis ----------------------------------------------------
  // Input → BioTool (PDB search) → Agent (Structural Biologist) → Output
  {
    id: "structure-analysis",
    name: "Structure Analysis",
    description:
      "A query flows into a PDB search, whose results are interpreted by a Structural Biologist agent and surfaced in an Output node.",
    category: "analysis",
    nodes: [
      { type: "input", name: "Query", x: 0, y: ROW },
      {
        type: "biotool",
        name: "PDB Search",
        x: COL,
        y: ROW,
        params: { bioKey: "pdb" },
      },
      {
        type: "agent",
        name: "Structural Biologist",
        x: COL * 2,
        y: ROW,
        refTitle: "Structural Biologist",
      },
      { type: "output", name: "Analysis", x: COL * 3, y: ROW },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "query" },
      { from: 1, to: 2, fromPort: "results", toPort: "context" },
      { from: 2, to: 3, fromPort: "message", toPort: "value" },
    ],
  },

  // 4. Deep Research Report --------------------------------------------------
  // Input → Research (connected to 2 Agent nodes: PI + Machine Learning Engineer) → Output
  {
    id: "deep-research-report",
    name: "Deep Research Report",
    description:
      "A 3-phase research pipeline: a PI and a Machine Learning Engineer collaborate on a topic sourced from an Input node. The compiled Markdown report flows to the Output.",
    category: "research",
    nodes: [
      { type: "input", name: "Topic", x: 0, y: ROW },
      {
        type: "agent",
        name: "Principal Investigator",
        x: COL,
        y: 0,
        refTitle: "Principal Investigator",
      },
      {
        type: "agent",
        name: "Machine Learning Engineer",
        x: COL,
        y: ROW * 2,
        refTitle: "Machine Learning Engineer",
      },
      { type: "research", name: "Research Pipeline", x: COL * 2, y: ROW },
      { type: "output", name: "Final Report", x: COL * 3, y: ROW },
    ],
    edges: [
      { from: 0, to: 3, fromPort: "text", toPort: "topic" },
      { from: 1, to: 3, fromPort: "message", toPort: "agents" },
      { from: 2, to: 3, fromPort: "message", toPort: "agents" },
      { from: 3, to: 4, fromPort: "report", toPort: "value" },
    ],
  },
];
