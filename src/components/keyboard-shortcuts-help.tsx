"use client";
import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Keyboard, Search, Undo2, Redo2, Play, Trash2, MousePointerClick, Plus } from "lucide-react";

type IconType = typeof Keyboard;

interface ShortcutItem {
  keys: string[];
  desc: string;
  icon: IconType | null;
}

interface ShortcutGroup {
  category: string;
  items: ShortcutItem[];
}

const SHORTCUTS: ShortcutGroup[] = [
  { category: "Global", items: [
    { keys: ["Ctrl", "K"], desc: "Open command palette", icon: Search },
    { keys: ["?"], desc: "Show this help", icon: Keyboard },
    { keys: ["Esc"], desc: "Close dialog / cancel action", icon: null },
  ]},
  { category: "Canvas", items: [
    { keys: ["Ctrl", "Z"], desc: "Undo", icon: Undo2 },
    { keys: ["Ctrl", "Shift", "Z"], desc: "Redo", icon: Redo2 },
    { keys: ["Ctrl", "F"], desc: "Find node on canvas", icon: Search },
    { keys: ["Double-click"], desc: "Add node at cursor", icon: Plus },
    { keys: ["Shift+drag"], desc: "Rubber-band select", icon: MousePointerClick },
    { keys: ["Del"], desc: "Delete selected node", icon: Trash2 },
    { keys: ["Ctrl", "Enter"], desc: "Run selected node", icon: Play },
  ]},
  { category: "Navigation", items: [
    { keys: ["Scroll"], desc: "Zoom in/out", icon: null },
    { keys: ["Drag"], desc: "Pan canvas", icon: MousePointerClick },
  ]},
];

// (Reserved: future "quick-run" shortcut row uses Zap.)

export function KeyboardShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="size-5" />
            Keyboard Shortcuts
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-2">
          {SHORTCUTS.map((group) => (
            <div key={group.category} className="space-y-3">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{group.category}</h3>
              <div className="space-y-2">
                {group.items.map((item) => (
                  <div key={item.desc} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm">
                      {item.icon && <item.icon className="size-3.5 text-muted-foreground" />}
                      <span>{item.desc}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {item.keys.map((k) => (
                        <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 text-[10px] font-mono font-medium shadow-sm">
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
