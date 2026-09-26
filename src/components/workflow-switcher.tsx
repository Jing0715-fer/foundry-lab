"use client";

import * as React from "react";
import {
  ChevronDown,
  Plus,
  Trash2,
  Pencil,
  Check,
  FileText,
} from "lucide-react";

import { useAppStore } from "@/lib/store";
import { useWorkflowListStore } from "@/lib/workflow-store";
import type { WorkflowDTO } from "@/lib/types";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/** Compact relative time string — "just now", "5m ago", "3h ago", "2d ago", "2025-01-15". */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Header dropdown that lets the user switch between workflows, create a new
 * one, rename, and delete. Replaces the old read-only workflow-name Input in
 * the header.
 */
export function WorkflowSwitcher() {
  const workflow = useAppStore((s) => s.workflow);
  const setWorkflow = useAppStore((s) => s.setWorkflow);
  const toast = useAppStore((s) => s.toast);

  const workflows = useWorkflowListStore((s) => s.workflows);
  const activeId = useWorkflowListStore((s) => s.activeId);
  const load = useWorkflowListStore((s) => s.load);
  const setActive = useWorkflowListStore((s) => s.setActive);
  const create = useWorkflowListStore((s) => s.create);
  const rename = useWorkflowListStore((s) => s.rename);
  const remove = useWorkflowListStore((s) => s.remove);

  // ── Dialog + AlertDialog state ───────────────────────────────────────────
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  // Inline-rename state: the workflow id being renamed + the working value.
  const [renameId, setRenameId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  const [switching, setSwitching] = React.useState<string | null>(null);

  // ── Sync activeId from useAppStore.workflow ──────────────────────────────
  React.useEffect(() => {
    if (workflow?.id) setActive(workflow.id);
  }, [workflow?.id, setActive]);

  // ── On mount, load the workflow list. ────────────────────────────────────
  React.useEffect(() => {
    load();
  }, [load]);

  // ── Switching handler ───────────────────────────────────────────────────
  async function handleSwitch(id: string) {
    if (id === workflow?.id) return;
    setSwitching(id);
    try {
      const res = await fetch(`/api/workflows/${id}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const wf: WorkflowDTO = await res.json();
      setWorkflow(wf);
      setActive(id);
      toast({
        title: "Workflow switched",
        description: wf.name,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Switch failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSwitching(null);
    }
  }

  // ── Create handler ──────────────────────────────────────────────────────
  async function handleCreate() {
    setCreating(true);
    try {
      const name = createName.trim() || undefined;
      const wf = await create(name);
      if (!wf) throw new Error("Server rejected create");
      setWorkflow(wf);
      setActive(wf.id);
      setCreateOpen(false);
      setCreateName("");
      toast({
        title: "Workflow created",
        description: wf.name,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Create failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  // ── Rename handlers ──────────────────────────────────────────────────────
  function startRename(id: string, currentName: string) {
    setRenameId(id);
    setRenameValue(currentName);
  }

  async function commitRename(id: string) {
    const name = renameValue.trim();
    if (!name) {
      setRenameId(null);
      return;
    }
    try {
      await rename(id, name);
      // If renaming the active workflow, reflect the change in the canvas store.
      if (id === workflow?.id && workflow) {
        setWorkflow({ ...workflow, name });
      }
      setRenameId(null);
      toast({
        title: "Renamed",
        description: name,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Rename failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      setRenameId(null);
    }
  }

  // ── Delete handler ───────────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const wasActive = deleteId === workflow?.id;
      await remove(deleteId);
      setDeleteId(null);

      if (wasActive) {
        // Switch to the first remaining workflow (newest-first).
        const fresh = useWorkflowListStore.getState().workflows;
        const next = fresh[0]?.id;
        if (next) {
          await handleSwitch(next);
        } else {
          // No workflows remain — the DELETE route guarantees a new default,
          // so refresh the list and load that new one.
          await load();
          const list = useWorkflowListStore.getState().workflows;
          if (list[0]) {
            await handleSwitch(list[0].id);
          }
        }
      }
      toast({
        title: "Workflow deleted",
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  }

  const triggerLabel = workflow?.name ?? "Select workflow";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 max-w-[16rem] gap-1.5 px-3 text-sm font-medium"
            aria-label="Switch workflow"
          >
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          className="w-72"
          sideOffset={6}
        >
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            Switch workflow
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {workflows.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              {useWorkflowListStore.getState().loading
                ? "Loading…"
                : "No workflows yet"}
            </div>
          ) : (
            workflows.map((w) => {
              const isActive = w.id === activeId;
              const isRenaming = renameId === w.id;
              const isSwitching = switching === w.id;

              return (
                <div
                  key={w.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-sm px-1 py-1",
                    isActive && "bg-accent/40",
                  )}
                >
                  {isRenaming ? (
                    <div className="flex flex-1 items-center gap-1 px-1">
                      <Input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename(w.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setRenameId(null);
                          }
                        }}
                        className="h-7 flex-1 text-xs"
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={() => commitRename(w.id)}
                        aria-label="Save name"
                      >
                        <Check className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        handleSwitch(w.id);
                      }}
                      disabled={isSwitching}
                      className="flex-1 gap-2 py-1.5"
                    >
                      <span
                        className={cn(
                          "truncate font-medium",
                          isActive && "text-primary",
                        )}
                      >
                        {w.name}
                      </span>
                      <span className="ml-auto flex items-center gap-1.5">
                        <span className="inline-flex items-center rounded-md border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {w.nodeCount}n
                        </span>
                        <span className="hidden text-[10px] text-muted-foreground sm:inline">
                          {relativeTime(w.updatedAt)}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  )}

                  {!isRenaming && (
                    <div className="flex shrink-0 items-center">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          startRename(w.id, w.name);
                        }}
                        aria-label={`Rename ${w.name}`}
                      >
                        <Pencil className="size-3.5 text-muted-foreground" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 hover:text-destructive"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDeleteId(w.id);
                        }}
                        aria-label={`Delete ${w.name}`}
                      >
                        <Trash2 className="size-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setCreateOpen(true);
            }}
            className="gap-2 text-primary"
          >
            <Plus className="size-4" />
            <span>Create new workflow</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Create-new dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setCreateName("");
        }}
      >
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>Create new workflow</DialogTitle>
            <DialogDescription>
              Give your workflow a name. You can rename it any time.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="wf-name">Name</Label>
            <Input
              id="wf-name"
              autoFocus
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="e.g. Antibody Design v2"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCreate();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(o) => {
          if (!o) setDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the workflow along with all of its
              nodes and edges. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Prevent the alert from auto-closing before the async
                // delete + auto-switch finishes; we close it from
                // handleDelete via setDeleteId(null) once done.
                e.preventDefault();
                handleDelete();
              }}
              disabled={deleting}
              className={cn(
                deleting && "pointer-events-none opacity-60",
              )}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
