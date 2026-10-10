"use client";

/**
 * SuperposeDialog — 3D structural superposition of TWO structures (D1).
 *
 * Given exactly two entries ({ name, pdbPath }), fetches both PDB texts,
 * aligns them (sequence alignment + rigid-body fit via the molecular
 * superpose core) and renders the overlay:
 *   - reference backbone: slate CA trace (stays put),
 *   - mobile backbone: moved onto the reference; each CA dot is colored by
 *     its per-residue deviation (<1 Å emerald, <2.5 Å amber, ≥2.5 Å rose,
 *     unmatched neutral),
 *   - header chips: global CA RMSD, matched pairs, chain pair, lengths,
 *   - a small deviation histogram under the viewer.
 *
 * Reused by both the screening Compare dialog (2 selected candidates) and
 * the sweep Compare dialog (top-2 completed variants). All failures
 * (missing file, parse error, low sequence similarity) render inline.
 */

import * as React from "react";
import { useAnimationFrame } from "framer-motion";
import { ArrowLeftRight, Box, Loader2, RotateCw, Pause, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  compareStructures,
  deviationBucket,
  DEV_THRESHOLDS,
  type SuperposeComparison,
  type SuperposePoint,
} from "@/lib/superpose-compare";

/** One structure to superpose. `pdbPath` null → "no structure file" state. */
export interface SuperposeEntry {
  name: string;
  pdbPath: string | null;
}

interface SuperposeDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /**
   * Exactly two entries: [reference, mobile] — the reference stays put and
   * the mobile structure is transformed onto it.
   */
  entries: [SuperposeEntry, SuperposeEntry] | null;
}

const CANVAS_SIZE = 420;
const PADDING = 30;

const REF_STROKE = "#64748b"; // slate-500
const BUCKET_FILL: Record<string, string> = {
  emerald: "#10b981",
  amber: "#f59e0b",
  rose: "#f43f5e",
  none: "#94a3b8", // slate-400 — unmatched residues
};

