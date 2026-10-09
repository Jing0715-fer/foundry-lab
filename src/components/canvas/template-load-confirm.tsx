"use client";

// Template-load confirmation (F-lane, roadmap test-finding #10 — two rounds of
// real incidents: a misclick replaced a 14-node demo workflow with a 5-node
// template). Loading a template REPLACES every node in the current workflow;
// this dialog makes that contract explicit BEFORE the destructive DELETE
// batch runs, and suggests the two safe alternatives (new workflow / version
// snapshot). Shared by the Templates panel and the Template Marketplace.

import * as React from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, GitBranch, Plus } from "lucide-react";

export interface TemplateLoadConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Name of the template about to be loaded. */
  templateName: string;
  /** How many nodes the template will create. */
  templateNodeCount: number;
  /** Current workflow name (null = unknown). */
  workflowName: string | null;
  /** Nodes in the current workflow that will be DELETED (edges cascade). */
  currentNodes: number;
  currentEdges: number;
  /** Called when the user accepts the replacement. */
  onConfirm: () => void;
}

export function TemplateLoadConfirm({
  open,
  onOpenChange,
  templateName,
  templateNodeCount,
  workflowName,
  currentNodes,
  currentEdges,
  onConfirm,
}: TemplateLoadConfirmProps) {
  const wfLabel = workflowName?.trim() || "the current workflow";
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="template-load-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 shrink-0 text-amber-500" />
            Replace “{workflowName?.trim() || "Current workflow"}”?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Loading <span className="font-medium text-foreground">“{templateName}”</span>{" "}
                replaces <span className="font-medium text-foreground">{wfLabel}</span> entirely:
                the current{" "}
                <span className="font-medium text-foreground">
                  {currentNodes} node{currentNodes === 1 ? "" : "s"}
                </span>{" "}
                (and {currentEdges} edge{currentEdges === 1 ? "" : "s"} — including run results
                and notes) will be deleted, and{" "}
                <span className="font-medium text-foreground">
                  {templateNodeCount} new node{templateNodeCount === 1 ? "" : "s"}
                </span>{" "}
                will be created.
              </p>
              <p className="flex items-start gap-1.5">
                <GitBranch className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Keep the old graph? Save a{" "}
                  <span className="font-medium text-foreground">version snapshot</span> from the
                  Templates panel first — snapshots survive replacement.
                </span>
              </p>
              <p className="flex items-start gap-1.5">
                <Plus className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Or load into a{" "}
                  <span className="font-medium text-foreground">new workflow</span> (Switch
                  workflow → New) to keep both.
                </span>
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="template-load-confirm-accept"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm()}
          >
            Delete {currentNodes} node{currentNodes === 1 ? "" : "s"} &amp; load
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Guard helper: should a template load into the given current workflow
 * require confirmation? Only when there is something to destroy.
 */
export function needsTemplateConfirm(
  currentNodes: number | undefined | null,
): boolean {
  return (currentNodes ?? 0) > 0;
}
