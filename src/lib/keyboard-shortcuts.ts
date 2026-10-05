"use client";

import { useEffect } from "react";

export interface ShortcutConfig {
  /** Lowercased key name, e.g. "k", "enter", "escape", "delete", "backspace". */
  key: string;
  /** Require Cmd on mac / Ctrl elsewhere. Default false. */
  ctrlKey?: boolean;
  /** Require Shift. Default false. */
  shiftKey?: boolean;
  /** Skip the handler when focus is in a text input / textarea / contenteditable. */
  skipInputs?: boolean;
  /** Prevent the browser's default for this key when the shortcut matches.
   *  Default true. Set false for keys whose native behavior must survive
   *  when the handler DECIDES NOT to act (e.g. Escape inside a text field
   *  should still blur / clear, not cancel a canvas connection) — the
   *  handler then calls e.preventDefault() itself only when it acts. */
  preventDefault?: boolean;
  /** Receives the raw event so it can decide whether to preventDefault. */
  handler: (e: KeyboardEvent) => void;
  /** Human-readable label for help overlays. */
  description: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // Radix / cmdk sometimes trap focus on a div with role="textbox" or similar.
  const role = target.getAttribute("role");
  if (role === "textbox" || role === "combobox" || role === "searchbox") {
    return true;
  }
  return false;
}

/**
 * Register a set of global keyboard shortcuts on `window`.
 *
 * - Each shortcut is matched in order; the first match wins.
 * - `ctrlKey` is treated as the platform modifier (metaKey on mac, ctrlKey
 *   everywhere else) so "Cmd+K" and "Ctrl+K" share a single config.
 * - `skipInputs: true` causes the handler to be ignored while the user is
 *   typing in a form field (useful for keys like Delete / Backspace / Enter
 *   / Escape that have native meaning in inputs).
 * - `preventDefault: false` (default is true) leaves the key's native
 *   behavior intact unless the handler acts and calls e.preventDefault()
 *   itself.
 * - The hook re-binds whenever the `shortcuts` array identity changes.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutConfig[]): void {
  useEffect(() => {
    if (!shortcuts || shortcuts.length === 0) return;

    const onKeyDown = (e: KeyboardEvent) => {
      for (const s of shortcuts) {
        if (e.key.toLowerCase() !== s.key.toLowerCase()) continue;
        if (!!s.ctrlKey !== (e.metaKey || e.ctrlKey)) continue;
        if (!!s.shiftKey !== e.shiftKey) continue;
        if (s.skipInputs && isTypingTarget(e.target)) continue;
        if (s.preventDefault !== false) e.preventDefault();
        s.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts]);
}
