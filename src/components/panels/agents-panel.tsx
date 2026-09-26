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
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          Loading agents…
        </div>
      ) : agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Bot className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No agents yet. Seed the built-in personas or create a custom one.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleSeed} disabled={seeding}>
                Seed built-in
              </Button>
              <Button onClick={() => setEditorOpen(true)}>
                <Plus className="size-4" />
                New Agent
              </Button>
            </div>
          </CardContent>
        </Card>
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
  return (
    <Card className="overflow-hidden">
      <div className="h-1.5 w-full" style={{ background: agent.color }} />
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span
              className="flex size-9 items-center justify-center rounded-lg text-white"
              style={{ background: agent.color }}
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
          {agent.knowledge.bioToolsEnabled && (
            <Badge variant="outline" className="text-[10px]">bio tools</Badge>
          )}
          {agent.knowledge.webSearchEnabled && (
            <Badge variant="outline" className="text-[10px]">web</Badge>
          )}
          <Badge variant="outline" className="text-[10px]">{agent.role.split(" ")[0]}</Badge>
        </div>
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="default" onClick={onChat} className="flex-1">
            <MessageSquare className="size-3.5" />
            Chat
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="size-3.5" />
            Edit
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} className="text-destructive hover:text-destructive">
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
              placeholder="e.g. Scientific strategy, project leadership"
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="agent-goal">Goal</Label>
            <Textarea
              id="agent-goal"
              value={form.goal}
              onChange={(e) => set("goal", e.target.value)}
              placeholder="One or two sentences describing the agent's objective."
              rows={2}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="agent-role">Role</Label>
            <Input
              id="agent-role"
              value={form.role}
              onChange={(e) => set("role", e.target.value)}
              placeholder="e.g. Team lead — sets agenda, moderates debate."
            />
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
