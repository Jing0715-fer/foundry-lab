"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore, type ToastItem } from "@/lib/store";

/**
 * Fixed top-right toast stack driven by the Zustand store.
 * The store auto-dismisses each toast after 4.5s; the X button calls
 * dismissToast(id) for an immediate close. Slides in from the right with
 * framer-motion's AnimatePresence handling enter/exit.
 */
const variantStyles: Record<
  NonNullable<ToastItem["variant"]>,
  { ring: string; icon: React.ReactNode }
> = {
  default: {
    ring: "ring-border",
    icon: <Info className="size-4 text-muted-foreground" />,
  },
  success: {
    ring: "ring-emerald-500/30",
    icon: <CheckCircle2 className="size-4 text-emerald-500" />,
  },
  destructive: {
    ring: "ring-destructive/40",
    icon: <XCircle className="size-4 text-destructive" />,
  },
};

export function ToastRenderer() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);

  return (
    <div
      className="pointer-events-none fixed right-3 top-3 z-50 flex w-[min(92vw,360px)] flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const variant = t.variant ?? "default";
          const style = variantStyles[variant];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 40, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover/95 p-3 shadow-lg backdrop-blur ring-1",
                style.ring,
              )}
              role="status"
            >
              <span className="mt-0.5 shrink-0">{style.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{t.title}</p>
                {t.description ? (
                  <p className="mt-0.5 text-xs text-muted-foreground leading-snug break-words">
                    {t.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
