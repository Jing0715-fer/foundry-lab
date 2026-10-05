// Bioinformatics API integrations (BLAST / PDB / PubMed / UniProt).
// REAL network calls against the public APIs. On network failure the result
// carries an honest error (never fabricated hits):
//   - BLAST: NCBI BLAST URL API — PUT submit → RID → poll Status → JSON2_S
//     results (the real documented flow, honoring RTOE).
//   - PDB: RCSB search API v2.
//   - PubMed: NCBI EUtils esearch.
//   - UniProt: REST search.

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
  /** Populated when the live call failed — honest error reporting. */
  error?: string;
}
export interface BioHit {
  id: string;
  title: string;
  meta?: Record<string, string | number>;
}

async function safeFetchJson(url: string, timeoutMs = 10000): Promise<unknown | null> {
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

async function safeFetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { ...(init.headers ?? {}) },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── BLAST: the REAL NCBI URL-API flow ───────────────────────────────────────

const BLAST_BASE = "https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi";

/** Submit a BLAST job; returns the RID (and recommended wait in seconds). */
async function blastPut(
  p: BioBlastParams,
  max: number,
): Promise<{ rid: string; rtoe: number } | null> {
  const body = new URLSearchParams({
    CMD: "Put",
    PROGRAM: p.program ?? "blastp",
    DATABASE: p.database ?? "swissprot",
    QUERY: p.sequence.slice(0, 4000),
    HITLIST_SIZE: String(max),
    FORMAT_TYPE: "JSON2_S",
    ...(p.expect !== undefined ? { EXPECT: String(p.expect) } : {}),
  });
  const text = await safeFetchText(
    BLAST_BASE,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "FoundryLab/1.0 (research workflow studio)",
      },
      body: body.toString(),
    },
    20000,
  );
  if (!text) return null;
  const rid = text.match(/RID\s*=\s*(\S+)/)?.[1];
  const rtoe = Number(text.match(/RTOE\s*=\s*(\d+)/)?.[1] ?? 30);
  return rid ? { rid, rtoe: Math.min(90, Math.max(10, rtoe)) } : null;
}

