"use client";

import * as React from "react";
import {
  Users,
  User,
  Plus,
  Play,
  Trash2,
  Eye,
  Loader2,
  Sparkles,
  Clock,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/lib/store";
import { QUICK_START_AGENDA } from "@/lib/agents";
import type { MeetingDTO, RunStatus, DiscussionMessage } from "@/lib/types";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(1, Math.round((now - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  queued: { label: "Queued", color: "#64748b", bg: "#64748b1a" },
  draft: { label: "Draft", color: "#94a3b8", bg: "#94a3b81a" },
  pending: { label: "Pending", color: "#3b82f6", bg: "#3b82f61a" },
  running: { label: "Running", color: "#f59e0b", bg: "#f59e0b1a" },
  completed: { label: "Completed", color: "#10b981", bg: "#10b9811a" },
  failed: { label: "Failed", color: "#ef4444", bg: "#ef44441a" },
  cancelled: { label: "Cancelled", color: "#6b7280", bg: "#6b72801a" },
};

function StatusPill({ status }: { status: RunStatus | string }) {
  const meta = STATUS_META[status] ?? STATUS_META["draft"];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ color: meta.color, background: meta.bg }}
    >
      {meta.label}
    </span>
  );
}

export function MeetingsPanel() {
  const agents = useAppStore((s) => s.agents);
  const setAgents = useAppStore((s) => s.setAgents);
  const toast = useAppStore((s) => s.toast);

  const [meetings, setMeetings] = React.useState<MeetingDTO[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [transcript, setTranscript] = React.useState<MeetingDTO | null>(null);

  // Form state.
  const [type, setType] = React.useState<"team" | "individual">("team");
  const [agenda, setAgenda] = React.useState("");
  const [saveName, setSaveName] = React.useState("");
  const [numRounds, setNumRounds] = React.useState(3);
  const [temperature, setTemperature] = React.useState(0.7);
  const [leadId, setLeadId] = React.useState<string>("");
  const [memberIds, setMemberIds] = React.useState<string[]>([]);
  const [creating, setCreating] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const [ar, mr] = await Promise.all([
        fetch("/api/agents").then((r) => r.json()),
        fetch("/api/meetings").then((r) => r.json()),
      ]);
      if (Array.isArray(ar)) setAgents(ar);
      if (Array.isArray(mr)) setMeetings(mr);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [setAgents]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll running meetings every 3s.
  React.useEffect(() => {
    const hasRunning = meetings.some((m) => m.status === "running" || m.status === "pending");
    if (!hasRunning) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/meetings");
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) setMeetings(data);
        }
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [meetings]);

  const toggleMember = (id: string) => {
    if (type === "individual") {
      setMemberIds([id]);
      return;
    }
    setMemberIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleCreate = async () => {
    if (!agenda.trim()) {
      toast({
        title: "Missing agenda",
        description: "Agenda is required.",
        variant: "destructive",
      });
      return;
    }
    if (type === "team" && !leadId) {
      toast({
        title: "Missing lead",
        description: "Team meetings require a lead agent.",
        variant: "destructive",
      });
      return;
    }
    if (memberIds.length < 1) {
      toast({
        title: "Missing members",
        description: type === "team" ? "Select at least 1 member." : "Select an agent.",
        variant: "destructive",
      });
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          agenda: agenda.trim(),
          saveName: saveName.trim() || undefined,
          numRounds,
          temperature,
          leadId: leadId || undefined,
          memberIds,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const created: MeetingDTO = await res.json();
      setMeetings((prev) => [created, ...prev]);
      setAgenda("");
      setSaveName("");
      setLeadId("");
      setMemberIds([]);
      setNumRounds(3);
      setTemperature(0.7);
      toast({ title: "Meeting created", variant: "success" });
    } catch (e) {
      toast({
        title: "Create failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleRun = async (id: string) => {
    setMeetings((prev) =>
      prev.map((m) => (m.id === id ? { ...m, status: "running" } : m)),
    );
    try {
      const res = await fetch(`/api/meetings/${id}/run`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? `HTTP ${res.status}`);
      }
      const updated: MeetingDTO = await res.json();
      setMeetings((prev) => prev.map((m) => (m.id === id ? updated : m)));
      toast({ title: "Meeting completed", variant: "success" });
    } catch (e) {
      toast({
        title: "Run failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
      setMeetings((prev) =>
        prev.map((m) => (m.id === id ? { ...m, status: "failed" } : m)),
      );
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/meetings/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMeetings((prev) => prev.filter((m) => m.id !== id));
      toast({ title: "Meeting deleted", variant: "success" });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Meetings</h2>
        <p className="text-sm text-muted-foreground">
          Multi-agent debates — team (round-robin) or individual (with critic).
        </p>
      </div>

      {/* New meeting form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plus className="size-4" />
            New Meeting
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v: "team" | "individual") => {
                setType(v);
                setLeadId("");
                setMemberIds([]);
              }}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="team">team — round-robin</SelectItem>
                  <SelectItem value="individual">individual — with critic</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="meeting-rounds">Rounds</Label>
              <Input
                id="meeting-rounds"
                type="number"
                min={1}
                max={10}
                value={numRounds}
                onChange={(e) => setNumRounds(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="meeting-temp">Temperature</Label>
              <Input
                id="meeting-temp"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value) || 0.7)}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="meeting-agenda">Agenda</Label>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setAgenda(QUICK_START_AGENDA)}
              >
                <Sparkles className="size-3" />
                Use example
              </Button>
            </div>
            <Textarea
              id="meeting-agenda"
              value={agenda}
              onChange={(e) => setAgenda(e.target.value)}
              placeholder="What should the agents discuss?"
              rows={4}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="meeting-save">Save name (optional)</Label>
            <Input
              id="meeting-save"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Friendly name to find this meeting later"
            />
          </div>

          {type === "team" && (
            <div className="grid gap-1.5">
              <Label>Lead agent</Label>
              <Select value={leadId} onValueChange={setLeadId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose lead…" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>
              {type === "team" ? "Members" : "Subject agent"} ({memberIds.length} selected)
            </Label>
            {agents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No agents available — seed built-ins first.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {agents.map((a) => {
                  const active = memberIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => toggleMember(a.id)}
                      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors ${
                        active ? "border-transparent text-white" : "bg-background hover:bg-accent"
                      }`}
                      style={active ? { background: a.color } : undefined}
                    >
                      <span
                        className="size-2 rounded-full"
                        style={{ background: active ? "#fff" : a.color }}
                      />
                      {a.title}
                    </button>
                  );
                })}
              </div>
            )}
            {type === "individual" && (
              <p className="text-xs text-muted-foreground">
                A Scientific Critic persona will be auto-injected to challenge the subject.
              </p>
            )}
          </div>

          <div className="flex justify-end">
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Create meeting
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Meetings list */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">
          {meetings.length} meeting{meetings.length === 1 ? "" : "s"}
        </h3>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading meetings…
          </div>
        ) : meetings.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
              <Users className="size-8 opacity-50" />
              No meetings yet. Create one above.
            </CardContent>
          </Card>
        ) : (
          meetings.map((m) => (
            <MeetingCard
              key={m.id}
              meeting={m}
              agents={agents}
              onRun={() => handleRun(m.id)}
              onView={() => setTranscript(m)}
              onDelete={() => handleDelete(m.id)}
            />
          ))
        )}
      </div>

      {/* Transcript dialog */}
      <Dialog open={!!transcript} onOpenChange={(o) => !o && setTranscript(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {transcript?.type === "team" ? <Users className="size-4" /> : <User className="size-4" />}
              {transcript?.saveName ?? "Meeting transcript"}
            </DialogTitle>
            <DialogDescription>
              {transcript?.numRounds ?? 0} round{(transcript?.numRounds ?? 0) === 1 ? "" : "s"}
              {transcript?.temperature ? ` · T=${transcript.temperature}` : ""}
            </DialogDescription>
          </DialogHeader>
          {transcript?.summary && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Summary</p>
              <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <ReactMarkdown>{transcript.summary}</ReactMarkdown>
              </div>
            </div>
          )}
          {transcript && transcript.messages.length > 0 ? (
            <div className="space-y-3">
              {transcript.messages.map((msg, i) => (
                <TranscriptLine key={i} msg={msg} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No transcript available yet.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}


function MeetingCard({
  meeting,
  agents,
  onRun,
  onView,
  onDelete,
}: {
  meeting: MeetingDTO;
  agents: { id: string; title: string; color: string }[];
  onRun: () => void;
  onView: () => void;
  onDelete: () => void;
}) {
  const isRunning = meeting.status === "running" || meeting.status === "pending";
  const lead = agents.find((a) => a.id === meeting.leadId);
  const members = meeting.memberIds
    .map((id) => agents.find((a) => a.id === id))
    .filter(Boolean) as { id: string; title: string; color: string }[];

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {meeting.type === "team" ? (
                <Users className="size-4 text-emerald-500" />
              ) : (
                <User className="size-4 text-blue-500" />
              )}
              <h4 className="font-medium leading-tight">
                {meeting.saveName ?? (meeting.agenda.slice(0, 60) || "Untitled meeting")}
              </h4>
              <StatusPill status={meeting.status} />
              <Badge variant="outline" className="text-[10px]">{meeting.type}</Badge>
              <Badge variant="outline" className="text-[10px]">{meeting.numRounds}r</Badge>
            </div>
            <p className="line-clamp-2 text-xs text-muted-foreground">{meeting.agenda}</p>
          </div>
          <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
            <Clock className="size-3" />
            {timeAgo(meeting.createdAt)}
          </span>
        </div>

        {(lead || members.length > 0) && (
          <div className="flex flex-wrap gap-1.5">
            {lead && (
              <Badge variant="secondary" className="gap-1 text-[10px]" style={{ background: `${lead.color}1a`, color: lead.color }}>
                <span className="size-1.5 rounded-full" style={{ background: lead.color }} />
                lead: {lead.title}
              </Badge>
            )}
            {members.map((m) => (
              <span
                key={m.id}
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]"
                style={{ background: `${m.color}1a`, color: m.color }}
              >
                <span className="size-1.5 rounded-full" style={{ background: m.color }} />
                {m.title}
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" variant="default" onClick={onRun} disabled={isRunning}>
            {isRunning ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            Run
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onView}
            disabled={meeting.messages.length === 0 && !meeting.summary}
          >
            <Eye className="size-3.5" />
            View transcript
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} className="ml-auto text-destructive hover:text-destructive">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TranscriptLine({ msg }: { msg: DiscussionMessage }) {
  const color = msg.agentColor ?? "#64748b";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="size-2 rounded-full" style={{ background: color }} />
        <span className="font-medium" style={{ color }}>{msg.agentName}</span>
        {typeof msg.roundIndex === "number" && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
            round {msg.roundIndex + 1}
          </span>
        )}
        {msg.phase && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">{msg.phase}</span>
        )}
      </div>
      <div className="ml-4 rounded-md bg-muted px-3 py-2 text-sm">
        <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <ReactMarkdown>{msg.message}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}


