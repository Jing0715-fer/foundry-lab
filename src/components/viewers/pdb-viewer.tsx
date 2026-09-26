"use client";

import * as React from "react";
import { useAnimationFrame } from "framer-motion";
import { ZoomIn, ZoomOut, RotateCw, Pause, Box } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// --- Types -------------------------------------------------------------------

interface PdbAtom {
  atomName: string;
  resName: string;
  chainId: string;
  resSeq: number;
  x: number;
  y: number;
  z: number;
}

// --- Sample PDB ---------------------------------------------------------------

/**
 * Generate a synthetic PDB string (a 24-residue helix of CA atoms)
 * so the viewer always has something to display.
 */
export function generateSamplePdb(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 24; i++) {
    const t = i * 0.6;
    const x = (15 * Math.cos(t)).toFixed(3);
    const y = (3 * t).toFixed(3);
    const z = (15 * Math.sin(t)).toFixed(3);
    lines.push(
      `ATOM  ${String(i).padStart(5)}  CA  ALA A${String(i).padStart(4)}     ${x.padStart(8)} ${y.padStart(8)} ${z.padStart(8)}  1.00 20.00           C`,
    );
  }
  lines.push("END");
  return lines.join("\n");
}

// --- Parser -------------------------------------------------------------------

/**
 * Parse ATOM/HETATM records from a PDB string. Uses token-based parsing
 * (whitespace-separated) as the primary path — handles both the synthetic
 * sample and most real-world PDB files. Falls back to fixed-column parsing
 * for files where the chain ID column is blank (causing token indices to
 * shift). Returns an empty array when nothing parseable is found.
 */
function parsePdb(text: string): PdbAtom[] {
  const atoms: PdbAtom[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) continue;
    let atomName: string;
    let resName: string;
    let chainId: string;
    let resSeq: number;
    let x: number;
    let y: number;
    let z: number;

    const tokens = line.trim().split(/\s+/);
    // tokens: [ATOM, serial, atomName, resName, chainId, resSeq, x, y, z, ...]
    if (
      tokens.length >= 9 &&
      !Number.isNaN(parseFloat(tokens[6])) &&
      !Number.isNaN(parseFloat(tokens[7])) &&
      !Number.isNaN(parseFloat(tokens[8]))
    ) {
      atomName = tokens[2] || "CA";
      resName = tokens[3] || "UNK";
      chainId = tokens[4] || "A";
      resSeq = parseInt(tokens[5] || "0", 10) || 0;
      x = parseFloat(tokens[6]);
      y = parseFloat(tokens[7]);
      z = parseFloat(tokens[8]);
    } else if (line.length >= 54) {
      // Standard PDB columns (1-indexed):
      // 13-16 atom name · 18-20 resName · 22 chainId · 23-26 resSeq ·
      // 31-38 x · 39-46 y · 47-54 z
      atomName = line.substring(12, 16).trim() || "CA";
      resName = line.substring(17, 20).trim() || "UNK";
      chainId = line.substring(21, 22).trim() || "A";
      resSeq = parseInt(line.substring(22, 26).trim() || "0", 10) || 0;
      x = parseFloat(line.substring(30, 38));
      y = parseFloat(line.substring(38, 46));
      z = parseFloat(line.substring(46, 54));
      if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) continue;
    } else {
      continue;
    }

    atoms.push({ atomName, resName, chainId, resSeq, x, y, z });
  }
  return atoms;
}

// --- Color maps ---------------------------------------------------------------

const CHAIN_PALETTE: Record<string, string> = {
  A: "#14b8a6", // teal-500
  B: "#8b5cf6", // violet-500
  C: "#f59e0b", // amber-500
  D: "#ec4899", // pink-500
  E: "#22c55e", // green-500
  F: "#3b82f6", // blue-500
};

