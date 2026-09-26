"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { FlaskConical, Moon, Play, Sun, Github, Loader2, CircleHelp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkflowSwitcher } from "@/components/workflow-switcher";
import { useAppStore } from "@/lib/store";
import { useTourStore } from "@/components/onboarding-tour";

/**
 * Top application bar.
 * - Left: brand chip (FlaskConical in a teal pill) + "Foundry Lab" wordmark.
 * - Center (sm+): workflow switcher (dropdown to list / create / rename / delete).
 * - Right: Run Workflow (Play icon + text), theme toggle, GitHub link.
 * - All elements vertically aligned items-center; subtle shadow-sm under border.
 */
export function Header() {
  const { theme, setTheme } = useTheme();
  const workflow = useAppStore((s) => s.workflow);
  const toast = useAppStore((s) => s.toast);
  const [running, setRunning] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  async function handleRun() {
    if (!workflow) {
      toast({
        title: "No workflow",
        description: "Load a workflow before running.",
        variant: "destructive",
      });
      return;
    }
    setRunning(true);
    toast({
      title: "Workflow started",
      description: `Running "${workflow.name}"…`,
    });
    try {
      const res = await fetch("/api/workflow/run", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast({
        title: "Workflow complete",
        description: `Started ${data?.started ?? 0} • Completed ${
          data?.completed ?? 0
        }`,
        variant: "success",
      });
    } catch (err) {
      toast({
        title: "Run failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  }

  function toggleTheme() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-background/80 px-4 shadow-sm backdrop-blur">
      {/* Left: brand */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/20">
          <FlaskConical className="size-5" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold leading-none">
            Foundry Lab
          </span>
          <span className="mt-1 hidden text-xs leading-none text-muted-foreground sm:inline">
            Agentic Research Studio
          </span>
        </div>
      </div>

      {/* Center: workflow switcher (sm+) */}
      <div className="hidden min-w-0 flex-1 justify-center px-4 sm:flex">
        {workflow ? (
          <WorkflowSwitcher />
        ) : (
          <span className="text-sm text-muted-foreground">
            Loading workflow…
          </span>
        )}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleRun}
          disabled={running || !workflow}
          className="gap-1.5"
        >
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          <span className="hidden sm:inline">Run Workflow</span>
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => useTourStore.getState().start()}
              aria-label="Restart onboarding tour"
            >
              <CircleHelp className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Restart onboarding tour</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={toggleTheme}
              aria-label="Toggle dark mode"
            >
              {mounted && theme === "dark" ? (
                <Sun className="size-4" />
              ) : (
                <Moon className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle dark mode</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon" asChild>
              <a
                href="https://github.com/Jing0715-fer/foundry-lab"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View source on GitHub"
              >
                <Github className="size-4" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>View source on GitHub</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
