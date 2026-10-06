// POST /api/workflow/nodes/[id]/sweep — parameter sweep (campaign mode).
//
// Body: { sweeps: [{ key, values: (string|number|boolean)[] }] }
//
// Expands ONE node's parameter grid into variant nodes:
//   1. Load the source node + its NodeSpec params schema.
//   2. Validate every axis (key exists, values typed + bounded by the schema).
//   3. Build the Cartesian product (capped at MAX_COMBINATIONS).
//   4. For each combination, create a clone node (same type/refId, params
//      merged with the combination, name = "<source> · k=v, …", positioned in
//      a grid below the source) AND copy every incoming edge of the source
//      node (same fromNodeId/fromPort/toPort) so each variant is wired
//      exactly like the original — the auto-wire engine then treats each
//      variant as an independent run of the same upstream context.
//
// Variants start idle — the client may fire POST /api/workflow/run right
// after (the dialog's "run immediately" option) or the user can run them
// individually / with Run All.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { toNodeDTO, toEdgeDTO } from "@/lib/workflow-engine";
import { nodeSpec, CARD_W, CARD_H, WORLD_MAX } from "@/lib/workflow-catalog";
import type { SweepResponseDTO, SweepValue } from "@/lib/types";

const MAX_COMBINATIONS = 24;
const MAX_VALUES_PER_AXIS = 8;
/** Variant grid layout: 3 per row below the source node. */
const GRID_COLS = 3;
const GRID_DX = 300;
const GRID_DY = 210;

interface SweepAxisBody {
  key: string;
  values: SweepValue[];
}

function isSweepableKey(key: string): boolean {
  return key !== "refId" && key !== "gpu" && key !== "cudaDevice";
}

