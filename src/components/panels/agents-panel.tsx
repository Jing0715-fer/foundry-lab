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
  BarChart3,
  Play,
  X,
  Sliders,
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
  generateAgentSystemPrompt,
} from "@/lib/agents";
import type { AgentDTO, AgentKnowledgeConfig } from "@/lib/types";
import { useChatStore } from "@/lib/chat-store";
import { AgentChatDrawer } from "./agent-chat-drawer";
import { AgentCompareDialog } from "./agent-compare";
import { AgentAnalyticsDialog } from "./agent-analytics";
import { AgentFineTuneDialog } from "./agent-finetune";
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

/**
 * Tag-input component — each line becomes a removable chip/pill. Typing text
 * and pressing Enter (or comma) adds a chip; the × on each chip removes it.
 * Used for domain knowledge + capabilities arrays in the agent editor.
 */
function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (t: string[]) => void;
  placeholder: string;
}) {
  const [input, setInput] = React.useState("");

  const add = () => {
    const v = input.trim().replace(/,$/, "").trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setInput("");
  };

  return (
    <div
      className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border bg-background p-2 focus-within:ring-1 focus-within:ring-ring"
      onClick={() => {
        // Click anywhere in the chip area focuses the text input.
        const i = document.getElementById(placeholder);
        i?.focus();
      }}
    >
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs"
        >
          {t}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange(tags.filter((x) => x !== t));
            }}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label={`Remove ${t}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !input && tags.length > 0) {
            // Backspace on empty input removes the last chip.
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder={tags.length === 0 ? placeholder : ""}
        className="min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
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
  const [finetuneAgent, setFinetuneAgent] = React.useState<AgentDTO | null>(null);

  // Compare dialog state.
  const [selectOpen, setSelectOpen] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = React.useState(false);

  // Analytics dialog state.
  const [analyticsOpen, setAnalyticsOpen] = React.useState(false);

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
            variant="outline"
            onClick={() => setAnalyticsOpen(true)}
            disabled={agents.length === 0}
            title={agents.length === 0 ? "No agents to analyze" : "View per-agent usage analytics"}
          >
            <BarChart3 className="size-4" />
            Analytics
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
              onFineTune={() => setFinetuneAgent(a)}
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

      <AgentAnalyticsDialog
        open={analyticsOpen}
        onClose={() => setAnalyticsOpen(false)}
      />

      <AgentFineTuneDialog
        agent={finetuneAgent}
        open={!!finetuneAgent}
        onClose={() => setFinetuneAgent(null)}
      />
    </div>
  );
}

function AgentCard({
  agent,
  onChat,
  onEdit,
  onFineTune,
  onDelete,
}: {
  agent: AgentDTO;
  onChat: () => void;
  onEdit: () => void;
  onFineTune: () => void;
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
            variant="outline"
            onClick={onFineTune}
            aria-label="Fine-tune agent"
            title="Fine-tune"
          >
            <Sliders className="size-3.5" />
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
  domainKnowledge: string[];
  capabilities: string[];
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
    domainKnowledge: [],
    capabilities: [],
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
    domainKnowledge: [...(k.domainKnowledge ?? [])],
    capabilities: [...(k.capabilities ?? [])],
    webSearchEnabled: !!k.webSearchEnabled,
    bioToolsEnabled: !!k.bioToolsEnabled,
  };
}

function formToKnowledge(s: AgentFormState): AgentKnowledgeConfig {
  return {
    domainKnowledge: s.domainKnowledge,
    capabilities: s.capabilities,
    webSearchEnabled: s.webSearchEnabled,
    bioToolsEnabled: s.bioToolsEnabled,
  };
}

function formToAgentDTO(s: AgentFormState, id: string): AgentDTO {
  return {
    id,
    title: s.title,
    expertise: s.expertise,
    goal: s.goal,
    role: s.role,
    model: s.model,
    color: s.color,
    icon: s.icon,
    knowledge: formToKnowledge(s),
    builtin: false,
    createdAt: "",
    updatedAt: "",
  };
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

  // Live system prompt preview — regenerated whenever the form changes so
  // the user sees exactly what will be sent to the LLM at run time.
  const systemPrompt = React.useMemo(
    () => generateAgentSystemPrompt(formToAgentDTO(form, editing?.id ?? "")),
    [form, editing?.id],
  );

  const handleTest = () => {
    if (!editing) return;
    // Open the global chat drawer (rendered at the page level) with this
    // agent. Stays out of the way of the modal so the user can chat while
    // the editor remains open for further tweaks.
    useChatStore.getState().openChat(editing.id);
  };

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
              <Label htmlFor="agent-domain">Domain knowledge</Label>
              <TagInput
                tags={form.domainKnowledge}
                onChange={(t) => set("domainKnowledge", t)}
                placeholder="e.g. Computational protein design"
              />
              <p className="text-[11px] text-muted-foreground">
                Press Enter to add a tag. Used to ground the agent's persona.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="agent-capabilities">Capabilities</Label>
              <TagInput
                tags={form.capabilities}
                onChange={(t) => set("capabilities", t)}
                placeholder="e.g. Decompose research questions"
              />
              <p className="text-[11px] text-muted-foreground">
                What this agent can do — surfaced in its system prompt.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="min-w-0 pr-2">
                <Label htmlFor="agent-web" className="text-sm">Web search</Label>
                <p className="text-[11px] text-muted-foreground">
                  Allow the agent to emit <code className="font-mono">```web</code> tool calls to look up real-time information.
                </p>
              </div>
              <Switch
                id="agent-web"
                checked={form.webSearchEnabled}
                onCheckedChange={(v) => set("webSearchEnabled", v)}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="min-w-0 pr-2">
                <Label htmlFor="agent-bio" className="text-sm">Bio tools</Label>
                <p className="text-[11px] text-muted-foreground">
                  Allow <code className="font-mono">```tool</code> + <code className="font-mono">```bio</code> fences (BLAST, PDB, PubMed, UniProt, etc.).
                </p>
              </div>
              <Switch
                id="agent-bio"
                checked={form.bioToolsEnabled}
                onCheckedChange={(v) => set("bioToolsEnabled", v)}
              />
            </div>
          </div>

          {/* Live system-prompt preview */}
          <div className="grid gap-1.5">
            <Label className="flex items-center justify-between">
              <span>System prompt preview</span>
              <span className="text-[10px] font-normal text-muted-foreground">
                auto-generated · read-only
              </span>
            </Label>
            <pre className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
              {systemPrompt}
            </pre>
          </div>
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          {editing ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleTest}
              disabled={saving}
              className="gap-1.5"
            >
              <Play className="size-4" />
              Test agent
            </Button>
          ) : (
            <span className="text-[11px] text-muted-foreground sm:self-center">
              Save the agent to enable testing.
            </span>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {editing ? "Save changes" : "Create agent"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
