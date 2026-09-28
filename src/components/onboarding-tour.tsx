"use client";

import * as React from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import {
  FlaskConical,
  LayoutGrid,
  Bot,
  Command,
  SquarePen,
  Boxes,
  X,
  ChevronLeft,
  ChevronRight,
  Check,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";

const TOUR_SEEN_KEY = "foundry-lab:tour-seen";

interface TourState {
  open: boolean;
  step: number;
  start: () => void;
  close: () => void;
  next: () => void;
  back: () => void;
}

/**
 * Tour UI state. Anywhere in the app can call `useTourStore.getState().start()`
 * to relaunch the onboarding (e.g. from a future "Help → Tour" menu item).
 *
 * `close()` persists the "seen" flag silently so the auto-start check on
 * page.tsx mount does not re-trigger after the user dismisses the tour
 * (whether by finishing, skipping, or pressing Esc).
 */
export const useTourStore = create<TourState>((set) => ({
  open: false,
  step: 0,
  start: () => set({ open: true, step: 0 }),
  close: () => {
    try {
      localStorage.setItem(TOUR_SEEN_KEY, "true");
    } catch {
      // localStorage may be unavailable (SSR / private mode) — non-fatal.
    }
    set({ open: false });
  },
  next: () => set((s) => ({ step: s.step + 1 })),
  back: () => set((s) => ({ step: Math.max(0, s.step - 1) })),
}));

interface TourStep {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Tailwind classes — kept literal so the JIT compiler sees them. */
  iconWrap: string;
  iconText: string;
  accent: string;
}

const STEPS: TourStep[] = [
  {
    icon: FlaskConical,
    title: "Welcome to Foundry Lab!",
    description:
      "An agentic research workflow studio. Build visual workflows with AI agents, run multi-agent debates, and execute computational tools.",
    iconWrap: "bg-teal-500/15",
    iconText: "text-teal-600 dark:text-teal-400",
    accent: "bg-teal-500 hover:bg-teal-600",
  },
  {
    icon: LayoutGrid,
    title: "Build on the canvas",
    description:
      "Drag nodes from the left palette onto the canvas. Connect their ports to build a workflow. Double-click empty canvas to add a node.",
    iconWrap: "bg-violet-500/15",
    iconText: "text-violet-600 dark:text-violet-400",
    accent: "bg-violet-500 hover:bg-violet-600",
  },
  {
    icon: Bot,
    title: "Agent personas",
    description:
      "9 pre-defined agents (PI, Critic, Computational Biologist...). Each has knowledge, capabilities, and tool access. Chat 1:1 or add them to meetings.",
    iconWrap: "bg-emerald-500/15",
    iconText: "text-emerald-600 dark:text-emerald-400",
    accent: "bg-emerald-500 hover:bg-emerald-600",
  },
  {
    icon: Command,
    title: "Press Cmd+K",
    description:
      "Quickly navigate, add nodes, run the workflow, or export/import — all from the command palette.",
    iconWrap: "bg-amber-500/15",
    iconText: "text-amber-600 dark:text-amber-400",
    accent: "bg-amber-500 hover:bg-amber-600",
  },
  {
    icon: SquarePen,
    title: "Or submit manually",
    description:
      "Prefer forms? Use the Tasks, Meetings, and Research panels to submit prompts and run multi-agent debates directly.",
    iconWrap: "bg-rose-500/15",
    iconText: "text-rose-600 dark:text-rose-400",
    accent: "bg-rose-500 hover:bg-rose-600",
  },
  {
    icon: Boxes,
    title: "AlphaFold + Bio tools",
    description:
      "Run AlphaFold2 predictions on the GPU cluster (mgt → salloc → gpu05 → module load alphafold2) — plus BLAST, PDB, PubMed searches. Cluster runs use the real AF2; local runs use the built-in classical engine.",
    iconWrap: "bg-cyan-500/15",
    iconText: "text-cyan-600 dark:text-cyan-400",
    accent: "bg-cyan-500 hover:bg-cyan-600",
  },
];

export function OnboardingTour() {
  const open = useTourStore((s) => s.open);
  const step = useTourStore((s) => s.step);
  const close = useTourStore((s) => s.close);
  const next = useTourStore((s) => s.next);
  const back = useTourStore((s) => s.back);
  const toast = useAppStore((s) => s.toast);

  const isLast = step >= STEPS.length - 1;
  const current = STEPS[step] ?? STEPS[0];
  const CurrentIcon = current.icon;

  // Lock body scroll while the tour is open so users don't accidentally
  // scroll the page behind the dimmed backdrop.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Esc closes · ArrowRight advances · ArrowLeft goes back.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowRight" && !isLast) {
        next();
      } else if (e.key === "ArrowLeft" && step > 0) {
        back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, isLast, step, close, next, back]);

  const finish = React.useCallback(() => {
    close();
    toast({
      title: "Welcome aboard!",
      description: "You're all set. Press Cmd+K anytime to jump around.",
      variant: "success",
    });
  }, [close, toast]);

  const handleNext = () => {
    if (isLast) finish();
    else next();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="tour-overlay"
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="dialog"
          aria-modal="true"
          aria-label="Onboarding tour"
        >
          {/* Spotlight / dimmed backdrop */}
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onClick={close}
          />

          <motion.div
            key={`tour-card-${step}`}
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close / skip (corner X) */}
            <button
              type="button"
              onClick={close}
              className="absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Skip tour"
            >
              <X className="size-4" />
            </button>

            {/* Illustration header — colored circle with lucide icon */}
            <div className="flex flex-col items-center gap-3 px-6 pt-8 pb-2 text-center">
              <motion.div
                initial={{ scale: 0.6, rotate: -8 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ duration: 0.35, ease: "backOut" }}
                className={`flex size-16 items-center justify-center rounded-full ${current.iconWrap}`}
              >
                <CurrentIcon className={`size-8 ${current.iconText}`} />
              </motion.div>
              <h2 className="text-lg font-semibold tracking-tight">
                {current.title}
              </h2>
            </div>

            {/* Body */}
            <div className="px-6 pb-4 text-center">
              <p className="text-sm text-muted-foreground">
                {current.description}
              </p>
            </div>

            {/* Progress dots */}
            <div className="flex items-center justify-center gap-1.5 py-2">
              {STEPS.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => useTourStore.setState({ step: i })}
                  className={
                    i === step
                      ? "h-1.5 w-6 rounded-full bg-foreground transition-all"
                      : "h-1.5 w-1.5 rounded-full bg-muted-foreground/40 transition-all hover:bg-muted-foreground/70"
                  }
                  aria-label={`Go to step ${i + 1}`}
                />
              ))}
            </div>

            {/* Footer / actions */}
            <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-2">
                {step > 0 && (
                  <Button variant="ghost" size="sm" onClick={back}>
                    <ChevronLeft className="size-4" />
                    Back
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {step + 1} / {STEPS.length}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={close}
                >
                  Skip
                </Button>
                <Button
                  size="sm"
                  className={`text-white ${current.accent}`}
                  onClick={handleNext}
                >
                  {isLast ? (
                    <>
                      <Check className="size-4" />
                      Got it
                    </>
                  ) : (
                    <>
                      Next
                      <ChevronRight className="size-4" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
