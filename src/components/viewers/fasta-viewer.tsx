"use client";

import * as React from "react";
import { Copy, Check, Dna } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// --- Sample FASTA -------------------------------------------------------------

/**
 * Generate a synthetic 60-residue FASTA string cycling through the
 * 20 standard amino acids so the viewer always has something to display.
 */
export function generateSampleFasta(): string {
  const seq = Array.from({ length: 60 }, (_, i) =>
    "ACDEFGHIKLMNPQRSTVWY"[i % 20],
  ).join("");
  return `>sample_design_1|designed_sequence\n${seq}`;
}

// --- AA color map --------------------------------------------------------------

const AA_COLORS: Record<string, string> = {
  // hydrophobic — amber
  A: "bg-amber-500",
  V: "bg-amber-500",
  L: "bg-amber-500",
  I: "bg-amber-500",
  M: "bg-amber-500",
  F: "bg-amber-500",
  W: "bg-amber-500",
  P: "bg-amber-500",
  // polar — cyan
  G: "bg-cyan-500",
  S: "bg-cyan-500",
  T: "bg-cyan-500",
  C: "bg-cyan-500",
  Y: "bg-cyan-500",
  N: "bg-cyan-500",
  Q: "bg-cyan-500",
  // negative — orange
  D: "bg-orange-500",
  E: "bg-orange-500",
  // positive — rose
  K: "bg-rose-500",
  R: "bg-rose-500",
  H: "bg-rose-500",
};

const GAP_COLOR = "bg-slate-500";

function aaClass(aa: string): "hydrophobic" | "polar" | "positive" | "negative" | "special" | "gap" {
  const upper = aa.toUpperCase();
  if (upper === "-" || upper === ".") return "gap";
  if (AA_COLORS[upper] === "bg-amber-500") return "hydrophobic";
  if (AA_COLORS[upper] === "bg-cyan-500") return "polar";
  if (AA_COLORS[upper] === "bg-rose-500") return "positive";
  if (AA_COLORS[upper] === "bg-orange-500") return "negative";
  return "special";
}

function aaColorClass(aa: string): string {
  const upper = aa.toUpperCase();
  if (upper === "-" || upper === ".") return GAP_COLOR;
  return AA_COLORS[upper] ?? "bg-violet-500"; // special — violet
}

// --- FASTA parser --------------------------------------------------------------

interface FastaRecord {
  header: string;
  sequence: string;
}

function parseFasta(text: string): FastaRecord[] {
  const records: FastaRecord[] = [];
  let current: FastaRecord | null = null;
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith(">")) {
      if (current) records.push(current);
      current = { header: line.slice(1), sequence: "" };
    } else if (current) {
      // tolerate inline header (no `>` prefix but starting a new record) — uncommon
      current.sequence += line;
    } else {
      // sequence with no header — synthesize one
      current = { header: "sequence", sequence: line };
    }
  }
  if (current) records.push(current);
  return records;
}

// --- Viewer -------------------------------------------------------------------

export interface FastaViewerProps {
  fastaText: string | null;
  className?: string;
}

const CHAR_WIDTH = 12; // px per residue box

export function FastaViewer({ fastaText, className }: FastaViewerProps) {
  const [copied, setCopied] = React.useState<string | null>(null);

  const records = React.useMemo(() => {
    if (!fastaText) return [];
    return parseFasta(fastaText);
  }, [fastaText]);

  const handleCopy = async (record: FastaRecord, key: string) => {
    try {
      const text = `>${record.header}\n${record.sequence}`;
      await navigator.clipboard?.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // ignore — clipboard may be unavailable
    }
  };

  if (!fastaText || records.length === 0) {
    return (
      <div
        className={cn(
          "flex h-60 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        <Dna className="mb-2 size-8 opacity-40" />
        No sequence to display
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {/* Color legend */}
      <div className="flex flex-wrap gap-2">
        <LegendItem className="bg-amber-500" label="Hydrophobic" />
        <LegendItem className="bg-cyan-500" label="Polar" />
        <LegendItem className="bg-rose-500" label="Positive" />
        <LegendItem className="bg-orange-500" label="Negative" />
        <LegendItem className="bg-violet-500" label="Special" />
        <LegendItem className="bg-slate-500" label="Gap" />
      </div>

      {records.map((record, idx) => {
        const key = `${record.header}-${idx}`;
        // Position scale — show ruler every 10 residues
        const chunks = Math.ceil(record.sequence.length / 10);
        return (
          <div key={key} className="rounded-lg border bg-card p-3 shadow-sm">
            {/* Header row */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <code className="truncate font-mono text-xs text-foreground">
                {record.header}
              </code>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {record.sequence.length} aa
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-7 px-2 text-[11px]"
                onClick={() => handleCopy(record, key)}
                type="button"
              >
                {copied === key ? (
                  <>
                    <Check className="size-3" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" /> Copy sequence
                  </>
                )}
              </Button>
            </div>

            {/* Sequence strip + position ruler. The strip wraps at the
                available width (no fixed minWidth: forcing ~732px blew out
                narrow containers like the 320px inspector panel and clipped
                everything past the right border). */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap gap-px overflow-x-auto rounded-md bg-muted/40 p-1.5">
                {record.sequence.split("").map((aa, i) => (
                  <div
                    key={i}
                    className={cn(
                      "flex size-3 items-center justify-center rounded-[2px] text-[7px] font-bold leading-none text-white",
                      aaColorClass(aa),
                    )}
                    title={`${aa} @ pos ${i + 1} (${aaClass(aa)})`}
                  >
                    {aa.toUpperCase()}
                  </div>
                ))}
              </div>

              {/* Position ruler */}
              <div
                className="flex flex-wrap gap-px text-[9px] text-muted-foreground"
                aria-hidden
              >
                {Array.from({ length: chunks }, (_, c) => (
                  <div
                    key={c}
                    className="font-mono"
                    style={{ width: `${10 * CHAR_WIDTH - 1}px` }}
                  >
                    {c * 10 + 1}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LegendItem({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] font-medium">
      <span className={cn("size-2.5 rounded-[2px]", className)} />
      {label}
    </span>
  );
}

export default FastaViewer;
