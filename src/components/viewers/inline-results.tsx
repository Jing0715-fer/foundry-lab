"use client";

/**
 * InlineResults — a compact, self-contained output-results view that renders
 * DIRECTLY inside a panel (the canvas inspector's Result tab) instead of
 * requiring a dialog click-through.
 *
 * Layout (top to bottom):
 *  1. Provenance header — executor badge (REAL · NATIVE / REAL · ENGINE),
 *     file count, "open full viewer" affordance.
 *  2. Output file list — one row per real artifact with a type icon, basename,
 *     size (fetched via ?meta=1), and a download button. Clicking a row selects
 *     it for the inline preview.
 *  3. Inline preview of the selected file:
 *       .pdb   → three.js 3D structure viewer (cartoon / ball-stick / sphere)
 *       .fasta → per-residue colored sequence viewer
 *       .json  → metric cards when the JSON is a flat number/string map
 *                (e.g. metrics.json), pretty-printed source otherwise
 *       .csv   → rendered table
 *       images → <img>
 *       other  → monospace text preview (truncated with "show all")
 *  4. Run summary (markdown) in a collapsible section.
 */

import * as React from "react";
import {
  Box,
  Dna,
  Braces,
  Table as TableIcon,
  ImageIcon,
  FileText,
  Download,
  Copy,
  Check,
  ExternalLink,
  Loader2,
  Maximize2,
  ChevronDown,
  ChevronRight,
  FileWarning,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import ReactMarkdown from "react-markdown";
import { Pdb3DViewer } from "./pdb-3d-viewer";
import { FastaViewer } from "./fasta-viewer";

// --- Types ---------------------------------------------------------------------

export type ResultExecutor = "native" | "builtin-engine" | "legacy-simulated";

export interface InlineResultsProps {
  /** Real output file paths (absolute or outputs/-relative). */
  files: string[];
  /** Builds the fetch URL for a file (node mode vs job mode differ). */
  fileUrl: (path: string) => string;
  /** Executor provenance for the badge. */
  executor?: ResultExecutor;
  /** Opens the full-screen OutputViewerDialog. */
  onOpenFullViewer?: () => void;
  /** Markdown run summary rendered in a collapsible section. */
  summary?: string | null;
  /** Tighter paddings for narrow hosts (the 320px inspector). */
  compact?: boolean;
}

interface FileMeta {
  name: string;
  ext: string;
  size: number;
  modified: number;
}

type PreviewKind = "pdb" | "fasta" | "json" | "table" | "image" | "text";

// --- Helpers ---------------------------------------------------------------------

function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const idx = base.lastIndexOf(".");
  return idx === -1 ? "" : base.slice(idx + 1).toLowerCase();
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirName(path: string): string {
  const parts = path.split("/");
  parts.pop();
  const dir = parts.join("/");
  return dir.length > 26 ? `…${dir.slice(-25)}` : dir;
}

function previewKindOf(ext: string): PreviewKind {
  if (ext === "pdb" || ext === "ent") return "pdb";
  if (ext === "fasta" || ext === "fa" || ext === "aln") return "fasta";
  if (ext === "json") return "json";
  if (ext === "csv" || ext === "tsv") return "table";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  return "text";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pick the most interesting file to preview first. */
function pickDefault(files: string[]): string | null {
  const byKind = (k: PreviewKind) => files.find((f) => previewKindOf(extOf(f)) === k);
  return (
    byKind("pdb") ?? byKind("fasta") ?? byKind("json") ?? byKind("table") ?? byKind("image") ?? files[0] ?? null
  );
}

function TypeIcon({ ext, className }: { ext: string; className?: string }) {
  switch (previewKindOf(ext)) {
    case "pdb":
      return <Box className={className} />;
    case "fasta":
      return <Dna className={className} />;
    case "json":
      return <Braces className={className} />;
    case "table":
      return <TableIcon className={className} />;
    case "image":
      return <ImageIcon className={className} />;
    default:
      return <FileText className={className} />;
  }
}

// --- JSON preview ----------------------------------------------------------------

type PrimitiveMap = Record<string, string | number | boolean>;

/** True when the parsed JSON is a small flat primitive map → metric cards. */
function isMetricMap(parsed: unknown): parsed is PrimitiveMap {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 40) return false;
  return entries.every(
    ([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean",
  );
}

/** An array of flat primitive maps — e.g. per-design metrics rows. */
function isMetricRows(parsed: unknown): parsed is PrimitiveMap[] {
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 200) return false;
  return parsed.every(
    (item) =>
      typeof item === "object" && item !== null && !Array.isArray(item) &&
      Object.values(item as Record<string, unknown>).every(
        (v) => typeof v === "number" || typeof v === "string" || typeof v === "boolean",
      ),
  );
}

interface UnwrappedRows {
  caption?: string;
  scalars: PrimitiveMap;
  rows: PrimitiveMap[];
}

/** Recognize {"designs": [ {...}, ... ]} — one array-of-rows key (plus
 *  optional scalar side-entries) — and unwrap it into a metrics table. */
function unwrapRowsObject(parsed: unknown): UnwrappedRows | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 6) return null;
  const arrayEntries = entries.filter(([, v]) => isMetricRows(v));
  if (arrayEntries.length !== 1) return null;
  const scalars: PrimitiveMap = {};
  for (const [k, v] of entries) {
    if (arrayEntries[0][0] === k) continue;
    if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
      scalars[k] = v;
    } else {
      return null; // nested non-row structure — fall back to raw
    }
  }
  return {
    caption: arrayEntries[0][0],
    scalars,
    rows: arrayEntries[0][1] as PrimitiveMap[],
  };
}

function prettifyKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}

function formatMetricValue(v: string | number | boolean): string {
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toLocaleString();
    if (Math.abs(v) >= 0.01 && Math.abs(v) < 1000) return v.toFixed(3);
    return v.toExponential(2);
  }
  return String(v);
}

/** Compact metrics table for arrays of flat maps (one row per design/sample). */
function MetricsTable({ rows }: { rows: PrimitiveMap[] }) {
  const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 12);
  return (
    <div className="max-h-64 overflow-auto rounded-md border">
      <table className="w-full text-left font-mono text-[11px]">
        <thead className="sticky top-0 bg-muted">
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="whitespace-nowrap border-b px-2 py-1.5 font-semibold"
                title={col}
              >
                {prettifyKey(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="odd:bg-muted/20">
              {columns.map((col) => (
                <td key={col} className="whitespace-nowrap px-2 py-1 tabular-nums">
                  {row[col] !== undefined ? formatMetricValue(row[col]) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JsonPreview({ text }: { text: string }) {
  const [showRaw, setShowRaw] = React.useState(false);
  let parsed: unknown = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
  }

  if (parseError || parsed === null) {
    return (
      <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {text}
      </pre>
    );
  }

  // Array of metric rows (e.g. per-design metrics) → table.
  if (isMetricRows(parsed)) {
    return (
      <div className="space-y-2">
        <MetricsTable rows={parsed} />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center text-[11px]"
          onClick={() => setShowRaw((s) => !s)}
          type="button"
        >
          {showRaw ? "Hide raw JSON" : "Show raw JSON"}
        </Button>
        {showRaw && <RawJson parsed={parsed} />}
      </div>
    );
  }

  // {"designs": [ …rows… ], …scalars } → caption + scalar chips + table.
  const unwrapped = unwrapRowsObject(parsed);
  if (unwrapped) {
    const scalarEntries = Object.entries(unwrapped.scalars);
    return (
      <div className="space-y-2">
        {scalarEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {scalarEntries.map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-2 py-1 font-mono text-[10px]"
                title={`${k} = ${formatMetricValue(v)}`}
              >
                <span className="text-muted-foreground">{prettifyKey(k)}</span>
                <span className="font-semibold tabular-nums">{formatMetricValue(v)}</span>
              </span>
            ))}
          </div>
        )}
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {prettifyKey(unwrapped.caption ?? "rows")} · {unwrapped.rows.length} rows
        </p>
        <MetricsTable rows={unwrapped.rows} />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center text-[11px]"
          onClick={() => setShowRaw((s) => !s)}
          type="button"
        >
          {showRaw ? "Hide raw JSON" : "Show raw JSON"}
        </Button>
        {showRaw && <RawJson parsed={parsed} />}
      </div>
    );
  }

  // Flat primitive map → metric cards.
  if (isMetricMap(parsed)) {
    const entries = Object.entries(parsed);
    return (
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-1.5">
          {entries.map(([key, value]) => (
            <div
              key={key}
              className="rounded-md border bg-muted/30 px-2.5 py-2"
              title={`${key} = ${formatMetricValue(value)}`}
            >
              <p className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {prettifyKey(key)}
              </p>
              <p className="truncate font-mono text-sm font-semibold tabular-nums">
                {formatMetricValue(value)}
              </p>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center text-[11px]"
          onClick={() => setShowRaw((s) => !s)}
          type="button"
        >
          {showRaw ? "Hide raw JSON" : "Show raw JSON"}
        </Button>
        {showRaw && <RawJson parsed={parsed} />}
      </div>
    );
  }

  return <RawJson parsed={parsed} />;
}

function RawJson({ parsed }: { parsed: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
      {JSON.stringify(parsed, null, 2)}
    </pre>
  );
}

// --- CSV/TSV preview ----------------------------------------------------------------

function TablePreview({ text, ext }: { text: string; ext: string }) {
  const rows = React.useMemo(() => {
    const delimiter = ext === "tsv" ? "\t" : ",";
    return text
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .slice(0, 100)
      .map((l) => l.split(delimiter).slice(0, 20));
  }, [text, ext]);
  const truncatedRows = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length > 100;

  if (rows.length === 0) {
    return <p className="p-3 text-center text-xs text-muted-foreground">Empty table.</p>;
  }
  return (
    <div className="space-y-1.5">
      <div className="max-h-80 overflow-auto rounded-md border">
        <table className="w-full text-left font-mono text-[11px]">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {rows[0].map((cell, i) => (
                <th key={i} className="whitespace-nowrap border-b px-2 py-1.5 font-semibold">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((row, r) => (
              <tr key={r} className="odd:bg-muted/20">
                {row.map((cell, c) => (
                  <td key={c} className="whitespace-nowrap px-2 py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncatedRows && (
        <p className="text-[10px] text-muted-foreground">Showing the first 100 rows.</p>
      )}
    </div>
  );
}

// --- Text preview ----------------------------------------------------------------

const TEXT_PREVIEW_LIMIT = 10_000;

function TextPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const truncated = !expanded && text.length > TEXT_PREVIEW_LIMIT;
  const body = truncated ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}\n…` : text;
  return (
    <div className="space-y-1.5">
      <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
        {body}
      </pre>
      {text.length > TEXT_PREVIEW_LIMIT && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center text-[11px]"
          onClick={() => setExpanded((e) => !e)}
          type="button"
        >
          {expanded ? "Collapse" : `Show all ${text.length.toLocaleString()} chars`}
        </Button>
      )}
    </div>
  );
}

// --- File preview (selected file) ----------------------------------------------------

function FilePreview({
  path,
  fileUrl,
  compact,
}: {
  path: string;
  fileUrl: (path: string) => string;
  compact: boolean;
}) {
  const ext = extOf(path);
  const kind = previewKindOf(ext);
  const [text, setText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (kind === "image") return; // rendered straight from the URL
    let cancelled = false;
    const controller = new AbortController();
    setText(null);
    setError(null);
    fetch(fileUrl(path), { signal: controller.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e) => {
        if (!cancelled && e instanceof Error && e.name !== "AbortError") {
          setError(e.message);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [path, kind, fileUrl]);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
        <FileWarning className="size-4 shrink-0" />
        <span>Failed to load file: {error}</span>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <img
        src={fileUrl(path)}
        alt={baseName(path)}
        className="max-h-96 w-full rounded-md border bg-muted/30 object-contain"
      />
    );
  }

  if (text === null) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 rounded-md border border-dashed bg-muted/30 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading {baseName(path)}…
      </div>
    );
  }

  switch (kind) {
    case "pdb":
      return (
        <Pdb3DViewer
          pdbText={text}
          className={cn("overflow-hidden rounded-lg border", compact ? "h-72" : "h-96")}
        />
      );
    case "fasta":
      return (
        <div className="max-h-96 overflow-y-auto pr-0.5">
          <FastaViewer fastaText={text} />
        </div>
      );
    case "json":
      return <JsonPreview text={text} />;
    case "table":
      return <TablePreview text={text} ext={ext} />;
    default:
      return <TextPreview text={text} />;
  }
}

// --- Main component --------------------------------------------------------------------

export function InlineResults({
  files,
  fileUrl,
  executor = "builtin-engine",
  onOpenFullViewer,
  summary,
  compact = false,
}: InlineResultsProps) {
  const [selected, setSelected] = React.useState<string | null>(() => pickDefault(files));
  const [metas, setMetas] = React.useState<Record<string, FileMeta>>({});
  const [copied, setCopied] = React.useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = React.useState(false);

  // Re-pick the default selection whenever the file set changes (e.g. a new
  // run lands while the tab is open) — unless the user already selected a
  // file that still exists.
  React.useEffect(() => {
    setSelected((cur) => (cur && files.includes(cur) ? cur : pickDefault(files)));
  }, [files]);

  // Fetch size/mtime metadata for every output file (parallel, best-effort).
  React.useEffect(() => {
    let cancelled = false;
    files.forEach((f) => {
      const sep = fileUrl(f).includes("?") ? "&" : "?";
      fetch(`${fileUrl(f)}${sep}meta=1`)
        .then((r) => (r.ok ? r.json() : null))
        .then((m: FileMeta | null) => {
          if (!cancelled && m && typeof m.size === "number") {
            setMetas((prev) => ({ ...prev, [f]: m }));
          }
        })
        .catch(() => {
          /* meta is best-effort */
        });
    });
    return () => {
      cancelled = true;
    };
  }, [files, fileUrl]);

  const handleCopy = async (path: string) => {
    try {
      await navigator.clipboard?.writeText(path);
      setCopied(path);
      setTimeout(() => setCopied((c) => (c === path ? null : c)), 1500);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  const pad = compact ? "p-2" : "p-3";
  const selectedMeta = selected ? metas[selected] : undefined;

  return (
    <div className={cn("flex flex-col gap-2.5", pad)}>
      {/* Provenance header */}
      <div className="flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={
            executor === "legacy-simulated"
              ? "border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-400"
              : "border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-700 dark:text-emerald-400"
          }
          title={
            executor === "native"
              ? "Ran the native upstream tool installed on this host"
              : executor === "builtin-engine"
                ? "Ran the built-in real algorithm engine (knowledge-based science)"
                : "Legacy run (from the pre-real-algorithm era of this app)"
          }
        >
          {executor === "legacy-simulated" ? "LEGACY" : executor === "native" ? "REAL · NATIVE" : "REAL · ENGINE"}
        </Badge>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {files.length} output file{files.length === 1 ? "" : "s"}
        </p>
        {onOpenFullViewer && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 gap-1 px-2 text-[11px]"
            onClick={onOpenFullViewer}
            type="button"
          >
            <Maximize2 className="size-3" />
            Viewer
          </Button>
        )}
      </div>

      {/* File list */}
      <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-0.5">
        {files.map((f, i) => {
          const meta = metas[f];
          const isSel = selected === f;
          return (
            <li key={`${f}-${i}`}>
              <div
                role="button"
                tabIndex={0}
                aria-pressed={isSel}
                onClick={() => setSelected(f)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(f);
                  }
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isSel
                    ? "border-primary/50 bg-primary/5"
                    : "border-border bg-muted/30 hover:bg-muted/60",
                )}
              >
                <TypeIcon
                  ext={meta?.ext ?? extOf(f)}
                  className={cn("size-4 shrink-0", isSel ? "text-primary" : "text-muted-foreground")}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-foreground">
                    {baseName(f)}
                  </span>
                  {dirName(f) && (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {dirName(f)}
                    </span>
                  )}
                </span>
                {meta && (
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {formatBytes(meta.size)}
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Copy path"
                  title="Copy path"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCopy(f);
                  }}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {copied === f ? (
                    <Check className="size-3 text-emerald-500" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
                <a
                  href={fileUrl(f)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Download ${baseName(f)}`}
                  title="Download"
                  onClick={(e) => e.stopPropagation()}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Download className="size-3" />
                </a>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Inline preview of the selected file */}
      {selected && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <TypeIcon ext={extOf(selected)} className="size-3.5 shrink-0" />
            <code className="truncate font-mono">{baseName(selected)}</code>
            {selectedMeta && (
              <span className="shrink-0 font-mono text-[10px] tabular-nums">
                {formatBytes(selectedMeta.size)}
              </span>
            )}
            <a
              href={fileUrl(selected)}
              target="_blank"
              rel="noreferrer"
              title="Open raw file in a new tab"
              className="ml-auto flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Open raw file"
            >
              <ExternalLink className="size-3" />
            </a>
          </div>
          <FilePreview path={selected} fileUrl={fileUrl} compact={compact} />
        </div>
      )}

      {/* Run summary (markdown, collapsible) */}
      {summary && summary.trim().length > 0 && (
        <Collapsible open={summaryOpen} onOpenChange={setSummaryOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-full justify-start text-xs">
              {summaryOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Run summary
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-1.5 rounded-md border bg-muted/20 p-2.5">
              <div className="prose prose-sm dark:prose-invert max-w-none break-words text-xs">
                <ReactMarkdown>{summary}</ReactMarkdown>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

export default InlineResults;
