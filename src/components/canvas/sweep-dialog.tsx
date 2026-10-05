"use client";

// Parameter sweep dialog (campaign mode).
//
// Expands ONE tool node's parameter grid into N variant nodes: pick the
// params to vary, give each a list of values, preview the Cartesian product
// (capped at MAX_COMBINATIONS server-side too), then create the variants
// with their upstream wiring inherited from the source node. After creation
// the user can "Run all variants" immediately — outputs flow into Screening
// exactly like any manual run.
//
// History: one snapshot is pushed BEFORE the batch (like batch delete), the
// optimistic writes happen suppressed — a single Ctrl+Z reverts the whole sweep.

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Play, Sparkles, Info, Wand2 } from "lucide-react";
import type { NodeDTO, NodeSpec, ParamSchema, SweepAxisDTO, SweepResponseDTO } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { useHistoryStore } from "@/lib/history-store";
import { withHistorySuppressed } from "@/lib/history-apply";
import { SWEEP_TEMPLATES, templateMatches } from "@/lib/sweep-templates";

const MAX_COMBINATIONS = 24;
/** Values per axis (protects the URL/JSON payload and the grid layout). */
const MAX_VALUES_PER_AXIS = 8;

/** Params that never make sense to sweep (identity/wiring, not experiment knobs). */
const UNSWEEPABLE_KEYS = new Set(["refId", "gpu", "cudaDevice"]);

interface AxisState {
  enabled: boolean;
  /** raw text for number/text axes (comma-separated) */
  raw: string;
  /** chosen values for select/bool axes */
  picked: string[];
}

function isSweepable(p: ParamSchema): boolean {
  return !UNSWEEPABLE_KEYS.has(p.key);
}

/** Parse one axis against its schema → typed values + error message. */
function parseAxis(
  schema: ParamSchema,
  state: AxisState,
): { values: (string | number | boolean)[]; error: string | null } {
  if (!state.enabled) return { values: [], error: null };

  if (schema.type === "select") {
    if (state.picked.length === 0)
      return { values: [], error: "pick at least one option" };
    return { values: state.picked, error: null };
  }
  if (schema.type === "bool") {
    if (state.picked.length === 0)
      return { values: [], error: "pick true, false, or both" };
    return {
      values: state.picked.map((v) => v === "true"),
      error: null,
    };
  }
  if (schema.type === "number") {
    const tokens = state.raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return { values: [], error: "enter values (e.g. 4, 8, 16)" };
    if (tokens.length > MAX_VALUES_PER_AXIS)
      return { values: [], error: `max ${MAX_VALUES_PER_AXIS} values per parameter` };
    const nums: number[] = [];
    for (const t of tokens) {
      const n = Number(t);
      if (!Number.isFinite(n)) return { values: [], error: `"${t}" is not a number` };
      if (schema.min !== undefined && n < schema.min)
        return { values: [], error: `"${t}" is below the allowed minimum ${schema.min}` };
      if (schema.max !== undefined && n > schema.max)
        return { values: [], error: `"${t}" is above the allowed maximum ${schema.max}` };
      nums.push(n);
    }
    return { values: nums, error: null };
  }
  // text / textarea / path — comma-separated string list
  const tokens = state.raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return { values: [], error: "enter values separated by commas" };
  if (tokens.length > MAX_VALUES_PER_AXIS)
    return { values: [], error: `max ${MAX_VALUES_PER_AXIS} values per parameter` };
  return { values: tokens, error: null };
}

function comboLabel(axis: { key: string; value: string | number | boolean }): string {
  const v = axis.value;
  return `${axis.key}=${typeof v === "boolean" ? (v ? "true" : "false") : v}`;
}

