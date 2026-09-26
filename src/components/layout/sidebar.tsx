"use client";

import * as React from "react";
import {
  Bot,
  BookOpen,
  LayoutDashboard,
  LayoutGrid,
  Loader2,
  Sparkles,
  SquarePen,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppStore } from "@/lib/store";

type PanelKey = ReturnType<typeof useAppStore.getState>["activePanel"];

interface NavItem {
  key: PanelKey;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { key: "canvas", label: "Canvas", icon: LayoutGrid },
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "agents", label: "Agents", icon: Bot },
  { key: "tasks", label: "Tasks", icon: SquarePen },
  { key: "meetings", label: "Meetings", icon: Users },
  { key: "research", label: "Research", icon: BookOpen },
  { key: "tools", label: "Tools", icon: Wrench },
];

/**
 * Vertical navigation rail.
 * - w-14 icons-only on mobile; w-56 with labels on md+.
 * - Active item: bg-primary/10 text-primary font-medium + 3px left border accent.
 * - Hover: bg-accent text-accent-foreground.
 * - Bottom: Seed Data button (POST /api/seed) above a subtle divider.
 */
export function Sidebar() {
  const activePanel = useAppStore((s) => s.activePanel);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const toast = useAppStore((s) => s.toast);
  const [seeding, setSeeding] = React.useState(false);

  async function handleSeed() {
    setSeeding(true);
    try {
      const res = await fetch("/api/seed", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast({
        title: "Seed complete",
        description: `${data?.agents ?? 0} agents • ${
          data?.workflow ? "workflow ready" : "no workflow"
        }`,
        variant: "success",
      });
      // Refetch workflow + agents to reflect seeded state.
      await Promise.all([refetchWorkflow(), refetchAgents()]);
    } catch (err) {
      toast({
        title: "Seed failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSeeding(false);
    }
  }

  async function refetchWorkflow() {
    try {
      const res = await fetch("/api/workflow");
      if (res.ok) {
        const w = await res.json();
        useAppStore.getState().setWorkflow(w);
      }
    } catch {
      /* swallow */
    }
  }

  async function refetchAgents() {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const a = await res.json();
        useAppStore.getState().setAgents(a);
      }
    } catch {
      /* swallow */
    }
  }

  return (
    <nav
      className="flex h-full w-14 shrink-0 flex-col border-r bg-sidebar/40 md:w-56"
      aria-label="Primary"
    >
      <ul className="flex flex-1 flex-col gap-1 p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = activePanel === item.key;
          return (
            <li key={item.key}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setActivePanel(item.key)}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors md:px-3",
                      "justify-center md:justify-start border-l-[3px]",
                      active
                        ? "bg-primary/10 font-medium text-primary border-primary"
                        : "border-transparent font-normal text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="hidden md:inline truncate">
                      {item.label}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" className="md:hidden">
                  {item.label}
                </TooltipContent>
              </Tooltip>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto px-2 pb-2">
        <div className="mb-2 h-px bg-border" aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSeed}
              disabled={seeding}
              className="w-full justify-center gap-2 md:justify-start"
            >
              {seeding ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              <span className="hidden md:inline">Seed Data</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="md:hidden">
            Seed Data
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