function chainColor(chainId: string, index: number): string {
  const known = CHAIN_PALETTE[chainId.toUpperCase()];
  if (known) return known;
  const fallback = [
    "#14b8a6",
    "#8b5cf6",
    "#f59e0b",
    "#ec4899",
    "#22c55e",
    "#3b82f6",
    "#f43f5e",
    "#06b6d4",
  ];
  return fallback[index % fallback.length];
}

const RESIDUE_CLASS: Record<string, "hydrophobic" | "polar" | "positive" | "negative"> = {
  A: "hydrophobic",
  V: "hydrophobic",
  L: "hydrophobic",
  I: "hydrophobic",
  M: "hydrophobic",
  F: "hydrophobic",
  W: "hydrophobic",
  P: "hydrophobic",
  G: "polar",
  S: "polar",
  T: "polar",
  C: "polar",
  Y: "polar",
  N: "polar",
  Q: "polar",
  K: "positive",
  R: "positive",
  H: "positive",
  D: "negative",
  E: "negative",
};

const RESIDUE_COLORS: Record<string, string> = {
  hydrophobic: "#f59e0b", // amber-500
  polar: "#06b6d4", // cyan-500
  positive: "#f43f5e", // rose-500
  negative: "#fb923c", // orange-400
};

function residueColor(resName: string): string {
  const cls = RESIDUE_CLASS[resName[0]?.toUpperCase()] ?? "polar";
  return RESIDUE_COLORS[cls];
}

// --- Viewer -------------------------------------------------------------------

export interface PdbViewerProps {
  pdbText: string | null;
  className?: string;
}

const CANVAS_SIZE = 360;
const PADDING = 28;

