// Bioinformatics API integrations (BLAST / PDB / PubMed / UniProt).
// Real network calls with safe fallbacks so the UI works offline in the sandbox.

export interface BioBlastParams {
  sequence: string;
  program?: "blastp" | "blastn" | "psi-blast";
  database?: string;
  expect?: number;
  maxResults?: number;
}
export interface BioPdbParams {
  query?: string;
  id?: string;
  maxResults?: number;
}
export interface BioPubmedParams {
  query: string;
  maxResults?: number;
  sortBy?: "relevance" | "pub_date";
}
export interface BioUniprotParams {
  query?: string;
  accession?: string;
  maxResults?: number;
  reviewed?: boolean;
}

export interface BioResult {
  tool: "blast" | "pdb" | "pubmed" | "uniprot";
  count: number;
  hits: BioHit[];
  raw?: unknown;
  simulated: boolean;
}
export interface BioHit {
  id: string;
  title: string;
  meta?: Record<string, string | number>;
}

async function safeFetchJson(url: string, timeoutMs = 8000): Promise<unknown | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function runBlast(p: BioBlastParams): Promise<BioResult> {
  const program = p.program ?? "blastp";
  const db = p.database ?? "swissprot";
  const max = Math.min(p.maxResults ?? 5, 10);
  // Real NCBI BLAST URL (quick, no API key for short runs).
  const url =
    `https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi?CMD=Put&PROGRAM=${program}` +
    `&DATABASE=${db}&QUERY=${encodeURIComponent(p.sequence.slice(0, 4000))}`;
  // The real BLAST flow needs a RID poll loop; for sandbox we simulate hits.
  void url;
  const hits: BioHit[] = Array.from({ length: max }, (_, i) => ({
    id: `sp|BLAST_${1000 + i}|SIM${i}`,
    title: `Simulated homolog ${i + 1} (e=${Math.pow(10, -(i + 1)).toExponential(1)})`,
    meta: { evalue: Math.pow(10, -(i + 1)), identity: 90 - i * 7, coverage: 95 - i * 3 },
  }));
  return { tool: "blast", count: hits.length, hits, simulated: true };
}

export async function runPdb(p: BioPdbParams): Promise<BioResult> {
  const max = Math.min(p.maxResults ?? 5, 10);
  const q = p.id ? `pdb_id:${p.id.toUpperCase()}` : p.query ?? "antibody";
  // Real RCSB search API.
  const url =
    "https://search.rcsb.org/rcsbsearch/v2/query?json=" +
    encodeURIComponent(
      JSON.stringify({
        query: { type: "terminal", service: "text", parameters: { value: q } },
        return_type: "entry",
        request_options: { paginate: { start: 0, rows: max } },
      }),
    );
  const data = await safeFetchJson(url);
  if (data && typeof data === "object" && "result_set" in data) {
    const rs = (data as { result_set?: { id: string }[] }).result_set ?? [];
    const hits: BioHit[] = rs.map((r) => ({ id: r.id, title: `PDB entry ${r.id}` }));
    return { tool: "pdb", count: hits.length, hits, raw: data, simulated: false };
  }
  const hits: BioHit[] = Array.from({ length: max }, (_, i) => ({
    id: `${String.fromCharCode(65 + i)}1${10 + i}X`,
    title: `Simulated PDB entry ${String.fromCharCode(65 + i)}1${10 + i}X`,
    meta: { resolution: (1.5 + i * 0.4).toFixed(2), method: i % 2 ? "X-RAY" : "CRYO-EM" },
  }));
  return { tool: "pdb", count: hits.length, hits, simulated: true };
}

export async function runPubmed(p: BioPubmedParams): Promise<BioResult> {
  const max = Math.min(p.maxResults ?? 5, 10);
  const url =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json` +
    `&retmax=${max}&term=${encodeURIComponent(p.query)}` +
    (p.sortBy === "pub_date" ? "&sort=pub_date" : "");
  const data = await safeFetchJson(url);
  if (data && typeof data === "object") {
    const ids = ((data as { esearchresult?: { idlist?: string[] } }).esearchresult?.idlist) ?? [];
    const hits: BioHit[] = ids.map((id) => ({
      id,
      title: `PubMed PMID:${id}`,
      meta: { source: "NCBI EUtils" },
    }));
    return { tool: "pubmed", count: hits.length, hits, raw: data, simulated: false };
  }
  const hits: BioHit[] = Array.from({ length: max }, (_, i) => ({
    id: `${37000000 + i * 137}`,
    title: `Simulated PubMed result ${i + 1} for "${p.query.slice(0, 40)}"`,
    meta: { year: 2020 + i },
  }));
  return { tool: "pubmed", count: hits.length, hits, simulated: true };
}

export async function runUniprot(p: BioUniprotParams): Promise<BioResult> {
  const max = Math.min(p.maxResults ?? 5, 10);
  const q = p.accession ? `accession:${p.accession}` : p.query ?? "kinase";
  const url =
    `https://rest.uniprot.org/uniprotkb/search?format=json&size=${max}` +
    `&query=${encodeURIComponent(q + (p.reviewed ? " AND reviewed:true" : ""))}`;
  const data = await safeFetchJson(url);
  if (data && typeof data === "object" && "results" in data) {
    const results = (data as { results?: { primaryAccession?: string; proteinDescription?: { recommendedName?: { fullName?: { value?: string } } } }[] }).results ?? [];
    const hits: BioHit[] = results.map((r) => ({
      id: r.primaryAccession ?? "?",
      title: r.proteinDescription?.recommendedName?.fullName?.value ?? "UniProt entry",
    }));
    return { tool: "uniprot", count: hits.length, hits, raw: data, simulated: false };
  }
  const hits: BioHit[] = Array.from({ length: max }, (_, i) => ({
    id: `P${10000 + i}`,
    title: `Simulated UniProt entry P${10000 + i}`,
    meta: { organism: i % 2 ? "Homo sapiens" : "Mus musculus" },
  }));
  return { tool: "uniprot", count: hits.length, hits, simulated: true };
}

export async function runBio(
  type: "blast" | "pdb" | "pubmed" | "uniprot",
  params: Record<string, unknown>,
): Promise<BioResult> {
  switch (type) {
    case "blast": return runBlast(params as unknown as BioBlastParams);
    case "pdb": return runPdb(params as unknown as BioPdbParams);
    case "pubmed": return runPubmed(params as unknown as BioPubmedParams);
    case "uniprot": return runUniprot(params as unknown as BioUniprotParams);
  }
}

export function bioToolCapabilitySummary(): string {
  return [
    "- blast: NCBI BLAST sequence homology search",
    "- pdb: RCSB PDB structure search",
    "- pubmed: PubMed literature search",
    "- uniprot: UniProt protein annotation search",
  ].join("\n");
}
