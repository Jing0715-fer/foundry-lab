"use client";

import * as React from "react";
import { useAppStore } from "@/lib/store";
import { CARD_W, CARD_H, NODE_COLORS, nodeSpec } from "@/lib/workflow-catalog";
import type { NodeDTO, EdgeDTO } from "@/lib/types";
import { contentBox } from "@/lib/canvas-utils";

/** Color palette for the left color bar on each card (matches NODE_COLORS keys). */
const COLOR_HEX: Record<string, string> = {
  teal: "#14b8a6",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  rose: "#f43f5e",
  emerald: "#10b981",
  cyan: "#06b6d4",
  slate: "#64748b",
  orange: "#f97316",
  pink: "#ec4899",
};

/** Status palette for the bottom status strip on each card. */
const STATUS_HEX: Record<string, string> = {
  idle: "#94a3b8",
  pending: "#f59e0b",
  running: "#14b8a6",
  completed: "#10b981",
  failed: "#f43f5e",
};

function colorHex(color: string): string {
  return COLOR_HEX[color] ?? "#64748b";
}

function statusHex(status: string): string {
  return STATUS_HEX[status] ?? "#94a3b8";
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v && v.trim() !== "" ? v.trim() : fallback;
}

/**
 * Read the current workflow from the store and render it to a PNG image using
 * the browser's native Canvas API (no external dependencies). Triggers a
 * download of the file once the blob is ready.
 */
export async function exportCanvasToPNG(): Promise<void> {
  const { workflow, toast } = useAppStore.getState();
  if (!workflow || workflow.nodes.length === 0) {
    toast({
      title: "Nothing to export",
      description: "Add some nodes first",
      variant: "destructive",
    });
    return;
  }

  const nodes: NodeDTO[] = workflow.nodes;
  const edges: EdgeDTO[] = workflow.edges;
  const box = contentBox(nodes);

  // Higher scale → sharper PNG.
  const scale = 2;
  const padding = 40;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((box.w + padding * 2) * scale));
  canvas.height = Math.max(1, Math.round((box.h + padding * 2) * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.scale(scale, scale);

  // Background.
  ctx.fillStyle = cssVar("--background", "#ffffff");
  ctx.fillRect(0, 0, box.w + padding * 2, box.h + padding * 2);

  // Translate so that the content bbox's top-left sits at (padding, padding).
  ctx.translate(padding - box.x, padding - box.y);

  // Edges first so they sit behind the cards.
  const edgeColor = cssVar("--border", "#cccccc");
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = 2;
  for (const edge of edges) {
    const from = nodes.find((n) => n.id === edge.fromNodeId);
    const to = nodes.find((n) => n.id === edge.toNodeId);
    if (!from || !to) continue;
    const sx = from.x + CARD_W;
    const sy = from.y + 58;
    const tx = to.x;
    const ty = to.y + 58;
    const dx = Math.max(40, Math.abs(tx - sx) * 0.5);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(sx + dx, sy, tx - dx, ty, tx, ty);
    ctx.stroke();
    // Arrowhead.
    ctx.fillStyle = edgeColor;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 8, ty - 4);
    ctx.lineTo(tx - 8, ty + 4);
    ctx.closePath();
    ctx.fill();
  }

  const cardBg = cssVar("--card", "#ffffff");
  const cardBorder = cssVar("--border", "#cccccc");
  const textPrimary = cssVar("--foreground", "#000000");
  const textMuted = cssVar("--muted-foreground", "#666666");

  // Nodes.
  for (const node of nodes) {
    const spec = nodeSpec(node.type);
    // Reference NODE_COLORS so the lint/TS keeps the import live.
    void NODE_COLORS;

    ctx.fillStyle = cardBg;
    ctx.strokeStyle = cardBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, node.x, node.y, CARD_W, CARD_H, 8);
    ctx.fill();
    ctx.stroke();

    // Color bar (left).
    ctx.fillStyle = colorHex(spec?.color ?? "slate");
    ctx.fillRect(node.x, node.y, 4, CARD_H);

    // Status strip (bottom).
    ctx.fillStyle = statusHex(node.status);
    ctx.fillRect(node.x, node.y + CARD_H - 4, CARD_W, 4);

    // Name.
    ctx.fillStyle = textPrimary;
    ctx.font = "600 14px sans-serif";
    ctx.fillText(node.name, node.x + 16, node.y + 28);

    // Type label.
    ctx.fillStyle = textMuted;
    ctx.font = "11px sans-serif";
    ctx.fillText(spec?.label ?? node.type, node.x + 16, node.y + 48);

    // Status text.
    ctx.font = "10px sans-serif";
    ctx.fillText(node.status, node.x + 16, node.y + 68);
  }

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflow.name.replace(/\s+/g, "-").toLowerCase()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast({
      title: "Canvas exported",
      description: "PNG image downloaded",
      variant: "success",
    });
  });
}

