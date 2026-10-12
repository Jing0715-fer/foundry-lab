// Bio skills — the four live bioinformatics queries (BLAST / PDB / PubMed /
// UniProt) wrapped in the skill protocol. runBio keeps its live URL-API
// execution with AbortController timeouts + honest offline fallbacks; the
// skill layer standardizes schema/gate/audit/feedback around it.

import { runBio } from "../bio-tools";
import type { BioResult } from "../bio-tools";
import { registerSkill } from "./registry";
import type { SkillDefinition, SkillOutcome } from "./types";

function summarize(res: BioResult): string {
  const head =
    `${res.tool} returned ${res.count} hit(s)` +
    (res.simulated ? " [offline fallback — live API unreachable]" : "");
  const lines = res.hits.slice(0, 12).map((h) => {
    const meta = h.meta
      ? " " +
        Object.entries(h.meta)
          .slice(0, 3)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      : "";
    return `- ${h.id}: ${h.title}${meta}`;
  });
  const more = res.count > res.hits.length ? `\n… ${res.count - res.hits.length} more` : "";
  return [head, ...lines, more].filter(Boolean).join("\n") + (res.error ? `\n[warning] ${res.error}` : "");
}

interface BioSkillSeed {
  key: "blast" | "pdb" | "pubmed" | "uniprot";
  name: string;
  description: string;
  params: SkillDefinition["params"];
  example: string;
  requiredDocs: string;
}

const SEEDS: BioSkillSeed[] = [
  {
    key: "blast",
    name: "NCBI BLAST",
    description:
      "Sequence homology search against NCBI databases (blastp/blastn/psi-blast) via the live URL API with RID polling.",
    params: [
      { name: "sequence", type: "string", required: true, description: "Query sequence (raw or FASTA)" },
      { name: "program", type: "enum", enumValues: ["blastp", "blastn", "psi-blast"], default: "blastp", description: "BLAST program" },
      { name: "database", type: "string", default: "nr", description: "Target database (nr, swissprot, pdb…)" },
      { name: "expect", type: "number", min: 0, description: "E-value threshold" },
      { name: "maxResults", type: "number", min: 1, max: 100, default: 10, description: "Max hits returned" },
    ],
    example: '{"id": "bio.blast", "params": {"sequence": "MKTAYIAKQRQISFVKSHFSRQ", "program": "blastp"}}',
    requiredDocs: "sequence is required",
  },
  {
    key: "pdb",
    name: "RCSB PDB Search",
    description: "Structural homolog / structure search against the RCSB PDB (live API).",
    params: [
      { name: "query", type: "string", description: "Free-text or sequence search query" },
      { name: "id", type: "string", description: "Direct PDB entry id (e.g. 1ABC)" },
      { name: "maxResults", type: "number", min: 1, max: 100, default: 10, description: "Max entries returned" },
    ],
    example: '{"id": "bio.pdb", "params": {"query": "IL-7 receptor alpha domain"}}',
    requiredDocs: "query or id",
  },
  {
    key: "pubmed",
    name: "PubMed Literature",
    description: "Biomedical literature search via PubMed EUtils (live).",
    params: [
      { name: "query", type: "string", required: true, description: "Search query (MeSH terms welcome)" },
      { name: "maxResults", type: "number", min: 1, max: 50, default: 8, description: "Max papers returned" },
      { name: "sortBy", type: "enum", enumValues: ["relevance", "pub_date"], default: "relevance", description: "Result ordering" },
    ],
    example: '{"id": "bio.pubmed", "params": {"query": "nanobody RBD neutralization"}}',
    requiredDocs: "query is required",
  },
  {
    key: "uniprot",
    name: "UniProt Annotation",
    description: "Protein annotation lookup via the UniProt REST API (live).",
    params: [
      { name: "query", type: "string", description: "Search query" },
      { name: "accession", type: "string", description: "Direct UniProt accession (e.g. P41252)" },
      { name: "maxResults", type: "number", min: 1, max: 100, default: 10, description: "Max entries returned" },
      { name: "reviewed", type: "boolean", default: false, description: "Swiss-Prot (reviewed) entries only" },
    ],
    example: '{"id": "bio.uniprot", "params": {"accession": "Q9N5Z6"}}',
    requiredDocs: "query or accession",
  },
];

for (const s of SEEDS) {
  registerSkill({
    id: `bio.${s.key}`,
    name: s.name,
    category: "bio",
    gate: "tools",
    description: s.description,
    params: s.params,
    // runBio fetches carry their own AbortController timeouts (~10–30s);
    // the skill net sits comfortably above them.
    timeoutMs: 60_000,
    legacy: { fence: "bio", key: s.key },
    exampleLine: () => s.example,
    execute: async (params): Promise<SkillOutcome> => {
      try {
        const res = await runBio(s.key, params);
        return { ok: true, summary: summarize(res) };
      } catch (e) {
        return { ok: false, summary: `${s.name} failed: ${(e as Error).message}` };
      }
    },
  });
}
