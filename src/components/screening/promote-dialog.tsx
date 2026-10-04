"use client";

/**
 * PromoteDialog — promotes the selected candidates back onto the workflow
 * canvas.
 *
 * Confirms the node name (default `Screening Picks — <screening name>`), then
 * the parent POSTs /api/screening/[id]/promote. On success the created Input
 * node is upserted into the store, selected, and the app switches to the
 * canvas panel. The node's logs embed the promoted files in a ##OUTPUTS##
 * trailer so downstream tool nodes (ProteinMPNN / AlphaFold …) auto-wire
 * pdb_path / fasta_path from it — FASTA files first.
 */

import * as React from "react";
import { Loader2, Upload } from "lucide-react";
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

interface PromoteDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  screeningName: string;
  /** How many candidates will be promoted. */
  count: number;
  /** Runs the promote POST; resolves true on success, false on failure. */
  onConfirm: (nodeName: string) => Promise<boolean>;
}

export function PromoteDialog({
  open,
  onOpenChange,
  screeningName,
  count,
  onConfirm,
}: PromoteDialogProps) {
  const defaultName = `Screening Picks — ${screeningName}`;
  const [nodeName, setNodeName] = React.useState(defaultName);
  const [busy, setBusy] = React.useState(false);

  // Keep the input in sync when a different screening is promoted.
  React.useEffect(() => {
    if (open) setNodeName(defaultName);
  }, [open, screeningName]);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await onConfirm(nodeName.trim() || defaultName);
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="size-5" />
            Promote to canvas
          </DialogTitle>
          <DialogDescription>
            {count === 1
              ? "Promote 1 candidate back onto the workflow canvas."
              : `Promote ${count} candidates back onto the workflow canvas.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-1.5">
            <Label htmlFor="promote-node-name">Node name</Label>
            <Input
              id="promote-node-name"
              value={nodeName}
              onChange={(e) => setNodeName(e.target.value)}
              className="h-11"
            />
          </div>
          <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
            Creates a <span className="font-medium text-foreground">completed Input node</span>{" "}
            on the canvas whose outputs feed ProteinMPNN / AlphaFold via
            auto-wiring — FASTA files first.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={busy || count === 0}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {busy ? "Promoting…" : `Promote ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
