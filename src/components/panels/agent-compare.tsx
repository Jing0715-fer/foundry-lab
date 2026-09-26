"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { AgentDTO } from "@/lib/types";
import {
  Bot,
  FlaskConical,
  Dna,
  Microscope,
  Brain,
  Calculator,
  Atom,
  Bug,
  Leaf,
  Beaker,
  Cpu,
  Check,
  X,
  Globe,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Map agent.icon string → lucide component (mirrors agents-panel). */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  bot: Bot,
  "flask-conical": FlaskConical,
  dna: Dna,
  microscope: Microscope,
  brain: Brain,
  calculator: Calculator,
  atom: Atom,
  bug: Bug,
  leaf: Leaf,
  beaker: Beaker,
  cpu: Cpu,
};

function AgentIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const Cmp = ICON_MAP[name] ?? Bot;
  return <Cmp className={className} />;
}

/** Convert a hex color (#rrggbb) to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface Row {
  label: React.ReactNode;
  render: (a: AgentDTO) => React.ReactNode;
}

/** Comparison rows. Each row has a fixed label and a per-agent render function. */
const ROWS: Row[] = [
  {
    label: "Expertise",
    render: (a) => <span className="text-xs">{a.expertise || "—"}</span>,
  },
  {
    label: "Goal",
    render: (a) => (
      <p className="text-xs leading-relaxed text-muted-foreground">
        {a.goal || "—"}
      </p>
    ),
  },
  {
    label: "Role",
    render: (a) => (
      <p className="text-xs leading-relaxed text-muted-foreground">
        {a.role || "—"}
      </p>
    ),
  },
  {
    label: "Model",
    render: (a) => <Badge variant="outline" className="text-[10px]">{a.model || "default"}</Badge>,
  },
  {
    label: "Domain Knowledge",
    render: (a) => {
      const items = a.knowledge?.domainKnowledge ?? [];
      if (!items.length) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <ul className="space-y-1">
          {items.map((k, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs">
              <span
                className="mt-1 size-1.5 shrink-0 rounded-full"
                style={{ background: a.color }}
              />
              <span className="leading-snug">{k}</span>
            </li>
          ))}
        </ul>
      );
    },
  },
  {
    label: "Capabilities",
    render: (a) => {
      const items = a.knowledge?.capabilities ?? [];
      if (!items.length) return <span className="text-xs text-muted-foreground">—</span>;
      return (
        <ul className="space-y-1">
          {items.map((c, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs">
              <span
                className="mt-1 size-1.5 shrink-0 rounded-full"
                style={{ background: a.color }}
              />
              <span className="leading-snug">{c}</span>
            </li>
          ))}
        </ul>
      );
    },
  },
  {
    label: (
      <span className="inline-flex items-center gap-1">
        <Globe className="size-3.5" /> Web Search
      </span>
    ),
    render: (a) =>
      a.knowledge?.webSearchEnabled ? (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="size-4" /> Enabled
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <X className="size-4" /> Disabled
        </span>
      ),
  },
  {
    label: (
      <span className="inline-flex items-center gap-1">
        <Wrench className="size-3.5" /> Bio Tools
      </span>
    ),
    render: (a) =>
      a.knowledge?.bioToolsEnabled ? (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="size-4" /> Enabled
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <X className="size-4" /> Disabled
        </span>
      ),
  },
];

export function AgentCompareDialog({
  agents,
  open,
  onClose,
}: {
  agents: AgentDTO[];
  open: boolean;
  onClose: () => void;
}) {
  // Cap to 4 agents (spec says 2–4).
  const visible = agents.slice(0, 4);
  const tooFew = visible.length < 2;

  // Grid template: 120px label column + one min-200px column per agent.
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `120px repeat(${Math.max(visible.length, 1)}, minmax(200px, 1fr))`,
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            Compare Agents
          </DialogTitle>
        </DialogHeader>

        {tooFew ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <Bot className="size-10 text-muted-foreground/50" />
            <p className="text-sm font-medium">Select at least 2 agents to compare</p>
            <p className="text-xs text-muted-foreground">
              You can compare up to 4 agents side-by-side.
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-[80vh] px-6 pb-6">
            <div className="min-w-max">
              {/* Header row: agent name + icon + color */}
              <div className="grid" style={gridStyle}>
                <div className="sticky left-0 z-10 bg-background pr-3" />
                {visible.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-col items-start gap-2 border-t-[3px] px-3 pb-3 pt-3"
                    style={{ borderTopColor: a.color }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="flex size-8 items-center justify-center rounded-lg"
                        style={{
                          background: hexToRgba(a.color, 0.15),
                          color: a.color,
                        }}
                      >
                        <AgentIcon name={a.icon} className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold leading-tight">
                          {a.title}
                        </p>
                        {a.builtin && (
                          <Badge variant="secondary" className="mt-0.5 text-[9px]">
                            built-in
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Comparison rows */}
              {ROWS.map((row, i) => (
                <div
                  key={i}
                  className={cn(
                    "grid border-t border-border/60",
                    gridStyle,
                  )}
                >
                  <div className="sticky left-0 z-10 bg-background pr-3 py-3">
                    <span className="text-xs font-medium text-muted-foreground">
                      {row.label}
                    </span>
                  </div>
                  {visible.map((a) => (
                    <div
                      key={a.id}
                      className="px-3 py-3 align-top"
                    >
                      {row.render(a)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