export function SweepDialog({
  node,
  spec,
  open,
  onOpenChange,
}: {
  node: NodeDTO;
  spec: NodeSpec;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useAppStore((s) => s.toast);

  const sweepable = React.useMemo(
    () => spec.params.filter(isSweepable),
    [spec.params],
  );

  const [axes, setAxes] = React.useState<Record<string, AxisState>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [runAfter, setRunAfter] = React.useState(false);

  // Reset per-open so reopening starts from the node's current state.
  React.useEffect(() => {
    if (!open) {
      setAxes({});
      setRunAfter(false);
      setSubmitting(false);
    }
  }, [open]);

  const axis = (key: string): AxisState =>
    axes[key] ?? { enabled: false, raw: "", picked: [] };

  const setAxis = (key: string, patch: Partial<AxisState>) =>
    setAxes((a) => ({ ...a, [key]: { ...axis(key), ...patch } }));

  // One-click template ladders — only templates with ≥2 valid values on this
  // node's spec are offered; applying one enables those axes (replacing their
  // current values, leaving other axes untouched).
  const templateHits = React.useMemo(
    () =>
      SWEEP_TEMPLATES.map((t) => ({
        template: t,
        matches: templateMatches(t, sweepable),
      })).filter((h) => h.matches.length > 0),
    [sweepable],
  );

  const applyTemplate = (
    matches: { key: string; schema: ParamSchema; values: (string | number | boolean)[] }[],
  ) => {
    setAxes((a) => {
      const next = { ...a };
      for (const m of matches) {
        if (m.schema.type === "select" || m.schema.type === "bool") {
          next[m.key] = {
            enabled: true,
            raw: "",
            picked: m.values.map((v) => String(v)),
          };
        } else {
          next[m.key] = {
            enabled: true,
            raw: m.values.join(", "),
            picked: [],
          };
        }
      }
      return next;
    });
  };

  // Parse every enabled axis; compute the product for the live preview.
  const parsed = React.useMemo(() => {
    const out: { schema: ParamSchema; values: (string | number | boolean)[]; error: string | null }[] = [];
    for (const p of sweepable) {
      const state = axis(p.key);
      if (!state.enabled) continue;
      const { values, error } = parseAxis(p, state);
      out.push({ schema: p, values, error });
    }
    return out;
  }, [axes, sweepable]);

  const enabledCount = parsed.length;
  const errorCount = parsed.filter((p) => p.error).length;
  const combinations =
    errorCount === 0 ? parsed.reduce((acc, p) => acc * Math.max(p.values.length, 1), 1) : 0;

  /** First few combinations for the preview list (bounded). */
  const preview: string[] = React.useMemo(() => {
    if (errorCount > 0 || enabledCount === 0) return [];
    let combos: Record<string, string | number | boolean>[] = [{}];
    for (const p of parsed) {
      const next: Record<string, string | number | boolean>[] = [];
      for (const c of combos)
        for (const v of p.values) next.push({ ...c, [p.schema.key]: v });
      combos = next;
    }
    return combos.slice(0, 6).map((c) =>
      Object.entries(c)
        .map(([k, v]) => comboLabel({ key: k, value: v }))
        .join(", "),
    );
  }, [parsed, enabledCount, errorCount]);

  const canSubmit =
    enabledCount > 0 && errorCount === 0 && combinations > 1 && combinations <= MAX_COMBINATIONS && !submitting;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body: { sweeps: SweepAxisDTO[] } = {
        sweeps: parsed.map((p) => ({ key: p.schema.key, values: p.values })),
      };
      const res = await fetch(`/api/workflow/nodes/${node.id}/sweep`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: SweepResponseDTO | { error: string } = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) {
        throw new Error((data as { error: string }).error || `HTTP ${res.status}`);
      }
      const payload = data as SweepResponseDTO;

      // ONE history snapshot before the batch → single Ctrl+Z reverts it.
      const s = useAppStore.getState();
      const before = s.workflow;
      if (before) {
        useHistoryStore.getState().push({
          nodes: before.nodes,
          edges: before.edges,
          viewport: s.viewport,
        });
      }
      withHistorySuppressed(() => {
        s.setWorkflow({
          ...(before ?? ({} as NonNullable<typeof before>)),
          id: node.workflowId,
          nodes: [...(before?.nodes ?? []), ...payload.nodes],
          edges: [...(before?.edges ?? []), ...payload.edges],
        } as NonNullable<typeof before>);
      });

      onOpenChange(false);
      toast({
        title: `Sweep created — ${payload.combinations} variants`,
        description: `Each variant inherits the upstream wiring of “${node.name}”.`,
      });

      if (runAfter) {
        const runRes = await fetch("/api/workflow/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflowId: node.workflowId }),
        });
        if (runRes.status === 409) {
          toast({ title: "Workflow is already running" });
        } else if (!runRes.ok) {
          const err = await runRes.json().catch(() => ({}));
          toast({
            title: "Run failed",
            description: err.error || `HTTP ${runRes.status}`,
            variant: "destructive",
          });
        } else {
          // Pull the post-run state so variant statuses show immediately.
          const wfRes = await fetch(`/api/workflows/${node.workflowId}`);
          if (wfRes.ok) {
            const fresh = await wfRes.json();
            withHistorySuppressed(() => useAppStore.getState().setWorkflow(fresh));
          }
          toast({ title: "All variants executed", variant: "success" });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Sweep failed", description: msg, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Parameter sweep — {node.name}
          </DialogTitle>
          <DialogDescription>
            Pick parameters to vary. Each combination becomes a variant node
            (wired like the original) — run them all, then screen the outputs.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-72 pr-3">
          <div className="flex flex-col gap-3">
            {sweepable.length === 0 && (
              <p className="text-sm text-muted-foreground">
                This node has no sweepable parameters.
              </p>
            )}
            {templateHits.length > 0 && (
              <div
                className="rounded-lg border border-primary/20 bg-primary/5 p-3"
                data-sweep-templates
              >
                <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Wand2 className="size-3.5" />
                  Quick templates
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {templateHits.map(({ template, matches }) => (
                    <button
                      key={template.id}
                      type="button"
                      title={template.description}
                      onClick={() => applyTemplate(matches)}
                      className="rounded-md border border-primary/30 bg-background px-2.5 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
                      data-sweep-template={template.id}
                    >
                      {template.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {sweepable.map((p) => {
              const state = axis(p.key);
              return (
                <div
                  key={p.key}
                  className="rounded-lg border p-3"
                  data-sweep-param={p.key}
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`sweep-${p.key}`}
                      checked={state.enabled}
                      onCheckedChange={(v) => setAxis(p.key, { enabled: v === true })}
                    />
                    <Label
                      htmlFor={`sweep-${p.key}`}
                      className="text-sm font-medium leading-none"
                    >
                      {p.label}
                    </Label>
                    <Badge variant="outline" className="ml-auto text-[10px]">
                      {p.type}
                    </Badge>
                  </div>
                  {state.enabled && (
                    <div className="mt-2 pl-6">
                      {p.type === "select" ? (
                        <div className="flex flex-wrap gap-1.5">
                          {(p.options ?? []).map((opt) => {
                            const on = state.picked.includes(opt);
                            return (
                              <button
                                key={opt}
                                type="button"
                                onClick={() =>
                                  setAxis(p.key, {
                                    picked: on
                                      ? state.picked.filter((x) => x !== opt)
                                      : [...state.picked, opt],
                                  })
                                }
                                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                                  on
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:bg-muted"
                                }`}
                              >
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                      ) : p.type === "bool" ? (
                        <div className="flex gap-1.5">
                          {["true", "false"].map((opt) => {
                            const on = state.picked.includes(opt);
                            return (
                              <button
                                key={opt}
                                type="button"
                                onClick={() =>
                                  setAxis(p.key, {
                                    picked: on
                                      ? state.picked.filter((x) => x !== opt)
                                      : [...state.picked, opt],
                                  })
                                }
                                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                                  on
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:bg-muted"
                                }`}
                              >
                                {opt}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <Input
                          value={state.raw}
                          onChange={(e) => setAxis(p.key, { raw: e.target.value })}
                          placeholder={
                            p.type === "number"
                              ? `e.g. ${[p.default, (p.default as number) * 2, (p.default as number) * 4].slice(0, 3).join(", ")}`
                              : "value1, value2, value3"
                          }
                          className="h-8 text-sm"
                          aria-label={`Sweep values for ${p.label}`}
                        />
                      )}
                      {p.hint && (
                        <p className="mt-1 text-[11px] text-muted-foreground">{p.hint}</p>
                      )}
                      {parsed.find((x) => x.schema.key === p.key)?.error && (
                        <p className="mt-1 text-[11px] text-destructive">
                          {parsed.find((x) => x.schema.key === p.key)?.error}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        {/* Live combination preview */}
        <div
          className="rounded-lg border bg-muted/40 p-3 text-xs"
          data-sweep-preview
        >
          <div className="flex items-center gap-2">
            <Info className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-muted-foreground">
              {enabledCount === 0
                ? "Enable at least one parameter to build the sweep."
                : errorCount > 0
                  ? "Fix the highlighted values first."
                  : `${combinations} variant${combinations === 1 ? "" : "s"} will be created${combinations > MAX_COMBINATIONS ? " — over the limit of " + MAX_COMBINATIONS : ""}.`}
            </span>
          </div>
          {preview.length > 0 && errorCount === 0 && (
            <ul className="mt-2 flex flex-col gap-1 pl-5 font-mono text-[11px] text-muted-foreground">
              {preview.map((c, i) => (
                <li key={i} className="list-disc">
                  {c}
                </li>
              ))}
              {combinations > preview.length && (
                <li className="list-disc">+ {combinations - preview.length} more…</li>
              )}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="sweep-run-after"
            checked={runAfter}
            onCheckedChange={(v) => setRunAfter(v === true)}
          />
          <Label htmlFor="sweep-run-after" className="text-sm font-normal text-muted-foreground">
            Run all variants immediately after creating them
          </Label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Create {combinations > 1 ? `${combinations} variants` : "sweep"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
