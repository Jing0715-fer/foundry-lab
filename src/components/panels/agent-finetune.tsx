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
import { AgentDTO } from "@/lib/types";
import { useAppStore } from "@/lib/store";
import { Sliders, Brain, Save } from "lucide-react";

export interface AgentFineTuneDialogProps {
  agent: AgentDTO | null;
  open: boolean;
  onClose: () => void;
}

/**
 * Dialog for tuning an agent's runtime behaviour: temperature, max tokens,
 * top-p, an extra system-prompt suffix, plus verbose + streaming toggles.
 *
 * Settings are reset whenever a new agent is opened. The "Save settings"
 * action just fires a toast for now (real persistence is a later task).
 */
export function AgentFineTuneDialog({
  agent,
  open,
  onClose,
}: AgentFineTuneDialogProps) {
  const [temperature, setTemperature] = React.useState(0.7);
  const [maxTokens, setMaxTokens] = React.useState(2000);
  const [topP, setTopP] = React.useState(0.9);
  const [systemPromptSuffix, setSystemPromptSuffix] = React.useState("");
  const [verbose, setVerbose] = React.useState(false);
  const [streaming, setStreaming] = React.useState(true);

  // Reset to defaults each time a different agent is opened.
  React.useEffect(() => {
    if (agent) {
      setTemperature(0.7);
      setMaxTokens(2000);
      setTopP(0.9);
      setSystemPromptSuffix("");
      setVerbose(false);
      setStreaming(true);
    }
  }, [agent?.id]);

  if (!agent) return null;

  const handleSave = () => {
    useAppStore.getState().toast({
      title: "Settings saved",
      description: `Temperature: ${temperature.toFixed(2)}`,
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sliders className="size-5" />
            Fine-tune: {agent.title}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          {/* Temperature */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Brain className="size-3.5" /> Temperature
              </Label>
              <Badge variant="secondary">{temperature.toFixed(2)}</Badge>
            </div>
            <Slider
              value={[temperature]}
              onValueChange={(v) => setTemperature(v[0] ?? 0)}
              min={0}
              max={2}
              step={0.05}
            />
            <p className="text-xs text-muted-foreground">
              Lower = focused, Higher = creative
            </p>
          </div>

          {/* Max tokens */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Max tokens</Label>
              <Badge variant="secondary">{maxTokens}</Badge>
            </div>
            <Slider
              value={[maxTokens]}
              onValueChange={(v) => setMaxTokens(v[0] ?? 0)}
              min={100}
              max={8000}
              step={100}
            />
          </div>

          {/* Top P */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Top P</Label>
              <Badge variant="secondary">{topP.toFixed(2)}</Badge>
            </div>
            <Slider
              value={[topP]}
              onValueChange={(v) => setTopP(v[0] ?? 0)}
              min={0}
              max={1}
              step={0.05}
            />
          </div>

          {/* System prompt suffix */}
          <div className="space-y-2">
            <Label>Additional system prompt</Label>
            <Textarea
              value={systemPromptSuffix}
              onChange={(e) => setSystemPromptSuffix(e.target.value)}
              placeholder="Add extra instructions for this agent..."
              className="min-h-[80px]"
            />
          </div>

          {/* Switches */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Verbose output</Label>
                <p className="text-xs text-muted-foreground">
                  Include reasoning traces
                </p>
              </div>
              <Switch checked={verbose} onCheckedChange={setVerbose} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Stream responses</Label>
                <p className="text-xs text-muted-foreground">
                  Show tokens as they generate
                </p>
              </div>
              <Switch checked={streaming} onCheckedChange={setStreaming} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            <Save className="size-4" /> Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
