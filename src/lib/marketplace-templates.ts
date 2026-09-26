// Marketplace template definitions — community-curated workflow templates
// surfaced through the "Template Marketplace" dialog.
//
// Each template carries a community-style metadata envelope (author, stars,
// downloads, tags, category) plus the same nodes/edges payload shape used by
// the built-in WORKFLOW_TEMPLATES loader in @/lib/workflow-template-defs.ts.
//
// When the user clicks "Install" in the marketplace, the loader:
//   1. Resolves any `refTitle` → real agent ID via GET /api/agents.
//   2. DELETEs every existing node in the current workflow (cascades edges).
//   3. POSTs each template node, capturing the returned real IDs.
//   4. POSTs each template edge using the real node IDs (non-fatal on
//      duplicate/cycle errors — user can fix in the canvas).
//   5. Refreshes the workflow from the server + switches to the Canvas panel.

export type MarketplaceCategory =
  | "research"
  | "design"
  | "analysis"
  | "education"
  | "production";

export interface MarketplaceTemplateNode {
  type: string;
  name: string;
  x: number;
  y: number;
  /** If set, the loader resolves this title → an existing agent's ID. */
  refTitle?: string;
  /** Optional node params (e.g. comptool.toolKey, biotool.bioKey, input.text). */
  params?: Record<string, unknown>;
}

export interface MarketplaceTemplateEdge {
  /** Index into the template's `nodes[]` array. */
  from: number;
  /** Index into the template's `nodes[]` array. */
  to: number;
  fromPort?: string;
  toPort?: string;
}

export interface MarketplaceTemplate {
  id: string;
  name: string;
  description: string;
  author: string;
  category: MarketplaceCategory;
  tags: string[];
  stars: number;
  downloads: number;
  nodes: MarketplaceTemplateNode[];
  edges: MarketplaceTemplateEdge[];
}