export function PdbViewer({ pdbText, className }: PdbViewerProps) {
  const [spin, setSpin] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const [colorMode, setColorMode] = React.useState<"chain" | "residue">("chain");
  const angleRef = React.useRef(0);
  const [angle, setAngle] = React.useState(0);

  // Reset zoom when input changes.
  React.useEffect(() => {
    setZoom(1);
  }, [pdbText]);

  // Animate spin angle via framer-motion's rAF.
  useAnimationFrame((_, delta) => {
    if (!spin) return;
    angleRef.current = (angleRef.current + (delta / 1000) * 24) % 360;
    setAngle(angleRef.current);
  });

  const atoms = React.useMemo<PdbAtom[]>(() => {
    if (!pdbText) return [];
    return parsePdb(pdbText).filter((a) => a.atomName === "CA");
  }, [pdbText]);

  const chainList = React.useMemo(() => {
    const seen: string[] = [];
    for (const a of atoms) {
      if (!seen.includes(a.chainId)) seen.push(a.chainId);
    }
    return seen;
  }, [atoms]);

  // Rotate around y-axis (so the helix spins), then drop z to project to 2D.
  const projected = React.useMemo(() => {
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return atoms.map((a) => {
      const rx = a.x * cos - a.z * sin;
      const ry = a.y;
      // z' used for depth-based radius scaling (optional flourish)
      const rz = a.x * sin + a.z * cos;
      return { ...a, rx, ry, rz };
    });
  }, [atoms, angle]);

  // Normalize projected (rx, ry) into SVG coordinate space.
  const layout = React.useMemo(() => {
    if (projected.length === 0) {
      return { points: [] as Array<{ atom: PdbAtom; sx: number; sy: number; depth: number }>, minX: 0, minY: 0 };
    }
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
      points: projected.map((p) => ({
        atom: p,
        sx: offsetX + (p.rx - minX) * scale,
        sy: offsetY + (p.ry - minY) * scale,
        depth: (p.rz - minZ) / zRange, // 0 (back) → 1 (front)
      })),
      minX,
      minY,
    };
  }, [projected]);

  if (!pdbText || atoms.length === 0) {
    return (
      <div
        className={cn(
          "flex h-72 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        <Box className="mb-2 size-8 opacity-40" />
        No structure to display
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {/* Header: counts + controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-mono text-[10px]">
          {atoms.length} atoms
        </Badge>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {chainList.length} chain{chainList.length === 1 ? "" : "s"}
        </Badge>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={colorMode === "chain" ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setColorMode("chain")}
            type="button"
          >
            By chain
          </Button>
          <Button
            variant={colorMode === "residue" ? "default" : "outline"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => setColorMode("residue")}
            type="button"
          >
            By residue
          </Button>
        </div>
      </div>

      {/* SVG canvas */}
      <div className="relative overflow-hidden rounded-lg border bg-gradient-to-b from-background to-muted/40">
        <svg
          viewBox={`0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}`}
          className="block h-72 w-full"
          role="img"
          aria-label="PDB structure visualization"
        >
          {/* dot grid background */}
          <defs>
            <pattern id="pdb-dot-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" className="fill-border/60" />
            </pattern>
          </defs>
          <rect
            x={0}
            y={0}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="fill-transparent"
          />
          <rect
            x={0}
            y={0}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            fill="url(#pdb-dot-grid)"
            opacity={0.5}
          />

          <g
            transform={`translate(${CANVAS_SIZE / 2} ${CANVAS_SIZE / 2}) scale(${zoom}) translate(${-CANVAS_SIZE / 2} ${-CANVAS_SIZE / 2})`}
          >
            {/* Backbone bonds — polylines per chain */}
            {chainList.map((chainId) => {
              const chainPoints = layout.points.filter(
                (p) => p.atom.chainId === chainId,
              );
              if (chainPoints.length < 2) return null;
              const d = chainPoints
                .map((p) => `${p.sx.toFixed(2)},${p.sy.toFixed(2)}`)
                .join(" ");
              return (
                <polyline
                  key={`bond-${chainId}`}
                  points={d}
                  fill="none"
                  stroke={colorMode === "chain" ? chainColor(chainId, chainList.indexOf(chainId)) : "#94a3b8"}
                  strokeWidth={1.5}
                  strokeOpacity={0.6}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            })}

            {/* CA atoms as circles */}
            {layout.points.map((p, i) => {
              const fill =
                colorMode === "chain"
                  ? chainColor(p.atom.chainId, chainList.indexOf(p.atom.chainId))
                  : residueColor(p.atom.resName);
              // depth-based radius — atoms in front are larger
              const r = 4 + p.depth * 3;
              return (
                <g key={`atom-${i}`}>
                  <circle
                    cx={p.sx}
                    cy={p.sy}
                    r={r + 2}
                    className="fill-foreground/10"
                  />
                  <circle
                    cx={p.sx}
                    cy={p.sy}
                    r={r}
                    fill={fill}
                    stroke="rgba(255,255,255,0.5)"
                    strokeWidth={0.5}
                  >
                    {spin && (
                      <title>
                        {`atom ${i + 1} · ${p.atom.resName} ${p.atom.resSeq} · chain ${p.atom.chainId}`}
                      </title>
                    )}
                  </circle>
                </g>
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

        {/* Zoom readout */}
        <div className="absolute bottom-2 left-2 rounded-md bg-background/80 px-2 py-0.5 font-mono text-[10px] text-muted-foreground backdrop-blur">
          {Math.round(zoom * 100)}%
        </div>
      </div>

      {/* Legend */}
      {colorMode === "chain" ? (
        <div className="flex flex-wrap gap-2">
          {chainList.map((c, i) => (
            <span
              key={c}
              className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] font-medium"
            >
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: chainColor(c, i) }}
              />
              chain {c}
            </span>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <LegendDot color={RESIDUE_COLORS.hydrophobic} label="Hydrophobic" />
          <LegendDot color={RESIDUE_COLORS.polar} label="Polar" />
          <LegendDot color={RESIDUE_COLORS.positive} label="Charged (+)" />
          <LegendDot color={RESIDUE_COLORS.negative} label="Charged (-)" />
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] font-medium">
      <span className="size-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

export default PdbViewer;