/**
 * Serialize the current workflow to an SVG string and trigger a download.
 * Vector format — scales cleanly for posters / docs.
 */
export function exportCanvasToSVG(): void {
  const { workflow, toast } = useAppStore.getState();
  if (!workflow || workflow.nodes.length === 0) {
    toast({
      title: "Nothing to export",
      description: "Add some nodes first",
      variant: "destructive",
    });
    return;
  }

  const nodes: NodeDTO[] = workflow.nodes;
  const edges: EdgeDTO[] = workflow.edges;
  const box = contentBox(nodes);
  const padding = 40;

  const svgParts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${box.w + padding * 2}" height="${box.h + padding * 2}" viewBox="${box.x - padding} ${box.y - padding} ${box.w + padding * 2} ${box.h + padding * 2}">`,
    `<rect x="${box.x - padding}" y="${box.y - padding}" width="${box.w + padding * 2}" height="${box.h + padding * 2}" fill="#ffffff"/>`,
  ];

  // Edges.
  for (const edge of edges) {
    const from = nodes.find((n) => n.id === edge.fromNodeId);
    const to = nodes.find((n) => n.id === edge.toNodeId);
    if (!from || !to) continue;
    const sx = from.x + CARD_W;
    const sy = from.y + 58;
    const tx = to.x;
    const ty = to.y + 58;
    const dx = Math.max(40, Math.abs(tx - sx) * 0.5);
    svgParts.push(
      `<path d="M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}" stroke="#cccccc" stroke-width="2" fill="none"/>`,
    );
    svgParts.push(
      `<polygon points="${tx},${ty} ${tx - 8},${ty - 4} ${tx - 8},${ty + 4}" fill="#cccccc"/>`,
    );
  }

  // Nodes.
  for (const node of nodes) {
    const spec = nodeSpec(node.type);
    svgParts.push(
      `<rect x="${node.x}" y="${node.y}" width="${CARD_W}" height="${CARD_H}" rx="8" fill="#ffffff" stroke="#cccccc"/>`,
    );
    svgParts.push(
      `<rect x="${node.x}" y="${node.y}" width="4" height="${CARD_H}" fill="${colorHex(spec?.color ?? "slate")}"/>`,
    );
    svgParts.push(
      `<rect x="${node.x}" y="${node.y + CARD_H - 4}" width="${CARD_W}" height="4" fill="${statusHex(node.status)}"/>`,
    );
    svgParts.push(
      `<text x="${node.x + 16}" y="${node.y + 28}" font-family="sans-serif" font-size="14" font-weight="600" fill="#000000">${escapeXml(node.name)}</text>`,
    );
    svgParts.push(
      `<text x="${node.x + 16}" y="${node.y + 48}" font-family="sans-serif" font-size="11" fill="#666666">${escapeXml(spec?.label ?? node.type)}</text>`,
    );
    svgParts.push(
      `<text x="${node.x + 16}" y="${node.y + 68}" font-family="sans-serif" font-size="10" fill="#666666">${escapeXml(node.status)}</text>`,
    );
  }

  svgParts.push("</svg>");
  const svgStr = svgParts.join("\n");
  const blob = new Blob([svgStr], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${workflow.name.replace(/\s+/g, "-").toLowerCase()}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast({
    title: "Canvas exported",
    description: "SVG image downloaded",
    variant: "success",
  });
}
