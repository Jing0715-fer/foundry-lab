"use client";

import * as React from "react";
import {
  Bot,
  FlaskConical,
  Dna,
  Microscope,
  Brain,
  Calculator,
  Atom,
  Bug,
  Leaf,
  Beaker,
  Cpu,
  Plus,
  Pencil,
  Trash2,
  MessageSquare,
  Loader2,
  Sparkles,
  GitCompare,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/lib/store";
import {
  AGENT_COLOR_OPTIONS,
  AGENT_ICON_OPTIONS,
  DEFAULT_KNOWLEDGE,
} from "@/lib/agents";
import type { AgentDTO, AgentKnowledgeConfig } from "@/lib/types";
import { AgentChatDrawer } from "./agent-chat-drawer";
import { AgentCompareDialog } from "./agent-compare";
import { EmptyState, PanelSkeleton } from "@/components/empty-state";
import { cn } from "@/lib/utils";

/** Map agent.icon string → lucide component. */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  bot: Bot,
  "flask-conical": FlaskConical,
  dna: Dna,
  microscope: Microscope,
  brain: Brain,
  calculator: Calculator,
  atom: Atom,
  bug: Bug,
  leaf: Leaf,
  beaker: Beaker,
  cpu: Cpu,
};

function AgentIcon({ name, className }: { name: string; className?: string }) {
  const Cmp = ICON_MAP[name] ?? Bot;
  return <Cmp className={className} />;
}

