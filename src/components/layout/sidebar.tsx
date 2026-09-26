"use client";

import * as React from "react";
import {
  Bot,
  BookOpen,
  LayoutDashboard,
  LayoutGrid,
  LayoutTemplate,
  Loader2,
  Sparkles,
  SquarePen,
  Store,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore } from "@/lib/store";
import { WorkflowTemplates } from "@/components/panels/workflow-templates";
import { TemplateMarketplace } from "@/components/panels/template-marketplace";

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
 * - Top: PI Copilot button (special violet active state, toggles a Sheet
 *   that floats over the canvas so the user can chat with the PI while
 *   watching the workflow build).
 * - Bottom: Seed Data button (POST /api/seed) above a subtle divider.
 */
export function Sidebar({
  piCopilotOpen = false,
  onTogglePiCopilot,
}: {
  piCopilotOpen?: boolean;
  onTogglePiCopilot?: () => void;
} = {}) {
  const activePanel = useAppStore((s) => s.activePanel);
  const setActivePanel = useAppStore((s) => s.setActivePanel);
  const toast = useAppStore((s) => s.toast);
  const [seeding, setSeeding] = React.useState(false);
  const [templatesOpen, setTemplatesOpen] = React.useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = React.useState(false);

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
        {/* PI Copilot — top of the rail. Toggles a Sheet (handled by page.tsx)
            rather than switching activePanel, so the user can chat with the
            PI while still seeing the canvas. Uses a violet-tinted "special"
            active state to distinguish it from the regular nav items. */}
        <li className="mb-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onTogglePiCopilot?.()}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors md:px-3",
                  "justify-center md:justify-start border-l-[3px]",
                  piCopilotOpen
                    ? "bg-violet-500/10 font-medium text-violet-600 border-violet-500"
                    : "border-transparent font-normal text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
                aria-pressed={piCopilotOpen}
              >
                <Bot className="size-4 shrink-0" />
                <span className="hidden truncate md:inline">PI Copilot</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="md:hidden">
              PI Copilot
            </TooltipContent>
          </Tooltip>
        </li>

        <li className="mx-2 my-1 h-px bg-border" aria-hidden />

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
        {/* Templates button — opens a full-screen gallery Dialog. Not a panel
            switcher (the store's activePanel union doesn't include "templates"). */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTemplatesOpen(true)}
              className="mb-2 w-full justify-center gap-2 md:justify-start"
            >
              <LayoutTemplate className="size-4" />
              <span className="hidden md:inline">Templates</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="md:hidden">
            Templates
          </TooltipContent>
        </Tooltip>

        {/* Marketplace button — opens the community templates dialog.
            Distinct from the built-in Templates gallery above: this surfaces
            extended (community-curated) workflow templates. The small pulsing
            dot signals "new" content without taking layout space on the
            icon-only (mobile) rail. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMarketplaceOpen(true)}
              className="relative mb-2 w-full justify-center gap-2 md:justify-start"
            >
              <Store className="size-4" />
              <span className="hidden md:inline">Marketplace</span>
              <span
                className="badge-pulse absolute right-1 top-1 hidden size-2 rounded-full bg-primary md:block"
                aria-hidden
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="md:hidden">
            Marketplace
          </TooltipContent>
        </Tooltip>

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

      <TemplatesDialog
        open={templatesOpen}
        onOpenChange={setTemplatesOpen}
      />

      <TemplateMarketplace
        open={marketplaceOpen}
        onClose={() => setMarketplaceOpen(false)}
      />
    </nav>
  );
}

/** Full-screen Dialog overlay hosting the WorkflowTemplates gallery. */
function TemplatesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] w-full flex-col gap-0 p-0 sm:max-w-4xl"
        showCloseButton={false}
      >
        <DialogHeader className="flex flex-row items-start justify-between gap-4 border-b px-6 py-4">
          <div className="space-y-1">
            <DialogTitle className="flex items-center gap-2">
              <LayoutTemplate className="size-5" />
              Workflow Templates
            </DialogTitle>
            <DialogDescription>
              Load a pre-built workflow with one click. This will replace the
              current canvas.
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            aria-label="Close templates"
          >
            <X className="size-4" />
          </Button>
        </DialogHeader>
        <ScrollArea className="flex-1 overflow-y-auto px-6 py-5">
          <WorkflowTemplates onLoaded={() => onOpenChange(false)} />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