export const MARKETPLACE_TEMPLATES: MarketplaceTemplate[] = [
  {
    id: "mp-antibody-design",
    name: "Antibody Design Pipeline",
    description:
      "Complete antibody design workflow: target analysis → RFantibody design → ProteinMPNN sequence → Rosetta refinement.",
    author: "BioDesign Labs",
    category: "design",
    tags: ["antibody", "rfdiffusion", "proteinmpnn", "rosetta"],
    stars: 42,
    downloads: 128,
    nodes: [
      { type: "input", name: "Target PDB", x: 80, y: 120, params: { text: "Target antigen structure" } },
      { type: "agent", name: "Immunologist", x: 400, y: 120, refTitle: "Immunologist" },
      { type: "comptool", name: "RFantibody", x: 720, y: 120, params: { toolKey: "rfantibody" } },
      { type: "comptool", name: "ProteinMPNN", x: 1040, y: 120, params: { toolKey: "proteinmpnn" } },
      { type: "output", name: "Designed Antibody", x: 1360, y: 120 },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "context" },
      { from: 1, to: 2, fromPort: "message", toPort: "input" },
      { from: 2, to: 3, fromPort: "files", toPort: "input" },
      { from: 3, to: 4, fromPort: "summary", toPort: "value" },
    ],
  },
  {
    id: "mp-literature-review",
    name: "Literature Review Pipeline",
    description:
      "Automated literature review: PubMed search → Bioinformatician analysis → Research report compilation.",
    author: "ResearchBot Inc",
    category: "research",
    tags: ["pubmed", "literature", "research", "bioinformatics"],
    stars: 31,
    downloads: 89,
    nodes: [
      { type: "input", name: "Research Topic", x: 80, y: 120, params: { text: "CRISPR gene editing" } },
      { type: "biotool", name: "PubMed Search", x: 400, y: 120, params: { bioKey: "pubmed" } },
      { type: "agent", name: "Bioinformatician", x: 720, y: 120, refTitle: "Bioinformatician" },
      { type: "research", name: "Literature Report", x: 1040, y: 120, refTitle: "Bioinformatician" },
      { type: "output", name: "Review Report", x: 1360, y: 120 },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "query" },
      { from: 1, to: 2, fromPort: "results", toPort: "context" },
      { from: 2, to: 3, fromPort: "message", toPort: "agents" },
      { from: 3, to: 4, fromPort: "report", toPort: "value" },
    ],
  },
  {
    id: "mp-structure-prediction",
    name: "Structure Prediction Pipeline",
    description:
      "Protein structure prediction: sequence input → BLAST homolog search → structural analysis → report.",
    author: "StructLab",
    category: "analysis",
    tags: ["blast", "pdb", "structure", "prediction"],
    stars: 27,
    downloads: 76,
    nodes: [
      { type: "input", name: "Sequence", x: 80, y: 120, params: { text: "MTAIKE..." } },
      { type: "biotool", name: "BLAST Search", x: 400, y: 120, params: { bioKey: "blast" } },
      { type: "biotool", name: "PDB Search", x: 720, y: 120, params: { bioKey: "pdb" } },
      { type: "agent", name: "Structural Biologist", x: 1040, y: 120, refTitle: "Structural Biologist" },
      { type: "output", name: "Analysis Report", x: 1360, y: 120 },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "query" },
      { from: 1, to: 2, fromPort: "results", toPort: "query" },
      { from: 2, to: 3, fromPort: "results", toPort: "context" },
      { from: 3, to: 4, fromPort: "message", toPort: "value" },
    ],
  },
  {
    id: "mp-team-debate",
    name: "Multi-Agent Team Debate",
    description:
      "Full team debate: PI leads, Computational Biologist + Bioinformatician discuss, structured summary output.",
    author: "DebateMaster",
    category: "research",
    tags: ["meeting", "team", "debate", "multi-agent"],
    stars: 19,
    downloads: 54,
    nodes: [
      { type: "input", name: "Agenda", x: 80, y: 120, params: { text: "Design a novel enzyme" } },
      { type: "meeting", name: "Team Meeting", x: 400, y: 120, refTitle: "Principal Investigator" },
      { type: "output", name: "Meeting Summary", x: 720, y: 120 },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "agenda" },
      { from: 1, to: 2, fromPort: "summary", toPort: "value" },
    ],
  },
  {
    id: "mp-education-tutorial",
    name: "Education: Protein Basics",
    description:
      "Interactive tutorial: input question → agent explains → comp tool demo → output summary.",
    author: "EduLab",
    category: "education",
    tags: ["education", "tutorial", "beginner"],
    stars: 15,
    downloads: 42,
    nodes: [
      { type: "input", name: "Question", x: 80, y: 120, params: { text: "What is protein folding?" } },
      { type: "agent", name: "PI Tutor", x: 400, y: 120, refTitle: "Principal Investigator" },
      { type: "comptool", name: "RFdiffusion Demo", x: 720, y: 120, params: { toolKey: "rfdiffusion" } },
      { type: "output", name: "Tutorial Output", x: 1040, y: 120 },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "context" },
      { from: 1, to: 2, fromPort: "message", toPort: "input" },
      { from: 2, to: 3, fromPort: "summary", toPort: "value" },
    ],
  },
  {
    id: "mp-production-qa",
    name: "Production QA Pipeline",
    description:
      "Quality assurance: input → multi-tool validation → structural check → QA report.",
    author: "QAPro",
    category: "production",
    tags: ["qa", "validation", "production", "quality"],
    stars: 8,
    downloads: 23,
    nodes: [
      { type: "input", name: "Design Input", x: 80, y: 120, params: { text: "Designed protein" } },
      { type: "comptool", name: "Rosetta Check", x: 400, y: 120, params: { toolKey: "rosetta" } },
      { type: "biotool", name: "PDB Validation", x: 720, y: 120, params: { bioKey: "pdb" } },
      { type: "agent", name: "QA Reviewer", x: 1040, y: 120, refTitle: "Scientific Critic" },
      { type: "output", name: "QA Report", x: 1360, y: 120 },
    ],
    edges: [
      { from: 0, to: 1, fromPort: "text", toPort: "input" },
      { from: 1, to: 2, fromPort: "files", toPort: "query" },
      { from: 2, to: 3, fromPort: "results", toPort: "context" },
      { from: 3, to: 4, fromPort: "message", toPort: "value" },
    ],
  },
];