/** Poll the RID until the search finishes (Waiting → SUCCESS/FAILED/UNKNOWN). */
async function blastPollRid(
  rid: string,
  rtoe: number,
  totalTimeoutMs = 110000,
): Promise<"SUCCESS" | "FAILED" | "UNKNOWN" | "TIMEOUT"> {
  const deadline = Date.now() + totalTimeoutMs;
  // Respect RTOE before the first poll.
  await new Promise((r) => setTimeout(r, rtoe * 1000));
  while (Date.now() < deadline) {
    const text = await safeFetchText(
      `${BLAST_BASE}?CMD=Get&FORMAT_OBJECT=SearchInfo&RID=${encodeURIComponent(rid)}`,
      {},
      15000,
    );
    if (text) {
      const status = text.match(/Status\s*=\s*(\w+)/)?.[1];
      if (status === "SUCCESS") return "SUCCESS";
      if (status === "FAILED") return "FAILED";
      if (status === "UNKNOWN") return "UNKNOWN";
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return "TIMEOUT";
}

interface BlastJson2Hit {
  accession?: string;
  title?: string;
  hsps?: { evalue?: number; identity?: number; query_cov?: number }[];
  description?: { title?: string }[];
}

/** Fetch + parse the JSON2_S results for a finished RID. */
async function blastGetHits(
  rid: string,
  max: number,
): Promise<BioHit[] | null> {
  const data = (await safeFetchJson(
    `${BLAST_BASE}?CMD=Get&FORMAT_TYPE=JSON2_S&RID=${encodeURIComponent(rid)}`,
    20000,
  )) as
    | { BlastJSON2Output?: { report?: { results?: { search?: { hits?: BlastJson2Hit[] } }[] }[] } }
    | null;
  if (!data) return null;
  const hitsRaw =
    data.BlastJSON2Output?.[0]?.report?.results?.[0]?.search?.hits ?? [];
  const hits: BioHit[] = hitsRaw.slice(0, max).map((h) => {
    const hsp = h.hsps?.[0];
    return {
      id: h.accession ?? "?",
      title: h.title ?? h.description?.[0]?.title ?? "BLAST hit",
      meta: {
        ...(hsp?.evalue !== undefined ? { evalue: hsp.evalue } : {}),
        ...(hsp?.identity !== undefined ? { identity: hsp.identity } : {}),
        ...(hsp?.query_cov !== undefined ? { coverage: hsp.query_cov } : {}),
      },
    };
  });
  return hits;
}

export async function runBlast(p: BioBlastParams): Promise<BioResult> {
  const program = p.program ?? "blastp";
  const db = p.database ?? "swissprot";
  const max = Math.min(p.maxResults ?? 5, 10);
  const seq = (p.sequence ?? "").trim();
  if (!seq) {
    return {
      tool: "blast", count: 0, hits: [], simulated: false,
      error: "No query sequence supplied.",
    };
  }
  // Real NCBI BLAST URL API flow: Put → RID → poll → JSON results.
  const put = await blastPut(p, max);
  if (!put) {
    return {
      tool: "blast", count: 0, hits: [], simulated: false,
      error:
        "Could not submit the BLAST job to NCBI (network blocked or " +
        "rate-limited). The search ran against the live NCBI service — " +
        "retry in a moment.",
    };
  }
  const status = await blastPollRid(put.rid, put.rtoe);
  if (status !== "SUCCESS") {
    const reason =
      status === "TIMEOUT"
        ? "NCBI BLAST did not finish within the polling window."
        : `NCBI BLAST search status: ${status}.`;
    return {
      tool: "blast", count: 0, hits: [], simulated: false,
      error: reason,
    };
  }
  const hits = await blastGetHits(put.rid, max);
  if (!hits) {
    return {
      tool: "blast", count: 0, hits: [], simulated: false,
      error: "BLAST finished but the result fetch failed.",
    };
  }
  return {
    tool: "blast", count: hits.length, hits, simulated: false,
  };
}

// ── PDB (RCSB search API v2) ────────────────────────────────────────────────

export async function runPdb(p: BioPdbParams): Promise<BioResult> {
  const max = Math.min(p.maxResults ?? 5, 10);
  const q = p.id ? `${p.id.toUpperCase()}` : p.query ?? "antibody";
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
    const hits: BioHit[] = rs.map((r) => ({
      id: r.id,
      title: `PDB entry ${r.id}`,
    }));
    return { tool: "pdb", count: hits.length, hits, raw: data, simulated: false };
  }
  return {
    tool: "pdb", count: 0, hits: [], simulated: false,
    error: "RCSB search API unreachable — no results returned.",
  };
}

// ── PubMed (NCBI EUtils) ────────────────────────────────────────────────────

export async function runPubmed(p: BioPubmedParams): Promise<BioResult> {
  const max = Math.min(p.maxResults ?? 5, 10);
  // Guard: without a query we'd otherwise search NCBI for the literal string
  // "undefined" and return junk hits — throw so the upstream catch turns this
  // into an honest failure.
  const term = (p.query ?? "").trim();
  if (!term) {
    throw new Error(
      "PubMed search requires a non-empty 'query' parameter (got: " +
        `${JSON.stringify(p.query) ?? "undefined"}).`,
    );
  }
  const url =
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json` +
    `&retmax=${max}&term=${encodeURIComponent(term)}` +
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
  return {
    tool: "pubmed", count: 0, hits: [], simulated: false,
    error: "NCBI EUtils unreachable — no results returned.",
  };
}

// ── UniProt REST ────────────────────────────────────────────────────────────

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
  return {
    tool: "uniprot", count: 0, hits: [], simulated: false,
    error: "UniProt REST API unreachable — no results returned.",
  };
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
    "- blast: NCBI BLAST sequence homology search (live URL-API with RID polling)",
    "- pdb: RCSB PDB structure search (live API)",
    "- pubmed: PubMed literature search (live EUtils)",
    "- uniprot: UniProt protein annotation search (live REST)",
  ].join("\n");
}