export function SuperposeDialog({
  open,
  onOpenChange,
  entries,
}: SuperposeDialogProps) {
  const [comparison, setComparison] = React.useState<SuperposeComparison | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // H1b: local reference/mobile flip. The parent's entries stay canonical
  // ([reference, mobile]); the swap button exchanges the roles and the fetch
  // effect below re-runs against the flipped pair. Reset on dialog close —
  // a fresh open always starts unswapped (while the dialog is open, Radix
  // modality blocks the parent from supplying new entries, so [open] covers
  // every reachable path).
  const [swapped, setSwapped] = React.useState(false);
  const effectiveEntries = React.useMemo<
    [SuperposeEntry, SuperposeEntry] | null
  >(() => {
    if (!entries) return null;
    return swapped ? [entries[1], entries[0]] : entries;
  }, [entries, swapped]);
  React.useEffect(() => {
    if (!open) setSwapped(false);
  }, [open, entries]);

  // Viewer state.
  const [spin, setSpin] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const angleRef = React.useRef(0);
  const [angle, setAngle] = React.useState(0);

  useAnimationFrame((_, delta) => {
    if (!spin) return;
    angleRef.current = (angleRef.current + (delta / 1000) * 24) % 360;
    setAngle(angleRef.current);
  });

  // Fetch + compute whenever the dialog (re)opens with new entries (or the
  // pair is swapped — H1b: swapping re-fetches and re-aligns with the roles
  // exchanged, which is NOT symmetric: the reference stays put and the mobile
  // structure carries the per-residue deviation colors).
  React.useEffect(() => {
    if (!open || !effectiveEntries) {
      setComparison(null);
      setError(null);
      setLoading(false);
      setZoom(1);
      setSpin(false);
      return;
    }
    const [ref, mobile] = effectiveEntries;
    // Missing file guard — inline error, no fetch. (Capture into consts so
    // the narrowing survives the async closure below.)
    const refPath = ref.pdbPath;
    const mobPath = mobile.pdbPath;
    if (!refPath || !mobPath) {
      setComparison(null);
      setError("Both structures need a linked PDB file to superpose.");
      return;
    }
    let cancelled = false;
    // P2-7: abort in-flight fetches when the dialog closes/unmounts (the
    // cancelled flag already guards state — this also stops the bytes).
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const urls = [refPath, mobPath].map(
          (p) => `/api/tools/file?path=${encodeURIComponent(p)}`,
        );
        const texts = await Promise.all(
          urls.map(async (u) => {
            const res = await fetch(u, { signal: controller.signal });
            const body = await res.text();
            if (!res.ok) {
              let msg = `HTTP ${res.status}`;
              try {
                const j = JSON.parse(body);
                if (j?.error) msg = j.error;
              } catch {
                /* raw text body — keep status line */
              }
              throw new Error(msg);
            }
            return body;
          }),
        );
        // Parsing + alignment is CPU work — yield to the renderer first so
        // the loading state actually paints.
        await new Promise((r) => setTimeout(r, 0));
        const result = compareStructures(
          texts[0],
          texts[1],
          ref.name,
          mobile.name,
        );
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error ?? "Superposition failed");
          setComparison(null);
        } else {
          setComparison(result);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setComparison(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, effectiveEntries]);

  // --- Viewer projection ----------------------------------------------------

  const layout = React.useMemo(() => {
    if (!comparison || !comparison.ok) return null;
    const pts = [...comparison.refPath, ...comparison.mobilePath];
    if (pts.length === 0) return null;
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const project = (p: SuperposePoint) => ({
      rx: p.x * cos - p.z * sin,
      ry: p.y,
      rz: p.x * sin + p.z * cos,
    });
    const projected = pts.map(project);
    const xs = projected.map((p) => p.rx);
    const ys = projected.map((p) => p.ry);
    const zs = projected.map((p) => p.rz);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const range = Math.max(rangeX, rangeY);
    const scale = (CANVAS_SIZE - PADDING * 2) / range;
    const offsetX = (CANVAS_SIZE - rangeX * scale) / 2;
    const offsetY = (CANVAS_SIZE - rangeY * scale) / 2;
    const zRange = maxZ - minZ || 1;
    return {
      project,
      minX,
      minY,
      scale,
      offsetX,
      offsetY,
      zRange,
      minZ,
    };
  }, [comparison, angle]);

  const toScreen = (p: SuperposePoint) => {
    if (!layout) return { sx: 0, sy: 0, depth: 0 };
    const { rx, ry, rz } = layout.project(p);
    return {
      sx: layout.offsetX + (rx - layout.minX) * layout.scale,
      sy: layout.offsetY + (ry - layout.minY) * layout.scale,
      depth: (rz - layout.minZ) / (layout.zRange || 1),
    };
  };

  // --- Deviation histogram ---------------------------------------------------

  const histogram = React.useMemo(() => {
    if (!comparison?.ok) return null;
    const devs = comparison.mobileDeviations.filter((d) => Number.isFinite(d));
    if (devs.length === 0) return null;
    const BINS = 16;
    const max = Math.max(DEV_THRESHOLDS.warn, ...devs);
    const counts = new Array<number>(BINS).fill(0);
    for (const d of devs) {
      const bin = Math.min(BINS - 1, Math.floor((d / max) * BINS));
      counts[bin] += 1;
    }
    return { bins: counts.map((c) => c / Math.max(1, devs.length)), max, total: devs.length };
  }, [comparison]);

  const bucketCounts = React.useMemo(() => {
    if (!comparison?.ok) return null;
    const counts = { emerald: 0, amber: 0, rose: 0, none: 0 };
    for (const d of comparison.mobileDeviations) {
      counts[deviationBucket(d)] += 1;
    }
    return counts;
  }, [comparison]);

  const rmsdQuality = comparison?.ok
    ? comparison.rmsd < DEV_THRESHOLDS.good
      ? "emerald"
      : comparison.rmsd < DEV_THRESHOLDS.warn
        ? "amber"
        : "rose"
    : "neutral";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Box className="size-5" />
            Structural superposition
            {/* H1b swap: reference stays put / mobile is fitted — flip which
                structure plays which role. Only meaningful with a pair. */}
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="ml-auto h-7 gap-1 px-2 text-xs"
              disabled={!entries || loading}
              onClick={() => setSwapped((s) => !s)}
              aria-label="Swap reference and mobile structures"
              title="Swap which structure stays put (reference) and which is rigid-fitted onto it"
              data-testid="superpose-swap"
            >
              <ArrowLeftRight className="size-3.5" />
              Swap
            </Button>
          </DialogTitle>
          <DialogDescription>
            {effectiveEntries
              ? `${effectiveEntries[1].name} (mobile) is rigid-fitted onto ${effectiveEntries[0].name} (reference) — sequence alignment, then optimal superposition.`
              : "Align two structures and inspect where they diverge."}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Fetching structures and aligning…
          </div>
        )}

        {!loading && error && (
          <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <p>{error}</p>
            {error.includes("File not found on disk") && (
              <p className="text-xs text-muted-foreground">
                Structure files are run artifacts — they live under{" "}
                <code className="font-mono">outputs/</code> and are produced when the
                workflow runs. If the file is missing (e.g. after a demo reset or
                artifact cleanup), re-run the producing node or pick candidates
                whose PDB files still exist.
              </p>
            )}
          </div>
        )}

        {!loading && comparison?.ok && layout && (
          <div className="space-y-3">
            {/* Stats chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
                  rmsdQuality === "emerald" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                  rmsdQuality === "amber" && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
                  rmsdQuality === "rose" && "bg-rose-500/10 text-rose-700 dark:text-rose-400",
                  rmsdQuality === "neutral" && "bg-muted text-foreground",
                )}
                title="Global Cα RMSD after optimal superposition"
              >
                RMSD {comparison.rmsd.toFixed(2)} Å
              </span>
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums" title="Residue pairs used by the rigid fit">
                {comparison.matched} aligned pairs
              </span>
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs tabular-nums" title="Aligned chain pair (mobile ↔ reference)">
                chain {comparison.mobileChain} ↔ {comparison.refChain}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {comparison.mobileLength} / {comparison.refLength} residues
              </span>
            </div>

            {/* Overlay viewer */}
            <div className="relative overflow-hidden rounded-lg border bg-gradient-to-b from-background to-muted/40">
              <svg
                viewBox={`0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}`}
                className="block h-[420px] w-full"
                role="img"
                aria-label={`Superposition overlay: ${comparison.mobileName} on ${comparison.refName}`}
                data-superpose-canvas
              >
                <defs>
                  <pattern id="superpose-dot-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <circle cx="1" cy="1" r="1" className="fill-border/60" />
                  </pattern>
                </defs>
                <rect
                  x={0}
                  y={0}
                  width={CANVAS_SIZE}
                  height={CANVAS_SIZE}
                  fill="url(#superpose-dot-grid)"
                  opacity={0.5}
                />

                <g
                  transform={`translate(${CANVAS_SIZE / 2} ${CANVAS_SIZE / 2}) scale(${zoom}) translate(${-CANVAS_SIZE / 2} ${-CANVAS_SIZE / 2})`}
                >
                  {/* Reference backbone — slate trace, drawn first (under) */}
                  <polyline
                    points={comparison.refPath.map((p) => {
                      const { sx, sy } = toScreen(p);
                      return `${sx.toFixed(2)},${sy.toFixed(2)}`;
                    }).join(" ")}
                    fill="none"
                    stroke={REF_STROKE}
                    strokeWidth={2}
                    strokeOpacity={0.55}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {comparison.refPath.map((p, i) => {
                    const { sx, sy } = toScreen(p);
                    return (
                      <circle
                        key={`ref-${i}`}
                        cx={sx}
                        cy={sy}
                        r={2}
                        fill={REF_STROKE}
                        fillOpacity={0.7}
                      />
                    );
                  })}

                  {/* Mobile backbone — neutral trace */}
                  <polyline
                    points={comparison.mobilePath.map((p) => {
                      const { sx, sy } = toScreen(p);
                      return `${sx.toFixed(2)},${sy.toFixed(2)}`;
                    }).join(" ")}
                    fill="none"
                    className="stroke-foreground/25"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {/* Mobile CA dots — colored by per-residue deviation */}
                  {comparison.mobilePath.map((p, i) => {
                    const { sx, sy, depth } = toScreen(p);
                    const bucket = deviationBucket(comparison.mobileDeviations[i]);
                    return (
                      <circle
                        key={`mob-${i}`}
                        cx={sx}
                        cy={sy}
                        r={3 + depth * 2}
                        fill={BUCKET_FILL[bucket]}
                        stroke="rgba(255,255,255,0.45)"
                        strokeWidth={0.5}
                      />
                    );
                  })}
                </g>
              </svg>

              {/* Floating controls */}
              <div className="absolute right-2 top-2 flex flex-col gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7 bg-background/80 backdrop-blur"
                  onClick={() => setZoom((z) => Math.min(4, z + 0.2))}
                  type="button"
                  aria-label="Zoom in"
                >
                  <ZoomIn className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7 bg-background/80 backdrop-blur"
                  onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
                  type="button"
                  aria-label="Zoom out"
                >
                  <ZoomOut className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className={cn(
                    "size-7 bg-background/80 backdrop-blur",
                    spin && "border-primary text-primary",
                  )}
                  onClick={() => setSpin((s) => !s)}
                  type="button"
                  aria-label={spin ? "Pause spin" : "Start spin"}
                >
                  {spin ? <Pause className="size-3.5" /> : <RotateCw className="size-3.5" />}
                </Button>
              </div>
              <div className="absolute bottom-2 left-2 rounded-md bg-background/80 px-2 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
                {Math.round(zoom * 100)}%
              </div>
            </div>

            {/* Legend + histogram */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] font-medium">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: REF_STROKE }} />
                Reference · {comparison.refName}
              </span>
              {bucketCounts &&
                (
                  [
                    ["emerald", `< ${DEV_THRESHOLDS.good} Å`],
                    ["amber", `${DEV_THRESHOLDS.good}–${DEV_THRESHOLDS.warn} Å`],
                    ["rose", `≥ ${DEV_THRESHOLDS.warn} Å`],
                    ["none", "unmatched"],
                  ] as const
                ).map(([bucket, label]) => (
                  <span
                    key={bucket}
                    className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] font-medium"
                  >
                    <span
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: BUCKET_FILL[bucket] }}
                    />
                    {label} · {bucketCounts[bucket]}
                  </span>
                ))}
            </div>

            {histogram && (
              <div className="rounded-lg border p-3" data-superpose-histogram>
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Per-residue deviation distribution
                </p>
                <div className="flex h-12 items-end gap-[2px]" aria-hidden>
                  {histogram.bins.map((frac, i) => {
                    const bucket = i / histogram.bins.length >= DEV_THRESHOLDS.warn / histogram.max
                      ? "rose"
                      : i / histogram.bins.length >= DEV_THRESHOLDS.good / histogram.max
                        ? "amber"
                        : "emerald";
                    return (
                      <span
                        key={i}
                        className={cn(
                          "flex-1 rounded-t-sm",
                          bucket === "emerald" && "bg-emerald-500",
                          bucket === "amber" && "bg-amber-500",
                          bucket === "rose" && "bg-rose-500",
                        )}
                        style={{ height: `${Math.max(3, frac * 100)}%` }}
                      />
                    );
                  })}
                </div>
                <div className="mt-1 relative h-4 text-[10px] tabular-nums text-muted-foreground">
                  {/* Threshold ticks positioned at their true fractions of the
                      bar (0 · good · warn · max) instead of even spacing. */}
                  {(() => {
                    const ticks: { label: string; frac: number }[] = [
                      { label: "0 Å", frac: 0 },
                      {
                        label: `${DEV_THRESHOLDS.good} Å`,
                        frac: DEV_THRESHOLDS.good / histogram.max,
                      },
                      {
                        label: `${DEV_THRESHOLDS.warn} Å`,
                        frac: DEV_THRESHOLDS.warn / histogram.max,
                      },
                      { label: `${histogram.max.toFixed(1)} Å`, frac: 1 },
                    ];
                    return ticks.map((t, i) => (
                      <span
                        key={i}
                        className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
                        style={{
                          left: `${Math.min(97, Math.max(3, t.frac * 100))}%`,
                        }}
                      >
                        {t.label}
                      </span>
                    ));
                  })()}
                </div>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              Mobile structure is fitted onto the reference with an optimal
              rigid transform (Horn quaternion method) over{" "}
              {comparison.matched} sequence-aligned Cα pairs. Divergent
              regions — typically loops or termini — appear as amber/rose dots.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
