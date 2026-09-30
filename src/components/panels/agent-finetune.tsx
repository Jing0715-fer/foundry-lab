"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AgentDTO, AgentRuntimeConfig } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { Loader2, RotateCcw, Sliders } from "lucide-react";

export interface AgentFineTuneDialogProps {
  agent: AgentDTO | null;
  open: boolean;
  onClose: () => void;
}

const DEFAULTS: AgentRuntimeConfig = {
  temperature: 0.7,
  maxTokens: 2000,
  topP: 0.9,
  verbose: false,
  streaming: true,
};

/**
 * Dialog for tuning an agent's runtime behaviour: temperature, max tokens,
 * top-p, an extra system-prompt suffix, plus verbose + streaming toggles.
 *
 * Settings are REAL — persisted to the Agent row (runtime JSON) via
 * PUT /api/agents/:id and applied on every subsequent LLM call:
 *   - temperature / maxTokens / topP → sampling defaults in runAgentTurn
 *     and the streaming chat lane,
 *   - systemPromptSuffix → appended to the agent's system prompt,
 *   - verbose → richer tool-call logging in workflow node logs,
 *   - streaming → whether the chat drawer streams tokens.
 */
export function AgentFineTuneDialog({
  agent,
  open,
  onClose,
}: AgentFineTuneDialogProps) {
  const toast = useAppStore((s) => s.toast);

  const [temperature, setTemperature] = React.useState(
    agent?.runtime?.temperature ?? DEFAULTS.temperature,
  );
  const [maxTokens, setMaxTokens] = React.useState(
    agent?.runtime?.maxTokens ?? DEFAULTS.maxTokens,
  );
  const [topP, setTopP] = React.useState(agent?.runtime?.topP ?? DEFAULTS.topP);
  const [systemPromptSuffix, setSystemPromptSuffix] = React.useState(
    agent?.runtime?.systemPromptSuffix ?? "",
  );
  const [verbose, setVerbose] = React.useState(
    agent?.runtime?.verbose ?? DEFAULTS.verbose,
  );
  const [streaming, setStreaming] = React.useState(
    agent?.runtime?.streaming ?? DEFAULTS.streaming,
  );
  const [saving, setSaving] = React.useState(false);

  // Load the agent's SAVED settings whenever a different agent is opened.
  React.useEffect(() => {
    if (agent) {
      setTemperature(agent.runtime?.temperature ?? DEFAULTS.temperature);
      setMaxTokens(agent.runtime?.maxTokens ?? DEFAULTS.maxTokens);
      setTopP(agent.runtime?.topP ?? DEFAULTS.topP);
      setSystemPromptSuffix(agent.runtime?.systemPromptSuffix ?? "");
      setVerbose(agent.runtime?.verbose ?? DEFAULTS.verbose);
      setStreaming(agent.runtime?.streaming ?? DEFAULTS.streaming);
    }
  }, [agent?.id, open]);

  if (!agent) return null;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const runtime: AgentRuntimeConfig = {
        temperature,
        maxTokens,
        topP,
        verbose,
        streaming,
      };
      const suffix = systemPromptSuffix.trim();
      if (suffix) runtime.systemPromptSuffix = suffix;

      const res = await fetch(`/api/agents/${agent.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtime }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      // Update the agent in the store so every lane sees the new settings.
      const updated: AgentDTO = await res.json();
      useAppStore.setState((s) => ({
        agents: s.agents.map((a) => (a.id === updated.id ? updated : a)),
      }));
      toast({
        title: "Runtime settings saved",
        description: `${updated.title} — temp ${temperature.toFixed(2)} · ${maxTokens} tokens · top-p ${topP.toFixed(2)}`,
        variant: "success",
      });
      onClose();
    } catch (e) {
      toast({
        title: "Failed to save settings",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setTemperature(DEFAULTS.temperature);
    setMaxTokens(DEFAULTS.maxTokens);
    setTopP(DEFAULTS.topP);
    setSystemPromptSuffix("");
    setVerbose(DEFAULTS.verbose);
    setStreaming(DEFAULTS.streaming);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sliders className="size-5" />
            Fine-tune: {agent.title}
          </DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-xs text-muted-foreground">
          Settings persist on the agent and apply to every LLM call it makes
          (chat, meetings, research, workflow nodes).
        </p>
        <div className="space-y-5">
          {/* Temperature */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="finetune-temperature" className="text-sm">
                Temperature
              </Label>
              <Badge variant="secondary">
                {temperature.toFixed(2)}
              </Badge>
            </div>
            <Slider
              id="finetune-temperature"
              min={0}
              max={2}
              step={0.05}
              value={[temperature]}
              onValueChange={(v) => setTemperature(v[0] ?? 0.7)}
            />
            <p className="text-xs text-muted-foreground">
              Low = deterministic, high = creative.
            </p>
          </div>

          {/* Max tokens */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="finetune-maxtokens" className="text-sm">
                Max tokens
              </Label>
              <Badge variant="secondary">{maxTokens}</Badge>
            </div>
            <Slider
              id="finetune-maxtokens"
              min={256}
              max={8192}
              step={256}
              value={[maxTokens]}
              onValueChange={(v) => setMaxTokens(v[0] ?? 2000)}
            />
            <p className="text-xs text-muted-foreground">
              Ceiling on the response length per LLM call.
            </p>
          </div>

          {/* Top-p */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="finetune-topp" className="text-sm">
                Top-p
              </Label>
              <Badge variant="secondary">{topP.toFixed(2)}</Badge>
            </div>
            <Slider
              id="finetune-topp"
              min={0.05}
              max={1}
              step={0.05}
              value={[topP]}
              onValueChange={(v) => setTopP(v[0] ?? 0.9)}
            />
            <p className="text-xs text-muted-foreground">
              Nucleus sampling cutoff.
            </p>
          </div>

          {/* System prompt suffix */}
          <div className="space-y-2">
            <Label htmlFor="finetune-prompt-suffix" className="text-sm">
              Extra system instructions
            </Label>
            <Textarea
              id="finetune-prompt-suffix"
              value={systemPromptSuffix}
              onChange={(e) => setSystemPromptSuffix(e.target.value)}
              placeholder="Optional operator instructions appended to this agent's system prompt…"
              className="min-h-[80px] font-mono text-xs"
            />
          </div>

          {/* Verbose + streaming toggles */}
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="space-y-0.5">
                <Label htmlFor="finetune-verbose" className="text-sm">
                  Verbose tool logging
                </Label>
                <p className="text-xs text-muted-foreground">
                  Log full tool params + result tails in workflow node logs.
                </p>
              </div>
              <Switch
                id="finetune-verbose"
                checked={verbose}
                onCheckedChange={setVerbose}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
              <div className="space-y-0.5">
                <Label htmlFor="finetune-streaming" className="text-sm">
                  Token streaming
                </Label>
                <p className="text-xs text-muted-foreground">
                  Stream responses token-by-token in the chat drawer.
                </p>
              </div>
              <Switch
                id="finetune-streaming"
                checked={streaming}
                onCheckedChange={setStreaming}
              />
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={handleReset}
            disabled={saving}
            className="gap-1.5"
          >
            <RotateCcw className="size-3.5" />
            Reset
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