function comboTag(key: string, value: SweepValue): string {
  return `${key}=${typeof value === "boolean" ? (value ? "true" : "false") : value}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const sweeps = body?.sweeps;

    if (!Array.isArray(sweeps) || sweeps.length === 0) {
      return NextResponse.json(
        { error: "sweeps must be a non-empty array of { key, values }" },
        { status: 400 },
      );
    }

    const source = await db.node.findUnique({ where: { id } });
    if (!source) {
      return NextResponse.json({ error: "Node not found" }, { status: 404 });
    }

    const spec = nodeSpec(source.type);
    if (!spec || spec.params.length === 0) {
      return NextResponse.json(
        { error: "This node type has no parameters to sweep" },
        { status: 400 },
      );
    }

    // ---- Validate + normalize each axis against the schema ----------------
    const normalized: { key: string; values: SweepValue[] }[] = [];
    for (const raw of sweeps as SweepAxisBody[]) {
      const key = typeof raw?.key === "string" ? raw.key : null;
      const values = raw?.values;
      if (!key || !Array.isArray(values) || values.length === 0) {
        return NextResponse.json(
          { error: "each sweep axis needs a key and a non-empty values array" },
          { status: 400 },
        );
      }
      if (values.length > MAX_VALUES_PER_AXIS) {
        return NextResponse.json(
          { error: `parameter "${key}" exceeds ${MAX_VALUES_PER_AXIS} values` },
          { status: 400 },
        );
      }
      if (!isSweepableKey(key)) {
        return NextResponse.json(
          { error: `parameter "${key}" cannot be swept (wiring/identity knob)` },
          { status: 400 },
        );
      }
      const schema = spec.params.find((p) => p.key === key);
      if (!schema) {
        return NextResponse.json(
          { error: `"${key}" is not a parameter of ${spec.label} nodes` },
          { status: 400 },
        );
      }
      const typed: SweepValue[] = [];
      for (const v of values) {
        switch (schema.type) {
          case "number": {
            const n = typeof v === "number" ? v : Number(v);
            if (!Number.isFinite(n)) {
              return NextResponse.json(
                { error: `value "${String(v)}" for "${key}" is not a number` },
                { status: 400 },
              );
            }
            if (schema.min !== undefined && n < schema.min) {
              return NextResponse.json(
                { error: `value ${n} for "${key}" is below the minimum ${schema.min}` },
                { status: 400 },
              );
            }
            if (schema.max !== undefined && n > schema.max) {
              return NextResponse.json(
                { error: `value ${n} for "${key}" is above the maximum ${schema.max}` },
                { status: 400 },
              );
            }
            typed.push(n);
            break;
          }
          case "select": {
            const s = String(v);
            if (!(schema.options ?? []).includes(s)) {
              return NextResponse.json(
                { error: `value "${s}" is not one of the allowed options for "${key}"` },
                { status: 400 },
              );
            }
            typed.push(s);
            break;
          }
          case "bool": {
            if (typeof v !== "boolean") {
              return NextResponse.json(
                { error: `value for "${key}" must be true or false` },
                { status: 400 },
              );
            }
            typed.push(v);
            break;
          }
          default: {
            // text / textarea / path — any string is valid
            typed.push(String(v));
            break;
          }
        }
      }
      normalized.push({ key, values: typed });
    }

    // ---- Cartesian product (bounded) ---------------------------------------
    let combos: Record<string, SweepValue>[] = [{}];
    for (const axis of normalized) {
      const next: Record<string, SweepValue>[] = [];
      for (const c of combos) for (const v of axis.values) next.push({ ...c, [axis.key]: v });
      combos = next;
    }
    if (combos.length > MAX_COMBINATIONS) {
      return NextResponse.json(
        {
          error: `sweep produces ${combos.length} combinations — the limit is ${MAX_COMBINATIONS}. Reduce values or axes.`,
        },
        { status: 400 },
      );
    }
    // A single combination is not a sweep — the client guards this too.
    if (combos.length < 2) {
      return NextResponse.json(
        { error: "sweep must vary at least one parameter across multiple values" },
        { status: 400 },
      );
    }

    // ---- Source params (merged per combination) ---------------------------
    const baseParams: Record<string, unknown> = (() => {
      try {
        const p = JSON.parse(source.params);
        return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();

    // ---- Incoming edges to replicate per variant ---------------------------
    const incoming = await db.edge.findMany({ where: { toNodeId: source.id } });

    // ---- Grid anchor anti-overlap (test finding #3) ------------------------
    // A second sweep of the same source would otherwise land its variant grid
    // at EXACTLY the same spot as the first (both anchor at source.x/y),
    // stacking cards on top of each other. Compute the grid rectangle, then
    // walk the whole block DOWN until it clears every existing node's card
    // AABB (a unit test in e2e: two sweeps of one source land disjoint).
    const gridRows = Math.ceil(combos.length / GRID_COLS);
    const gridW = GRID_COLS * GRID_DX;
    const gridH = gridRows * GRID_DY;
    const EXISTING_GAP = 60; // whitespace between the block and foreign cards
    const existingNodes = await db.node.findMany({
      where: { workflowId: source.workflowId },
      select: { x: true, y: true },
    });
    const blockHits = (ax: number, ay: number) =>
      existingNodes.some(
        (n) =>
          n.x < ax + gridW + EXISTING_GAP &&
          n.x + CARD_W > ax - EXISTING_GAP &&
          n.y < ay + gridH + EXISTING_GAP &&
          n.y + CARD_H > ay - EXISTING_GAP,
      );
    let anchorX = source.x;
    let anchorY = source.y + GRID_DY;
    // Walk down in whole-block strides until free AND in-bounds. The
    // world-edge check is part of the loop CONDITION (not a post-hoc
    // Math.min clamp, which could drag a found free spot back ONTO other
    // cards when the source sits near the bottom edge): once past maxY we
    // stop and accept the least-bad position — the user can drag it apart.
    const maxY = WORLD_MAX - gridH - 100;
    for (let stride = 0; stride < 200; stride++) {
      if (anchorY > maxY) break; // can't go further down — accept as-is
      if (!blockHits(anchorX, anchorY)) break; // free and in-bounds — accept
      anchorY += gridH + EXISTING_GAP * 2;
    }

    // ---- Create variants (grid below the source) ---------------------------
    const baseName = source.name.length > 24 ? `${source.name.slice(0, 24)}…` : source.name;
    // One group id for the whole batch — the variants stay linkable after the
    // fact (compare view, sweep→screening one-click campaign) and the linkage
    // survives undo/redo (history-apply re-POSTs it with the node create).
    const sweepGroupId = randomUUID();
    const createdNodes: ReturnType<typeof toNodeDTO>[] = [];
    const createdEdges: ReturnType<typeof toEdgeDTO>[] = [];

    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];
      const tag = Object.entries(combo).map(([k, v]) => comboTag(k, v)).join(", ");
      const name = `${baseName} · ${tag}`.slice(0, 64);
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const x = anchorX + col * GRID_DX;
      const y = anchorY + row * GRID_DY;

      const nodeParams = { ...baseParams, ...combo };
      const created = await db.node.create({
        data: {
          workflowId: source.workflowId,
          type: source.type,
          name,
          refId: source.refId,
          x,
          y,
          status: "idle",
          progress: 0,
          params: JSON.stringify(nodeParams),
          sweepGroup: sweepGroupId,
        },
      });
      createdNodes.push(toNodeDTO(created));

      for (const e of incoming) {
        const edge = await db.edge.create({
          data: {
            id: randomUUID(),
            workflowId: source.workflowId,
            fromNodeId: e.fromNodeId,
            toNodeId: created.id,
            fromPort: e.fromPort,
            toPort: e.toPort,
          },
        });
        createdEdges.push(toEdgeDTO(edge));
      }
    }

    const response: SweepResponseDTO = {
      sourceId: source.id,
      combinations: combos.length,
      sweepGroup: sweepGroupId,
      nodes: createdNodes,
      edges: createdEdges,
    };
    return NextResponse.json(response);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