/** Convert a hex color (#rrggbb) to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function AgentsPanel() {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const toast = useAppStore((s) => s.toast);

  const [loading, setLoading] = React.useState(true);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<AgentDTO | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [seeding, setSeeding] = React.useState(false);

  // Compare dialog state.
  const [selectOpen, setSelectOpen] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = React.useState(false);

  const compareAgents = React.useMemo(
    () => agents.filter((a) => selectedIds.has(a.id)),
    [agents, selectedIds],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= 4) {
          toast({
            title: "Compare limit reached",
            description: "You can compare up to 4 agents at once.",
            variant: "destructive",
          });
          return prev;
        }
        next.add(id);
      }
      return next;
    });
  };

  const handleOpenCompare = () => {
    if (compareAgents.length < 2) {
      toast({
        title: "Select more agents",
        description: "Pick at least 2 agents to compare.",
        variant: "destructive",
      });
      return;
    }
    setSelectOpen(false);
    setCompareOpen(true);
  };

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [setAgents]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSeed = async () => {
    setSeeding(true);
    try {
      const res = await fetch("/api/seed", { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      await refresh();
      toast({
        title: "Seeded built-in agents",
        description: `${data?.agents ?? 0} agents ensured.`,
        variant: "success",
      });
    } catch (e) {
      toast({
        title: "Seed failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSeeding(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      const res = await fetch(`/api/agents/${deleteId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Agent deleted", variant: "success" });
      await refresh();
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setDeleteId(null);
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Agents</h2>
          <p className="text-sm text-muted-foreground">
            Configure research personas, expertise, and tool access.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleSeed} disabled={seeding}>
            {seeding ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Seed Built-in
          </Button>
          <Button
            variant="outline"
            onClick={() => setSelectOpen(true)}
            disabled={agents.length < 2}
            title={agents.length < 2 ? "Need at least 2 agents to compare" : "Compare agents side-by-side"}
          >
            <GitCompare className="size-4" />
            Compare
          </Button>
          <Button
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="size-4" />
            New Agent
          </Button>
        </div>
      </div>

      {loading ? (
        <PanelSkeleton count={3} />
      ) : agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description="Seed the built-in personas or create your own."
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleSeed} disabled={seeding}>
                {seeding ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                Seed built-in
              </Button>
              <Button onClick={() => setEditorOpen(true)}>
                <Plus className="size-4" />
                New Agent
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              onChat={() => setChatId(a.id)}
              onEdit={() => {
                setEditing(a);
                setEditorOpen(true);
              }}
              onDelete={() => setDeleteId(a.id)}
            />
          ))}
        </div>
      )}

      <AgentEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editing={editing}
        onSaved={refresh}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the agent and its chat history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-white hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AgentChatDrawer
        agentId={chatId}
        open={!!chatId}
        onClose={() => setChatId(null)}
      />

      {/* Agent selection dialog → opens the compare dialog */}
      <Dialog
        open={selectOpen}
        onOpenChange={(o) => {
          setSelectOpen(o);
          if (!o) setSelectedIds(new Set());
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitCompare className="size-4" />
              Compare agents
            </DialogTitle>
            <DialogDescription>
              Select 2–4 agents to view side-by-side.{" "}
              <span className="font-medium text-foreground">
                {selectedIds.size}/4 selected
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[55vh] space-y-1.5 overflow-y-auto py-1">
            {agents.map((a) => {
              const checked = selectedIds.has(a.id);
              const softBg = hexToRgba(a.color, 0.12);
              return (
                <label
                  key={a.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border p-2.5 transition-colors",
                    checked
                      ? "border-primary/40 bg-primary/5"
                      : "border-border hover:bg-accent",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleSelect(a.id)}
                  />
                  <span
                    className="flex size-8 items-center justify-center rounded-lg"
                    style={{ background: softBg, color: a.color }}
                  >
                    <AgentIcon name={a.icon} className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-tight">
                      {a.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {a.expertise}
                    </p>
                  </div>
                  {a.builtin && (
                    <Badge variant="secondary" className="text-[9px]">
                      built-in
                    </Badge>
                  )}
                </label>
              );
            })}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSelectOpen(false);
                setSelectedIds(new Set());
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleOpenCompare}
              disabled={compareAgents.length < 2}
            >
              <GitCompare className="size-4" />
              Compare {compareAgents.length > 0 && `(${compareAgents.length})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AgentCompareDialog
        agents={compareAgents}
        open={compareOpen}
        onClose={() => {
          setCompareOpen(false);
          setSelectedIds(new Set());
        }}
      />
    </div>
  );
}

function AgentCard({
  agent,
  onChat,
  onEdit,
  onDelete,
}: {
  agent: AgentDTO;
  onChat: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const capabilities = agent.knowledge?.capabilities ?? [];
  const visibleCaps = capabilities.slice(0, 3);
  const extraCaps = Math.max(0, capabilities.length - visibleCaps.length);
  const softBg = hexToRgba(agent.color, 0.12);
  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md">
      <div className="h-[3px] w-full" style={{ background: agent.color }} />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className="flex size-10 items-center justify-center rounded-xl"
              style={{ background: softBg, color: agent.color }}
            >
              <AgentIcon name={agent.icon} className="size-5" />
            </span>
            <div>
              <CardTitle className="text-base leading-tight">{agent.title}</CardTitle>
              <p className="text-xs text-muted-foreground">{agent.expertise}</p>
            </div>
          </div>
          {agent.builtin && <Badge variant="secondary" className="text-[10px]">built-in</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="line-clamp-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Goal: </span>
          {agent.goal}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {visibleCaps.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px]">{c}</Badge>
          ))}
          {extraCaps > 0 && (
            <Badge variant="secondary" className="text-[10px]">+{extraCaps} more</Badge>
          )}
          {agent.knowledge?.bioToolsEnabled && (
            <Badge variant="outline" className="text-[10px]">bio tools</Badge>
          )}
          {agent.knowledge?.webSearchEnabled && (
            <Badge variant="outline" className="text-[10px]">web</Badge>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="default" onClick={onChat} className="flex-1 gap-1.5">
            <MessageSquare className="size-3.5" />
            Chat
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit} className="flex-1 gap-1.5">
            <Pencil className="size-3.5" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            className="text-destructive hover:text-destructive"
            aria-label="Delete agent"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface AgentFormState {
  title: string;
  expertise: string;
  goal: string;
  role: string;
  model: string;
  color: string;
  icon: string;
  domainKnowledge: string;
  capabilities: string;
  webSearchEnabled: boolean;
  bioToolsEnabled: boolean;
}

function emptyForm(): AgentFormState {
  return {
    title: "",
    expertise: "",
    goal: "",
    role: "",
    model: "default",
    color: AGENT_COLOR_OPTIONS[0],
    icon: AGENT_ICON_OPTIONS[0],
    domainKnowledge: "",
    capabilities: "",
    webSearchEnabled: true,
    bioToolsEnabled: true,
  };
}

function stateFromAgent(a: AgentDTO): AgentFormState {
  const k = a.knowledge ?? DEFAULT_KNOWLEDGE;
  return {
    title: a.title,
    expertise: a.expertise,
    goal: a.goal,
    role: a.role,
    model: a.model,
    color: a.color,
    icon: a.icon,
    domainKnowledge: (k.domainKnowledge ?? []).join("\n"),
    capabilities: (k.capabilities ?? []).join("\n"),
    webSearchEnabled: !!k.webSearchEnabled,
    bioToolsEnabled: !!k.bioToolsEnabled,
  };
}

function formToKnowledge(s: AgentFormState): AgentKnowledgeConfig {
  return {
    domainKnowledge: splitLines(s.domainKnowledge),
    capabilities: splitLines(s.capabilities),
    webSearchEnabled: s.webSearchEnabled,
    bioToolsEnabled: s.bioToolsEnabled,
  };
}

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function AgentEditorDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: AgentDTO | null;
  onSaved: () => void;
}) {
  const toast = useAppStore((s) => s.toast);
  const [form, setForm] = React.useState<AgentFormState>(emptyForm());
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(editing ? stateFromAgent(editing) : emptyForm());
    }
  }, [open, editing]);

  const set = <K extends keyof AgentFormState>(k: K, v: AgentFormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async () => {
    if (!form.title.trim() || !form.expertise.trim() || !form.goal.trim() || !form.role.trim()) {
      toast({
        title: "Missing fields",
        description: "Title, expertise, goal, and role are required.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    const payload = {
      title: form.title.trim(),
      expertise: form.expertise.trim(),
      goal: form.goal.trim(),
      role: form.role.trim(),
      model: form.model,
      color: form.color,
      icon: form.icon,
      knowledge: formToKnowledge(form),
    };
    try {
      const res = editing
        ? await fetch(`/api/agents/${editing.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      toast({
        title: editing ? "Agent updated" : "Agent created",
        variant: "success",
      });
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit agent" : "New agent"}</DialogTitle>
          <DialogDescription>
            Configure the persona, expertise, and tool access for this agent.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-title">Title</Label>
              <Input
                id="agent-title"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="e.g. Principal Investigator"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="agent-expertise">Expertise</Label>
              <Input
                id="agent-expertise"
                value={form.expertise}
                onChange={(e) => set("expertise", e.target.value)}
                placeholder="e.g. Scientific strategy"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-goal">Goal</Label>
              <Textarea
                id="agent-goal"
                value={form.goal}
                onChange={(e) => set("goal", e.target.value)}
                placeholder="The agent's objective."
                rows={2}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="agent-role">Role</Label>
              <Textarea
                id="agent-role"
                value={form.role}
                onChange={(e) => set("role", e.target.value)}
                placeholder="e.g. Team lead — sets agenda, moderates debate."
                rows={2}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Model</Label>
              <Select value={form.model} onValueChange={(v) => set("model", v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">default</SelectItem>
                  <SelectItem value="glm-4.5">glm-4.5</SelectItem>
                  <SelectItem value="glm-4.6">glm-4.6</SelectItem>
                  <SelectItem value="gpt-4o">gpt-4o</SelectItem>
                  <SelectItem value="claude-sonnet">claude-sonnet</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Icon</Label>
              <Select value={form.icon} onValueChange={(v) => set("icon", v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_ICON_OPTIONS.map((ic) => (
                    <SelectItem key={ic} value={ic}>
                      {ic}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-2">
              {AGENT_COLOR_OPTIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set("color", c)}
                  className={`size-7 rounded-full border-2 transition-transform ${
                    form.color === c ? "scale-110 border-foreground" : "border-transparent"
                  }`}
                  style={{ background: c }}
                  aria-label={`Color ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="agent-domain">Domain knowledge (one per line)</Label>
              <Textarea
                id="agent-domain"
                value={form.domainKnowledge}
                onChange={(e) => set("domainKnowledge", e.target.value)}
                placeholder="Computational protein design&#10;Wet-lab validation strategy"
                rows={3}
                className="font-mono text-xs"
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="agent-capabilities">Capabilities (one per line)</Label>
              <Textarea
                id="agent-capabilities"
                value={form.capabilities}
                onChange={(e) => set("capabilities", e.target.value)}
                placeholder="Decompose research questions&#10;Critically evaluate arguments"
                rows={3}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="agent-web" className="text-sm">Web search</Label>
                <p className="text-xs text-muted-foreground">Allow web search tool calls</p>
              </div>
              <Switch
                id="agent-web"
                checked={form.webSearchEnabled}
                onCheckedChange={(v) => set("webSearchEnabled", v)}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="agent-bio" className="text-sm">Bio tools</Label>
                <p className="text-xs text-muted-foreground">Allow BLAST/PDB/etc.</p>
              </div>
              <Switch
                id="agent-bio"
                checked={form.bioToolsEnabled}
                onCheckedChange={(v) => set("bioToolsEnabled", v)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {editing ? "Save changes" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
