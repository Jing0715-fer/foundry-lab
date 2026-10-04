"use client";

// AlphaFold2 Structure Prediction panel — the app's single prediction tool.
//
// Layering note: AlphaFold2 is an EXTERNAL application, so its lifecycle
// (detection / install / fallback-engine status) lives in the Environment
// sheet alongside every other external tool. THIS page is the usage layer —
// the interactive prediction workbench (sequence in → structure out), the
// same way RFdiffusion/ProteinMPNN get their usage surface via canvas nodes.
// The header cross-links both directions so the relationship stays visible.
//
// Sections (top → bottom):
//   ① Header      — title + live status badges (# connections, cluster
//                   alphafold2 probe state, local engine self-test) +
//                   layer cross-links (Environment / Cluster)
//   ② Guide       — the cluster tutorial as numbered steps with copyable
//                   code blocks, the output-file table and the paths card
//                   (Collapsible; open by default, remembered in
//                   localStorage "foundry-lab:af2-guide")
//   ③ Connection  — SSH access to the mgt login node: select/new/edit,
//                   AlphaFold cluster settings (partition / node / module),
//                   probe test, GPU card availability on the compute node
//   ④ Prediction  — input tabs (sequence / cluster FASTA / features.pkl),
//                   output dir + template date + GPU card, advanced
//                   submission mode (salloc / direct / slurm), live tutorial
//                   command preview, dispatch (cluster 202 / local 201)
//   ⑤ Jobs        — polled alphafold jobs: phase chips, live log tails,
//                   stop, and the 3D output viewer for ranked_*.pdb
//   ⑥ Footer      — honesty note about the local Chou-Fasman baseline
//
// Client-safe imports only: @/lib/tools (parseFastaInput /
// af2OutputDirFor / buildTutorialPreview) and @/lib/types (ToolJobDTO).
// The server-only @/lib/alphafold module is intentionally NOT imported.

import * as React from "react";
import { useAppStore } from "@/lib/store";
import {
  af2OutputDirFor,
  buildTutorialPreview,
  parseFastaInput,
} from "@/lib/tools";
import type { ToolJobDTO } from "@/lib/types";
import type {
  ClusterConnectionDTO,
  ClusterProbeDTO,
  ClusterSubmitMode,
} from "@/lib/cluster/types";
import { OutputViewerDialog } from "@/components/viewers/output-viewer-dialog";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  Award,
  BookOpen,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Cpu,
  Dna,
  FileBox,
  FileText,
  Info,
  Layers,
  Loader2,
  Monitor,
  Pencil,
  Play,
  RefreshCw,
  Server,
  Square,
  Terminal,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── constants ───────────────────────────────────────────────────────────────

/** The tutorial's T1078 fragment (CASP target used in the cluster course). */
const TUTORIAL_FASTA =
  ">T1078\nDYKDDDDASKAPVCQEITVPMCRGIGYNLTHMPNQFNHDTQDEAGLEVHQFWPLVEI";

/** localStorage key remembering the guide card's open/closed state. */
const GUIDE_KEY = "foundry-lab:af2-guide";

/** Select value that opens the connection editor for a new connection. */
const NEW_CONN = "__new__";

/** Tutorial defaults for a cluster's AlphaFold settings. */
const DEFAULT_AF2 = { partition: "brain2", node: "gpu05", module: "alphafold2" };

const GPU_OPTIONS = ["0", "1", "2", "3", "4", "5", "6", "7"];

/** Tutorial output files → what they are (from the course handout). */
const OUTPUT_FILES: ReadonlyArray<readonly [string, string]> = [
  ["features.pkl", "pickled input feature arrays"],
  [
    "unrelaxed_model_*.pdb",
    "raw model output — five structures straight from the network",
  ],
  ["relaxed_model_*.pdb", "the same five structures after Amber relaxation"],
  [
    "ranked_*.pdb",
    "relaxed models re-ordered by pLDDT confidence — ranked_0 highest, ranked_4 lowest (ranking via pLDDT, Jumper et al. 2021 Suppl. 1.9.6)",
  ],
  ["ranking_debug.json", "pLDDT values + the model-name mapping"],
  ["timings.json", "per-stage timing information"],
  [
    "msas/",
    "genetic database hits: bfd_uniclust_hits.a3m, magnify_hits.sto, uniref90_hits.sto",
  ],
  ["result_model_*.pkl", "model NumPy outputs incl. pLDDT / pTM"],
];

// ── local types ─────────────────────────────────────────────────────────────

type InputMode = "sequence" | "fasta" | "features";
type EngineState = "checking" | "ready" | "unavailable" | "unknown";

/** Draft form state for the connection editor. */
interface ConnDraft {
  id?: string;
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  remoteRoot: string;
  af2Partition: string;
  af2Node: string;
  af2Module: string;
}

const EMPTY_DRAFT: ConnDraft = {
  name: "",
  host: "",
  port: "22",
  username: "",
  password: "",
  remoteRoot: "~/foundry-lab",
  af2Partition: DEFAULT_AF2.partition,
  af2Node: DEFAULT_AF2.node,
  af2Module: DEFAULT_AF2.module,
};

function draftFromConn(c: ClusterConnectionDTO): ConnDraft {
  return {
    id: c.id,
    name: c.name,
    host: c.host,
    port: String(c.port),
    username: c.username,
    password: "",
    remoteRoot: c.remoteRoot,
    af2Partition: c.af2?.partition ?? DEFAULT_AF2.partition,
    af2Node: c.af2?.node ?? DEFAULT_AF2.node,
    af2Module: c.af2?.module ?? DEFAULT_AF2.module,
  };
}

interface GpuRow {
  index: number;
  name: string;
  memUsedMiB: number;
  memTotalMiB: number;
  utilPct: number;
}

// ── helpers ─────────────────────────────────────────────────────────────────

type AfPhase =
  | "staging"
  | "running"
  | "syncing"
  | "done"
  | "failed"
  | "cancelled";

const PHASE_STYLE: Record<AfPhase, string> = {
  staging: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
  running: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  syncing: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  done: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  cancelled: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
};

function jobPhase(j: ToolJobDTO): AfPhase {
  if (j.cluster) return j.cluster.phase;
  switch (j.status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "queued":
      return "staging";
    default:
      return "running";
  }
}

function isLivePhase(p: AfPhase): boolean {
  return p === "staging" || p === "running" || p === "syncing";
}

function isLiveJob(j: ToolJobDTO): boolean {
  return isLivePhase(jobPhase(j));
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MiB`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtElapsed(startedIso: string | null, finishedIso?: string | null): string {
  if (!startedIso) return "—";
  const start = new Date(startedIso).getTime();
  const end = finishedIso ? new Date(finishedIso).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** One-line input summary for a job row (from its persisted params). */
function inputSummary(params: Record<string, unknown>): string {
  const featureFile =
    typeof params.feature_file === "string" ? params.feature_file.trim() : "";
  if (featureFile) return `features.pkl · ${basename(featureFile)}`;
  const fastaPath =
    typeof params.fasta_path === "string" ? params.fasta_path.trim() : "";
  if (fastaPath) return `FASTA · ${basename(fastaPath)}`;
  const seq = typeof params.sequence === "string" ? params.sequence : "";
  const parsed = seq ? parseFastaInput(seq) : null;
  if (parsed) return `${parsed.name} · ${parsed.seq.length} aa`;
  return "no input recorded";
}

// ── panel ───────────────────────────────────────────────────────────────────

export default function AlphaFoldPanel() {
  const toast = useAppStore((s) => s.toast);

  // ── connections ─────────────────────────────────────────────────────────
  const [connections, setConnections] = React.useState<ClusterConnectionDTO[]>([]);
  const [loadingConns, setLoadingConns] = React.useState(true);
  const [connError, setConnError] = React.useState<string | null>(null);
  const [selConnId, setSelConnId] = React.useState("");
  const [draft, setDraft] = React.useState<ConnDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [addingMock, setAddingMock] = React.useState(false);

  // probe + gpu availability
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [probeFor, setProbeFor] = React.useState<{
    connId: string;
    probe: ClusterProbeDTO;
  } | null>(null);
  const [probeError, setProbeError] = React.useState<string | null>(null);
  const [gpuRows, setGpuRows] = React.useState<{ node: string; gpus: GpuRow[] } | null>(null);
  const [checkingGpus, setCheckingGpus] = React.useState(false);
  const [gpuError, setGpuError] = React.useState<string | null>(null);

  // local engine self-test (from /api/tools/scan)
  const [engineState, setEngineState] = React.useState<EngineState>("checking");

  // ── guide card ──────────────────────────────────────────────────────────
  const [guideOpen, setGuideOpen] = React.useState<boolean | null>(null);

  // ── prediction form ─────────────────────────────────────────────────────
  const [inputMode, setInputMode] = React.useState<InputMode>("sequence");
  const [sequence, setSequence] = React.useState("");
  const [fastaPath, setFastaPath] = React.useState("");
  const [featureFile, setFeatureFile] = React.useState("");
  const [outputDir, setOutputDir] = React.useState("alphafold_out");
  const [outputDirTouched, setOutputDirTouched] = React.useState(false);
  const [maxTemplateDate, setMaxTemplateDate] = React.useState("2021-07-20");
  const [gpu, setGpu] = React.useState("0");
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [submitMode, setSubmitMode] = React.useState<ClusterSubmitMode>("salloc");
  const [advPartition, setAdvPartition] = React.useState(DEFAULT_AF2.partition);
  const [advNode, setAdvNode] = React.useState(DEFAULT_AF2.node);
  const [advModule, setAdvModule] = React.useState(DEFAULT_AF2.module);
  const [walltimeMin, setWalltimeMin] = React.useState("");

  // ── jobs ────────────────────────────────────────────────────────────────
  const [jobs, setJobs] = React.useState<ToolJobDTO[]>([]);
  const [jobsLoading, setJobsLoading] = React.useState(true);
  const [expandedJob, setExpandedJob] = React.useState<string | null>(null);
  const [viewerJob, setViewerJob] = React.useState<ToolJobDTO | null>(null);
  const [stoppingId, setStoppingId] = React.useState<string | null>(null);
  const [dispatching, setDispatching] = React.useState(false);
  const [dispatchingLocal, setDispatchingLocal] = React.useState(false);

  const selConn = connections.find((c) => c.id === selConnId) ?? null;

  // ── data loading ────────────────────────────────────────────────────────

  const loadConnections = React.useCallback(async () => {
    try {
      const res = await fetch("/api/cluster/connections", { cache: "no-store" });
      const data = await res.json();
      const list: ClusterConnectionDTO[] = Array.isArray(data.connections)
        ? data.connections
        : [];
      setConnections(list);
      setConnError(null);
      setSelConnId((cur) =>
        cur && list.some((c) => c.id === cur) ? cur : list[0]?.id ?? "",
      );
    } catch (e) {
      setConnError(String(e));
    } finally {
      setLoadingConns(false);
    }
  }, []);

  React.useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // Local engine self-test — one scan on mount (engine-fold serves alphafold).
  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/tools/scan", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const engines: { key: string; serves?: string[]; ok?: boolean }[] =
          Array.isArray(data.engines) ? data.engines : [];
        const fold = engines.find((e) => (e.serves ?? []).includes("alphafold"));
        if (alive) {
          setEngineState(
            fold ? (fold.ok ? "ready" : "unavailable") : "unknown",
          );
        }
      } catch {
        if (alive) setEngineState("unknown");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Guide open/closed is remembered across visits.
  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(GUIDE_KEY);
      setGuideOpen(stored === null ? true : stored === "open");
    } catch {
      setGuideOpen(true);
    }
  }, []);

  const onGuideToggle = (open: boolean) => {
    setGuideOpen(open);
    try {
      window.localStorage.setItem(GUIDE_KEY, open ? "open" : "closed");
    } catch {
      /* private browsing — state simply isn't remembered */
    }
  };

  // Advanced fields pre-fill from the selected connection's af2 settings
  // (only when the selection itself changes, so user edits survive reloads).
  const appliedConnRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!selConnId || appliedConnRef.current === selConnId) return;
    appliedConnRef.current = selConnId;
    const c = connections.find((x) => x.id === selConnId);
    setAdvPartition(c?.af2?.partition ?? DEFAULT_AF2.partition);
    setAdvNode(c?.af2?.node ?? DEFAULT_AF2.node);
    setAdvModule(c?.af2?.module ?? DEFAULT_AF2.module);
  }, [selConnId, connections]);

  // ── jobs polling ────────────────────────────────────────────────────────
  // 2.5s interval ONLY while an alphafold job is live; otherwise refresh on
  // demand (dispatch / visibility change) — no idle infinite polling.

  const refreshJobs = React.useCallback(async () => {
    try {
      const res = await fetch("/api/tools/jobs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setJobs(
          (data as ToolJobDTO[]).filter((j) => j.tool === "alphafold"),
        );
      }
    } catch {
      /* transient network hiccup — next tick retries */
    } finally {
      setJobsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshJobs();
  }, [refreshJobs]);

  const anyLive = React.useMemo(() => jobs.some(isLiveJob), [jobs]);

  React.useEffect(() => {
    if (!anyLive) return;
    const iv = setInterval(() => {
      void refreshJobs();
    }, 2500);
    return () => clearInterval(iv);
  }, [anyLive, refreshJobs]);

  React.useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void refreshJobs();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refreshJobs]);

  // ── derived form state ───────────────────────────────────────────────────

  const parsedSeq = React.useMemo(
    () => (inputMode === "sequence" ? parseFastaInput(sequence) : null),
    [inputMode, sequence],
  );

  // Auto-derive the output dir from the parsed sequence name until the user
  // edits the field by hand (tutorial convention: <seqname>_AF2).
  React.useEffect(() => {
    if (outputDirTouched) return;
    if (inputMode === "sequence" && parsedSeq) {
      setOutputDir(af2OutputDirFor(parsedSeq.name));
    }
  }, [inputMode, parsedSeq, outputDirTouched]);

  const remoteRoot = selConn?.remoteRoot ?? "~/foundry-lab";
  const remoteWorkdir = `${remoteRoot}/jobs/alphafold/<new>`;
  const effectiveOutDir =
    outputDir.trim() || (parsedSeq ? af2OutputDirFor(parsedSeq.name) : "alphafold_out");

  // Live tutorial command preview (pure function — client-safe).
  const featureFilePreview =
    inputMode === "features"
      ? featureFile.trim() || "/data03/lipan/Protein_Structure/examples/T1078_features.pkl"
      : undefined;
  const fastaPathPreview =
    inputMode === "fasta"
      ? fastaPath.trim() || "/data03/lipan/Protein_Structure/examples/T1078.fa"
      : inputMode === "sequence" && parsedSeq
        ? `${remoteWorkdir}/input/${parsedSeq.name}.fa`
        : undefined;

  const commandPreview = buildTutorialPreview({
    loginHost: selConn ? `${selConn.username}@${selConn.host}` : "mgt",
    partition: advPartition.trim() || DEFAULT_AF2.partition,
    node: advNode.trim() || DEFAULT_AF2.node,
    module: advModule.trim() || DEFAULT_AF2.module,
    cudaDevice: gpu,
    fastaPath: featureFilePreview ? undefined : fastaPathPreview,
    featureFile: featureFilePreview,
    outputDir: effectiveOutDir,
    maxTemplateDate: maxTemplateDate.trim() || "2021-07-20",
    remoteWorkdir,
  });

  const hasMockCluster = connections.some(
    (c) => (c.host === "localhost" || c.host === "127.0.0.1") && c.port === 3022,
  );

  // Header status badges.
  const af2ProbeTool =
    selConn?.lastProbe?.tools.find((t) => t.key === "alphafold") ??
    selConn?.lastProbe?.tools[0] ??
    null;

  // Local run readiness (the Chou-Fasman engine predicts from sequences).
  const localReady =
    inputMode === "sequence"
      ? !!parsedSeq
      : inputMode === "fasta"
        ? fastaPath.trim() !== ""
        : false;

  // ── connection actions ───────────────────────────────────────────────────

  const onConnSelect = (v: string) => {
    if (v === NEW_CONN) {
      setDraft({ ...EMPTY_DRAFT });
      return;
    }
    setDraft(null);
    setSelConnId(v);
  };

  const saveConnection = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.host.trim() || !draft.username.trim()) {
      toast({
        title: "Missing fields",
        description: "Name, host/IP and username are required.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const af2: Record<string, string> = {};
      if (draft.af2Partition.trim()) af2.partition = draft.af2Partition.trim();
      if (draft.af2Node.trim()) af2.node = draft.af2Node.trim();
      if (draft.af2Module.trim()) af2.module = draft.af2Module.trim();
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: parseInt(draft.port, 10) || 22,
        username: draft.username.trim(),
        authMethod: "password",
        remoteRoot: draft.remoteRoot.trim() || "~/foundry-lab",
        af2: Object.keys(af2).length > 0 ? af2 : null,
      };
      if (draft.id) {
        body.id = draft.id;
        // empty string would CLEAR the stored secret — omit to keep it
        if (draft.password !== "") body.password = draft.password;
      } else {
        body.password = draft.password;
      }
      const res = await fetch("/api/cluster/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      const savedId = (data as { connection?: ClusterConnectionDTO }).connection
        ?.id;
      toast({
        title: draft.id ? "Connection updated" : "Connection saved",
        description: `${draft.name} · ${draft.username}@${draft.host}`,
        variant: "success",
      });
      setDraft(null);
      await loadConnections();
      if (savedId) setSelConnId(savedId);
    } catch (e) {
      toast({
        title: "Save failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteConnection = async (c: ClusterConnectionDTO) => {
    if (!window.confirm(`Delete connection "${c.name}"?`)) return;
    try {
      const res = await fetch(`/api/cluster/connections/${c.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Connection deleted", description: c.name, variant: "success" });
      setDraft(null);
      if (probeFor?.connId === c.id) setProbeFor(null);
      if (gpuRows && selConn?.id === c.id) setGpuRows(null);
      await loadConnections();
    } catch (e) {
      toast({
        title: "Delete failed",
        description: String(e),
        variant: "destructive",
      });
    }
  };

  const testConnection = async (c: ClusterConnectionDTO) => {
    setTestingId(c.id);
    setProbeError(null);
    try {
      const res = await fetch(`/api/cluster/connections/${c.id}/test`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      const probe = (data as { probe?: ClusterProbeDTO }).probe;
      if (res.ok && probe) {
        setProbeFor({ connId: c.id, probe });
        toast({
          title: probe.ok ? `Connected to ${c.name}` : `Probe failed for ${c.name}`,
          description: probe.ok
            ? `${probe.user}@${probe.hostname} · module system: ${probe.moduleSystem}`
            : (probe.error ?? "SSH unreachable"),
          variant: probe.ok ? "success" : "destructive",
        });
        await loadConnections(); // lastProbe is persisted server-side
      } else {
        const detail =
          (data as { detail?: string; error?: string }).detail ??
          (data as { error?: string }).error ??
          `HTTP ${res.status}`;
        setProbeError(detail);
        toast({
          title: "Probe failed",
          description: detail,
          variant: "destructive",
        });
      }
    } catch (e) {
      setProbeError(String(e));
      toast({
        title: "Test failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setTestingId(null);
    }
  };

  const checkGpus = async () => {
    if (!selConn) {
      toast({
        title: "No connection",
        description: "Save and select a cluster connection first.",
        variant: "destructive",
      });
      return;
    }
    const node = advNode.trim() || selConn.af2?.node || DEFAULT_AF2.node;
    setCheckingGpus(true);
    setGpuError(null);
    setGpuRows(null);
    try {
      const res = await fetch(
        `/api/cluster/connections/${selConn.id}/gpus?node=${encodeURIComponent(node)}`,
        { cache: "no-store" },
      );
      const data = await res.json().catch(() => ({}));
      const gpus = (data as { gpus?: GpuRow[] }).gpus;
      if (res.ok && Array.isArray(gpus) && gpus.length > 0) {
        setGpuRows({ node: (data as { node?: string }).node ?? node, gpus });
        toast({
          title: `GPU cards on ${node}`,
          description: `${gpus.length} cards · ${gpus.filter((g) => g.utilPct < 50 && g.memUsedMiB / Math.max(1, g.memTotalMiB) < 0.5).length} look free.`,
          variant: "success",
        });
      } else {
        const detail =
          (data as { error?: string }).error ??
          `nvidia-smi returned no cards on ${node}.`;
        setGpuError(detail);
      }
    } catch (e) {
      setGpuError(String(e));
    } finally {
      setCheckingGpus(false);
    }
  };

  const addMockCluster = async () => {
    setAddingMock(true);
    try {
      const res = await fetch("/api/cluster/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Local test cluster",
          host: "localhost",
          port: 3022,
          username: "foundry",
          authMethod: "password",
          password: "demo",
          af2: { partition: "gpu", node: "gpu05", module: "alphafold2" },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      const savedId = (data as { connection?: ClusterConnectionDTO }).connection
        ?.id;
      toast({
        title: "Local test cluster added",
        description:
          "foundry@localhost:3022 · local test cluster — commands run FOR REAL via bash; only the SLURM scheduler is an in-memory state machine (partition gpu, module alphafold2).",
        variant: "success",
      });
      await loadConnections();
      if (savedId) setSelConnId(savedId);
    } catch (e) {
      toast({
        title: "Quick-add failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setAddingMock(false);
    }
  };

  // ── prediction actions ───────────────────────────────────────────────────

  const loadTutorialExample = () => {
    setInputMode("sequence");
    setSequence(TUTORIAL_FASTA);
    setOutputDirTouched(false);
    setOutputDir(af2OutputDirFor("T1078"));
    toast({
      title: "Tutorial example loaded",
      description: "T1078 — the CASP target used in the cluster tutorial.",
      variant: "success",
    });
  };

  /** Validate the form and build the params object for /api/tools/run. */
  const buildRunParams = (): {
    params: Record<string, unknown> | null;
    error: string | undefined;
  } => {
    const params: Record<string, unknown> = {};
    if (inputMode === "sequence") {
      if (!parsedSeq) {
        return {
          params: null,
          error:
            "Paste a valid FASTA first — a >name header line plus amino-acid residues.",
        };
      }
      params.sequence = sequence;
    } else if (inputMode === "fasta") {
      if (!fastaPath.trim()) {
        return {
          params: null,
          error:
            "Enter the FASTA path — cluster-absolute, or a local file to auto-upload.",
        };
      }
      params.fasta_path = fastaPath.trim();
    } else {
      if (!featureFile.trim()) {
        return {
          params: null,
          error: "Enter the features.pkl path on the cluster.",
        };
      }
      params.feature_file = featureFile.trim();
    }
    params.output_dir = effectiveOutDir;
    if (inputMode !== "features") {
      // the tutorial's features.pkl run omits --max_template_date
      params.max_template_date = maxTemplateDate.trim() || "2021-07-20";
    }
    params.gpu = gpu;
    return { params, error: undefined };
  };

  const runOnCluster = async () => {
    if (!selConn) {
      toast({
        title: "No cluster connection",
        description: "Add the mgt login node in the Connection section first.",
        variant: "destructive",
      });
      return;
    }
    const { params, error } = buildRunParams();
    if (!params) {
      toast({
        title: "Prediction form incomplete",
        description: error,
        variant: "destructive",
      });
      return;
    }
    setDispatching(true);
    try {
      const cluster: Record<string, unknown> = {
        connectionId: selConn.id,
        mode: submitMode,
        cudaDevice: gpu,
      };
      if (advPartition.trim()) cluster.partition = advPartition.trim();
      if (advNode.trim()) cluster.node = advNode.trim();
      if (advModule.trim()) cluster.module = advModule.trim();
      if (submitMode === "slurm") {
        cluster.gpus = 1;
        cluster.cpusPerTask = 4;
      }
      const wt = parseInt(walltimeMin, 10);
      if (Number.isFinite(wt) && wt > 0) cluster.timeLimitMin = wt;

      const res = await fetch("/api/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "alphafold", params, cluster }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ToolJobDTO> & {
        error?: string;
      };
      if (res.status === 202 && data.id) {
        toast({
          title: "Prediction dispatched",
          description: `${selConn.name} · ${submitMode} · ${effectiveOutDir} — live logs below.`,
          variant: "success",
        });
        setExpandedJob(data.id);
        await refreshJobs();
      } else {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      toast({
        title: "Dispatch failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setDispatching(false);
    }
  };

  const runLocally = async () => {
    if (inputMode === "features") {
      toast({
        title: "features.pkl needs the cluster",
        description:
          "The local engine predicts from sequences — switch to the Sequence tab for a local run.",
        variant: "destructive",
      });
      return;
    }
    const { params, error } = buildRunParams();
    if (!params) {
      toast({
        title: "Prediction form incomplete",
        description: error,
        variant: "destructive",
      });
      return;
    }
    // The built-in engine takes a bare residue string (no FASTA header).
    const localParams: Record<string, unknown> = { ...params };
    if (inputMode === "sequence" && parsedSeq) localParams.sequence = parsedSeq.seq;

    setDispatchingLocal(true);
    try {
      const res = await fetch("/api/tools/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "alphafold", params: localParams }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ToolJobDTO> & {
        error?: string;
      };
      if (res.status === 201 && data.id) {
        const ok = data.status === "completed";
        toast({
          title: ok ? "Local prediction finished" : `Local run ${data.status ?? "failed"}`,
          description: ok
            ? `exit ${data.exitCode ?? 0} · ${(data.outputFiles ?? []).length} files — Chou-Fasman baseline, not the AF2 network.`
            : (data.stderr || "See the job log below."),
          variant: ok ? "success" : "destructive",
        });
        setExpandedJob(data.id);
        await refreshJobs();
      } else {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      toast({
        title: "Local run failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setDispatchingLocal(false);
    }
  };

  const stopJob = async (job: ToolJobDTO) => {
    setStoppingId(job.id);
    try {
      const res = await fetch(`/api/tools/jobs/${job.id}/stop`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data as { ok?: boolean }).ok === false) {
        throw new Error(
          (data as { error?: string }).error ?? `HTTP ${res.status}`,
        );
      }
      toast({
        title: "Stop requested",
        description: "Cancelling the prediction on the cluster.",
        variant: "success",
      });
      await refreshJobs();
    } catch (e) {
      toast({
        title: "Stop failed",
        description: String(e),
        variant: "destructive",
      });
    } finally {
      setStoppingId(null);
    }
  };

  // ── render ───────────────────────────────────────────────────────────────

  // Cross-links into the management layer (open the sheets over this page).
  const setEnvironmentSheetOpen = useAppStore((s) => s.setEnvironmentSheetOpen);
  const setClusterSheetOpen = useAppStore((s) => s.setClusterSheetOpen);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6">
      {/* ── ① Header ─────────────────────────────────────────────────── */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Boxes className="size-6 text-teal-600 dark:text-teal-400" />
            AlphaFold2 Structure Prediction
          </h1>
          <p className="text-sm text-muted-foreground">
            Jumper et al. 2021 — five models per target, ranked by pLDDT. The
            cluster flow:{" "}
            <span className="font-mono text-xs">mgt → salloc → gpu05 → module load alphafold2</span>
          </p>
          <p className="max-w-xl text-xs text-muted-foreground">
            The interactive workbench for the AlphaFold2 external application —
            its detection, install and fallback-engine status live in{" "}
            <span className="font-medium text-foreground">Environment</span>, and it can
            also run as a canvas node inside workflows.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="gap-1 text-[11px]">
              <Server className="size-3" />
              {loadingConns
                ? "…"
                : `${connections.length} ${connections.length === 1 ? "connection" : "connections"}`}
            </Badge>
            {!selConn ? (
              <Badge variant="outline" className="text-[11px] text-muted-foreground">
                no cluster
              </Badge>
            ) : !selConn.lastProbe ? (
              <Badge variant="outline" className="text-[11px] text-muted-foreground">
                cluster unprobed
              </Badge>
            ) : af2ProbeTool?.installed ? (
              <Badge className="bg-teal-500/10 text-[11px] text-teal-700 dark:text-teal-300">
                alphafold2: ready on cluster
              </Badge>
            ) : (
              <Badge className="bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-400">
                alphafold2: not found
              </Badge>
            )}
            {engineState === "checking" ? (
              <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> checking engine…
              </Badge>
            ) : engineState === "ready" ? (
              <Badge
                variant="outline"
                className="border-teal-500/40 text-[11px] text-teal-700 dark:text-teal-300"
                title="Built-in Structure Prediction Engine (Chou-Fasman classical baseline)"
              >
                local engine ready
              </Badge>
            ) : engineState === "unavailable" ? (
              <Badge className="bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-400">
                local engine unavailable
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[11px] text-muted-foreground">
                engine status unknown
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEnvironmentSheetOpen(true)}
              aria-label="Open the Environment panel (tool detection and installs)"
              title="Environment — external-tool detection, installs and engine status"
            >
              <Monitor className="size-3.5" /> Environment
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setClusterSheetOpen(true)}
              aria-label="Open the Cluster panel (SSH connections and cluster jobs)"
              title="Cluster — SSH/HPC connections, probes and cluster jobs"
            >
              <Server className="size-3.5" /> Cluster
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void loadConnections();
                void refreshJobs();
              }}
              aria-label="Refresh connections and jobs"
            >
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          </div>
        </div>
      </header>

      {/* ── ② Guide card ─────────────────────────────────────────────── */}
      <Card>
        <Collapsible
          open={guideOpen ?? true}
          onOpenChange={onGuideToggle}
        >
          <CardHeader className="pb-3">
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
              <span className="flex min-w-0 items-center gap-2">
                <BookOpen className="size-4 shrink-0 text-teal-600 dark:text-teal-400" />
                <span className="min-w-0">
                  <span className="block text-base font-semibold">
                    The cluster tutorial — how to run AlphaFold
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    request a GPU → load the module → check free cards → run_alphafold.py
                  </span>
                </span>
              </span>
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  (guideOpen ?? true) ? "" : "-rotate-90",
                )}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-5 pt-1">
              <GuideStep n={1} title="Request resources on the mgt login node">
                <CodeBlock
                  label="salloc + ssh"
                  code={"salloc -N 1 --gres=gpu:1 -p brain2\nssh gpu05"}
                />
                <p className="text-xs text-muted-foreground">
                  The End-to-End stage currently only runs on{" "}
                  <span className="font-semibold text-foreground">GPU05</span>;
                  the preprocessing stage can run on all GPU nodes.
                </p>
              </GuideStep>

              <GuideStep n={2} title="Load the AlphaFold2 environment">
                <CodeBlock label="module" code="module load alphafold2" />
              </GuideStep>

              <GuideStep n={3} title="Check which GPU cards are free">
                <CodeBlock label="nvidia-smi" code="nvidia-smi" />
                <p className="text-xs text-muted-foreground">
                  Pick a free card and pin it with{" "}
                  <code className="font-mono text-[11px]">CUDA_VISIBLE_DEVICES</code>{" "}
                  before running. The{" "}
                  <span className="font-medium text-foreground">Check GPUs</span>{" "}
                  button in the Connection section does this for you.
                </p>
              </GuideStep>

              <GuideStep n="4a" title="Predict from scratch (FASTA)">
                <CodeBlock
                  label="end-to-end"
                  code={
                    'test_fa=/data03/lipan/Protein_Structure/examples/T1078.fa\n' +
                    'CUDA_VISIBLE_DEVICES="6" run_alphafold.py --fasta_paths $test_fa --output_dir T1078_AF2 --max_template_date 2021-07-20'
                  }
                />
              </GuideStep>

              <GuideStep n="4b" title="Continue from precomputed features">
                <CodeBlock
                  label="features.pkl"
                  code={
                    'test_ft=/data03/lipan/Protein_Structure/examples/T1078_features.pkl\n' +
                    'CUDA_VISIBLE_DEVICES="7" run_alphafold.py --feature_file $test_ft --output_dir T1078_AF2'
                  }
                />
                <p className="text-xs text-muted-foreground">
                  This avoids the expensive preprocessing (MSA) stage.
                </p>
              </GuideStep>

              <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <p className="text-xs font-semibold">FASTA format</p>
                <CodeBlock
                  small
                  label="FASTA example"
                  code={">seq_name\nDYKDDDDASKAPVCQEITVPMCRGIGYNLTHMPNQFNHDTQDEAGLE..."}
                />
                <p className="text-xs text-muted-foreground">
                  A <code className="font-mono text-[11px]">&gt;name</code>{" "}
                  header line followed by residues — sequences may be wrapped
                  or unwrapped.
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Output files
                </p>
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="h-8 text-xs">File</TableHead>
                        <TableHead className="h-8 text-xs">What it is</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {OUTPUT_FILES.map(([file, desc]) => (
                        <TableRow key={file}>
                          <TableCell className="whitespace-nowrap py-1.5 align-top font-mono text-[11px]">
                            {file}
                          </TableCell>
                          <TableCell className="py-1.5 align-top text-xs text-muted-foreground">
                            {desc}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                <div className="flex items-start gap-2">
                  <AlertTriangle
                    className="mt-0.5 size-3.5 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <p>
                    <span className="font-semibold">Databases:</span>{" "}
                    <code className="break-all font-mono text-[11px]">
                      /data03/lipan/Protein_Structure/AF2_db
                    </code>{" "}
                    — do not modify anything under this directory!
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <Boxes
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <p>
                    <span className="font-semibold">AlphaFold code:</span>{" "}
                    <code className="break-all font-mono text-[11px]">
                      /opt/ohpc/pub/apps/miniconda3/envs/alphafold/lib/python3.8/site-packages/alphafold
                    </code>
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
                <Server className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <p>
                  The mgt node is reached over SSH with an IP address and
                  username/password — configure it in the{" "}
                  <span className="font-medium text-foreground">Connection</span>{" "}
                  section below.
                </p>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* ── ③ Connection card ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Cluster connection</CardTitle>
          <CardDescription>
            SSH access to the mgt login node — the entry point of the tutorial
            flow.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadingConns ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : connError ? (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 text-sm">
              <p className="font-medium text-rose-600 dark:text-rose-400">
                Failed to load connections
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {connError}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => void loadConnections()}
              >
                <RefreshCw className="mr-1 size-3.5" /> Retry
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <Label htmlFor="af-conn" className="text-xs">
                    Connection
                  </Label>
                  <Select
                    value={draft ? (draft.id ?? NEW_CONN) : selConnId}
                    onValueChange={onConnSelect}
                  >
                    <SelectTrigger
                      id="af-conn"
                      className="w-full"
                    >
                      <SelectValue
                        placeholder={
                          connections.length
                            ? "Pick a connection"
                            : "No connections yet"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {connections.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.username}@{c.host}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_CONN}>
                        ＋ New connection
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {selConn && !draft && (
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setDraft(draftFromConn(selConn))}
                    aria-label={`Edit connection ${selConn.name}`}
                  >
                    <Pencil className="size-4" />
                  </Button>
                )}
              </div>

              {/* Connection editor (create / edit) */}
              {draft && (
                <div className="space-y-3 rounded-lg border border-teal-500/30 bg-teal-500/[0.03] p-3">
                  <p className="text-sm font-semibold">
                    {draft.id ? `Edit — ${draft.name}` : "New connection"}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <Label htmlFor="af-c-name" className="text-xs">
                        Name
                      </Label>
                      <Input
                        id="af-c-name"
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
                        placeholder="Lab GPU cluster (mgt)"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="af-c-host" className="text-xs">
                        Host / IP
                      </Label>
                      <Input
                        id="af-c-host"
                        value={draft.host}
                        onChange={(e) =>
                          setDraft({ ...draft, host: e.target.value })
                        }
                        placeholder="10.0.0.1"
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="af-c-port" className="text-xs">
                        Port
                      </Label>
                      <Input
                        id="af-c-port"
                        type="number"
                        value={draft.port}
                        onChange={(e) =>
                          setDraft({ ...draft, port: e.target.value })
                        }
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="af-c-user" className="text-xs">
                        Username
                      </Label>
                      <Input
                        id="af-c-user"
                        value={draft.username}
                        onChange={(e) =>
                          setDraft({ ...draft, username: e.target.value })
                        }
                        placeholder="student01"
                        className="font-mono text-xs"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="af-c-pass" className="text-xs">
                        Password
                      </Label>
                      <Input
                        id="af-c-pass"
                        type="password"
                        value={draft.password}
                        onChange={(e) =>
                          setDraft({ ...draft, password: e.target.value })
                        }
                        placeholder={
                          draft.id &&
                          connections.find((c) => c.id === draft.id)?.hasPassword
                            ? "unchanged"
                            : "password"
                        }
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="af-c-root" className="text-xs">
                        Remote job root
                      </Label>
                      <Input
                        id="af-c-root"
                        value={draft.remoteRoot}
                        onChange={(e) =>
                          setDraft({ ...draft, remoteRoot: e.target.value })
                        }
                        className="font-mono text-xs"
                      />
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      AlphaFold cluster settings
                    </p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="grid gap-1.5">
                        <Label htmlFor="af-c-part" className="text-xs">
                          Partition
                        </Label>
                        <Input
                          id="af-c-part"
                          value={draft.af2Partition}
                          onChange={(e) =>
                            setDraft({ ...draft, af2Partition: e.target.value })
                          }
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="af-c-node" className="text-xs">
                          GPU node
                        </Label>
                        <Input
                          id="af-c-node"
                          value={draft.af2Node}
                          onChange={(e) =>
                            setDraft({ ...draft, af2Node: e.target.value })
                          }
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="af-c-mod" className="text-xs">
                          Module
                        </Label>
                        <Input
                          id="af-c-mod"
                          value={draft.af2Module}
                          onChange={(e) =>
                            setDraft({ ...draft, af2Module: e.target.value })
                          }
                          className="font-mono text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {draft.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          const c = connections.find((x) => x.id === draft.id);
                          if (c) void deleteConnection(c);
                        }}
                        disabled={saving}
                      >
                        <Trash2 className="mr-1 size-3.5" /> Delete
                      </Button>
                    ) : (
                      <span />
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDraft(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void saveConnection()}
                        disabled={saving}
                      >
                        {saving ? (
                          <Loader2 className="mr-1 size-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-1 size-3.5" />
                        )}
                        {draft.id ? "Save changes" : "Save connection"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selConn && void testConnection(selConn)}
                  disabled={!selConn || testingId === selConn?.id}
                >
                  {testingId === selConn?.id ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Cpu className="mr-1 size-3.5" />
                  )}
                  Test connection
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void checkGpus()}
                  disabled={!selConn || checkingGpus}
                >
                  {checkingGpus ? (
                    <Loader2 className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <Cpu className="mr-1 size-3.5" />
                  )}
                  Check GPUs on {advNode.trim() || DEFAULT_AF2.node}
                </Button>
                {!hasMockCluster && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void addMockCluster()}
                    disabled={addingMock}
                  >
                    {addingMock ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <Zap className="mr-1 size-3.5" />
                    )}
                    Add local test cluster
                  </Button>
                )}
              </div>

              {/* Probe result — compact */}
              {probeFor && (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {probeFor.probe.user}@{probeFor.probe.hostname}
                    </Badge>
                    {probeFor.probe.slurm?.available ? (
                      <Badge className="bg-emerald-500/10 text-[11px] text-emerald-700 dark:text-emerald-400">
                        Slurm ·{" "}
                        {probeFor.probe.slurm.partitions
                          .map((p) => p.name)
                          .join(" ") || "available"}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[11px] text-muted-foreground"
                      >
                        Slurm not detected
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-[11px]">
                      module system: {probeFor.probe.moduleSystem}
                    </Badge>
                  </div>
                  <div className="flex items-start gap-2 text-xs">
                    {af2ProbeInstalled(probeFor.probe) ? (
                      <CheckCircle2
                        className="mt-0.5 size-3.5 shrink-0 text-teal-600 dark:text-teal-400"
                        aria-hidden="true"
                      />
                    ) : (
                      <XCircle
                        className="mt-0.5 size-3.5 shrink-0 text-rose-500"
                        aria-hidden="true"
                      />
                    )}
                    <span>
                      <span className="font-mono">alphafold2</span> —{" "}
                      {af2ProbeInstalled(probeFor.probe)
                        ? "module load alphafold2 works, run_alphafold.py found"
                        : "not found — the module or run_alphafold.py is missing on this cluster"}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    GPUs:{" "}
                    {probeFor.probe.gpus?.length
                      ? probeFor.probe.gpus
                          .map((g) => `${g.count}x ${g.model}`)
                          .join(" · ")
                      : "none visible from the login node"}
                  </p>
                </div>
              )}
              {probeError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs">
                  <p className="font-medium text-rose-600 dark:text-rose-400">
                    Probe failed
                  </p>
                  <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                    {probeError}
                  </p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                    <li>Check the host/IP, port and username/password.</li>
                    <li>
                      Verify the mgt login node allows password auth over SSH.
                    </li>
                  </ul>
                </div>
              )}

              {/* GPU availability table */}
              {checkingGpus && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Skeleton className="h-28 w-full" />
                  <Skeleton className="h-28 w-full" />
                </div>
              )}
              {gpuRows && !checkingGpus && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold">
                    GPU cards on{" "}
                    <span className="font-mono text-teal-700 dark:text-teal-300">
                      {gpuRows.node}
                    </span>{" "}
                    — busy cards muted, free cards highlighted
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {gpuRows.gpus.map((g) => {
                      const memPct =
                        g.memTotalMiB > 0
                          ? Math.min(
                              100,
                              Math.round(
                                (g.memUsedMiB / g.memTotalMiB) * 100,
                              ),
                            )
                          : 0;
                      const busy = memPct >= 50 || g.utilPct >= 50;
                      const selected = gpu === String(g.index);
                      return (
                        <div
                          key={g.index}
                          className={cn(
                            "rounded-lg border p-3",
                            busy
                              ? "border-border opacity-60"
                              : "border-teal-500/40 bg-teal-500/5",
                            selected && "ring-2 ring-teal-500/30",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate font-mono text-xs font-semibold">
                              card {g.index} · {g.name}
                            </p>
                            <Badge
                              className={
                                busy
                                  ? "bg-muted text-[10px] text-muted-foreground"
                                  : "bg-teal-500/10 text-[10px] text-teal-700 dark:text-teal-300"
                              }
                            >
                              {busy ? "busy" : "free"}
                            </Badge>
                          </div>
                          <div className="mt-2 flex items-center gap-2">
                            <Progress
                              value={memPct}
                              className="h-1.5 flex-1 bg-muted [&_[data-slot=progress-indicator]]:bg-teal-500"
                              aria-label={`Card ${g.index} memory usage ${memPct}%`}
                            />
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                              {fmtMiB(g.memUsedMiB)} / {fmtMiB(g.memTotalMiB)}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between">
                            <span className="text-[10px] text-muted-foreground">
                              util {g.utilPct}%
                            </span>
                            <Button
                              size="sm"
                              variant={selected ? "default" : "outline"}
                              className="h-7 text-xs"
                              onClick={() => {
                                setGpu(String(g.index));
                                toast({
                                  title: `GPU card ${g.index} selected`,
                                  description:
                                    'CUDA_VISIBLE_DEVICES pinned for the next run.',
                                  variant: "success",
                                });
                              }}
                              aria-label={`Use GPU card ${g.index}`}
                            >
                              Use
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {gpuError && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                  <p className="font-medium text-amber-700 dark:text-amber-400">
                    Could not read GPU cards
                  </p>
                  <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                    {gpuError}
                  </p>
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted-foreground">
                    <li>
                      Test the connection first, then retry — the query runs{" "}
                      <code className="font-mono text-[11px]">
                        ssh &lt;node&gt; nvidia-smi
                      </code>{" "}
                      from the login node.
                    </li>
                    <li>
                      Confirm the node name (default gpu05) resolves and allows
                      SSH from the login node.
                    </li>
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── ④ Prediction form ────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New prediction</CardTitle>
          <CardDescription>
            A sequence, a cluster FASTA, or precomputed features — outputs five
            models ranked by pLDDT.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs
            value={inputMode}
            onValueChange={(v) => setInputMode(v as InputMode)}
          >
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="sequence" className="whitespace-normal text-xs sm:text-sm">
                <Dna className="size-3.5" /> Sequence (FASTA)
              </TabsTrigger>
              <TabsTrigger value="fasta" className="whitespace-normal text-xs sm:text-sm">
                <FileText className="size-3.5" /> FASTA on cluster
              </TabsTrigger>
              <TabsTrigger value="features" className="whitespace-normal text-xs sm:text-sm">
                <Layers className="size-3.5" /> features.pkl
              </TabsTrigger>
            </TabsList>

            <TabsContent value="sequence" className="mt-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="af-sequence" className="text-xs">
                  FASTA text
                </Label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={loadTutorialExample}
                >
                  <Zap className="mr-1 size-3" /> Load tutorial example
                </Button>
              </div>
              <Textarea
                id="af-sequence"
                rows={5}
                className="font-mono text-xs"
                placeholder={
                  ">T1078\nDYKDDDDASKAPVCQEITVPMCRGIGYNLTHMPNQFNHDTQDEAGLEVHQFWPLVEI"
                }
                value={sequence}
                onChange={(e) => setSequence(e.target.value)}
                aria-invalid={sequence.trim() !== "" && !parsedSeq}
                aria-describedby="af-seq-hint"
              />
              <p id="af-seq-hint" aria-live="polite">
                {sequence.trim() === "" ? (
                  <span className="text-xs text-muted-foreground">
                    Paste a FASTA — a{" "}
                    <code className="font-mono text-[11px]">&gt;name</code>{" "}
                    header line plus residues (wrapped or unwrapped).
                  </span>
                ) : parsedSeq ? (
                  <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5 shrink-0" />
                    {parsedSeq.name} — {parsedSeq.seq.length} residues
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-rose-600 dark:text-rose-400">
                    <XCircle className="size-3.5 shrink-0" />
                    Invalid FASTA — expected a &gt;name header plus standard
                    amino-acid residues.
                  </span>
                )}
              </p>
            </TabsContent>

            <TabsContent value="fasta" className="mt-2 space-y-2">
              <Label htmlFor="af-fastapath" className="text-xs">
                Absolute path on the cluster
              </Label>
              <Input
                id="af-fastapath"
                className="font-mono text-xs"
                placeholder="/data03/lipan/Protein_Structure/examples/T1078.fa"
                value={fastaPath}
                onChange={(e) => setFastaPath(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Or a local file path — local files are auto-uploaded to the job
                workdir.
              </p>
            </TabsContent>

            <TabsContent value="features" className="mt-2 space-y-2">
              <Label htmlFor="af-featurefile" className="text-xs">
                features.pkl path on the cluster
              </Label>
              <Input
                id="af-featurefile"
                className="font-mono text-xs"
                placeholder="/data03/lipan/Protein_Structure/examples/T1078_features.pkl"
                value={featureFile}
                onChange={(e) => setFeatureFile(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Continues from AlphaFold preprocessing output — skips the
                expensive MSA search stage.
              </p>
            </TabsContent>
          </Tabs>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="af-outdir" className="text-xs">
                Output directory
              </Label>
              <Input
                id="af-outdir"
                className="font-mono text-xs"
                value={outputDir}
                onChange={(e) => {
                  setOutputDir(e.target.value);
                  setOutputDirTouched(true);
                }}
              />
              <p className="text-[10px] text-muted-foreground">
                Tutorial convention: T1078_AF2
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="af-maxdate" className="text-xs">
                Max template date
              </Label>
              <Input
                id="af-maxdate"
                className="font-mono text-xs"
                placeholder="2021-07-20"
                value={maxTemplateDate}
                onChange={(e) => setMaxTemplateDate(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                Only PDB templates before this date
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="af-gpu" className="text-xs">
                GPU card
              </Label>
              <Select value={gpu} onValueChange={setGpu}>
                <SelectTrigger id="af-gpu" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GPU_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      card {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                CUDA_VISIBLE_DEVICES — check free cards first
              </p>
            </div>
          </div>

          {/* Advanced — submission mode & resources */}
          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <CollapsibleTrigger className="flex w-full items-center gap-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                {showAdvanced ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                Advanced — submission mode and resources
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Mode</Label>
                  <div
                    className="grid grid-cols-3 gap-1.5"
                    role="group"
                    aria-label="Submission mode"
                  >
                    <ModeCard
                      active={submitMode === "salloc"}
                      onClick={() => setSubmitMode("salloc")}
                      title="salloc"
                      desc="tutorial flow"
                    />
                    <ModeCard
                      active={submitMode === "direct"}
                      onClick={() => setSubmitMode("direct")}
                      title="direct"
                      desc="ssh + setsid"
                    />
                    <ModeCard
                      active={submitMode === "slurm"}
                      onClick={() => setSubmitMode("slurm")}
                      title="slurm"
                      desc="sbatch"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="grid gap-1.5">
                    <Label htmlFor="af-adv-part" className="text-xs">
                      Partition
                    </Label>
                    <Input
                      id="af-adv-part"
                      className="font-mono text-xs"
                      value={advPartition}
                      onChange={(e) => setAdvPartition(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="af-adv-node" className="text-xs">
                      GPU node
                    </Label>
                    <Input
                      id="af-adv-node"
                      className="font-mono text-xs"
                      value={advNode}
                      onChange={(e) => setAdvNode(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="af-adv-mod" className="text-xs">
                      Module
                    </Label>
                    <Input
                      id="af-adv-mod"
                      className="font-mono text-xs"
                      value={advModule}
                      onChange={(e) => setAdvModule(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="af-adv-wt" className="text-xs">
                      Walltime (min)
                    </Label>
                    <Input
                      id="af-adv-wt"
                      type="number"
                      min={1}
                      value={walltimeMin}
                      onChange={(e) => setWalltimeMin(e.target.value)}
                      placeholder="cluster default"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Pre-filled from the selected connection&apos;s AlphaFold
                  settings{submitMode === "slurm"
                    ? " · slurm submits with --gres=gpu:1 and 4 CPUs/task"
                    : ""}
                  .
                </p>
              </CollapsibleContent>
            </div>
          </Collapsible>

          {/* Command preview */}
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Command preview
            </p>
            <CodeBlock code={commandPreview} label="Command preview" />
            <p className="text-[10px] text-muted-foreground">
              {selConn
                ? `Runs on ${selConn.name} (${selConn.username}@${selConn.host}) — outputs land in ${remoteWorkdir}/${effectiveOutDir}.`
                : "Tutorial form — select a connection above to dispatch the real run."}
            </p>
          </div>

          {/* Dispatch */}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              onClick={() => void runOnCluster()}
              disabled={dispatching || !selConn}
            >
              {dispatching ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Play className="mr-1 size-4" />
              )}
              Run on cluster
            </Button>
            <Button
              variant="outline"
              onClick={() => void runLocally()}
              disabled={dispatchingLocal || !localReady}
              title={
                inputMode === "features"
                  ? "features.pkl inputs run on the cluster"
                  : undefined
              }
            >
              {dispatchingLocal ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Play className="mr-1 size-4" />
              )}
              Run locally (built-in engine)
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            The local engine is the classical Chou-Fasman baseline, NOT the AF2
            network — real AlphaFold2 predictions run on the GPU cluster, and
            features.pkl inputs need the cluster.
          </p>
        </CardContent>
      </Card>

      <Separator />

      {/* ── ⑤ Jobs ───────────────────────────────────────────────────── */}
      <section className="space-y-3" aria-label="AlphaFold2 jobs">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Predictions
          </h2>
          {anyLive && (
            <Badge className="gap-1 bg-teal-500/10 text-[11px] text-teal-700 dark:text-teal-300">
              <Loader2 className="size-3 animate-spin" /> live · polling 2.5s
            </Badge>
          )}
        </div>

        {jobsLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            No AlphaFold2 jobs yet — configure a connection and dispatch a
            prediction above.
          </div>
        ) : (
          <div className="grid gap-3">
            {jobs.map((job) => {
              const c = job.cluster;
              const phase = jobPhase(job);
              const live = isLivePhase(phase);
              const expanded = expandedJob === job.id;
              const pdbCount = job.outputFiles.filter((f) =>
                f.toLowerCase().endsWith(".pdb"),
              ).length;
              const hasRankedBest =
                job.outputFiles.some((f) => basename(f) === "ranked_0.pdb") ||
                (c?.syncedFiles ?? []).some((f) =>
                  basename(f) === "ranked_0.pdb",
                );
              const fileCount = Math.max(
                job.outputFiles.length,
                c?.syncedFiles?.length ?? 0,
              );
              const paramsOutDir =
                typeof job.params?.output_dir === "string"
                  ? job.params.output_dir
                  : null;
              return (
                <Card key={job.id}>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={() =>
                          setExpandedJob(expanded ? null : job.id)
                        }
                        aria-expanded={expanded}
                        aria-label={`Toggle job ${job.id} details`}
                      >
                        {expanded ? (
                          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <Boxes className="size-4 shrink-0 text-teal-600 dark:text-teal-400" />
                        <span className="truncate text-sm font-semibold">
                          {inputSummary(job.params)}
                        </span>
                        <Badge
                          className={cn(
                            "shrink-0",
                            PHASE_STYLE[phase],
                            phase === "running" && "animate-pulse",
                          )}
                        >
                          {phase}
                        </Badge>
                        {c ? (
                          <>
                            <Badge
                              variant="outline"
                              className="max-w-36 truncate font-mono text-[10px]"
                            >
                              {c.connectionName}
                            </Badge>
                            <Badge
                              variant="outline"
                              className="shrink-0 text-[10px]"
                            >
                              {c.mode}
                            </Badge>
                          </>
                        ) : (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px] text-muted-foreground"
                          >
                            local · engine
                          </Badge>
                        )}
                      </button>
                      <div className="flex items-center gap-1.5">
                        {live && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void stopJob(job)}
                            disabled={stoppingId === job.id}
                          >
                            {stoppingId === job.id ? (
                              <Loader2 className="mr-1 size-3.5 animate-spin" />
                            ) : (
                              <Square className="mr-1 size-3.5" />
                            )}
                            Stop
                          </Button>
                        )}
                        {(phase === "done" || job.outputFiles.length > 0) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setViewerJob(job)}
                          >
                            <FileBox className="mr-1 size-3.5" /> View outputs
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>started {fmtTime(job.startedAt)}</span>
                      <span>
                        elapsed {fmtElapsed(job.startedAt, job.finishedAt)}
                      </span>
                      {paramsOutDir && (
                        <span className="font-mono">out {paramsOutDir}</span>
                      )}
                      {fileCount > 0 && (
                        <span>
                          {fileCount} file{fileCount === 1 ? "" : "s"}
                          {c?.syncedBytes ? ` · ${fmtBytes(c.syncedBytes)} synced` : ""}
                        </span>
                      )}
                      {c?.slurmId && <span>Slurm {c.slurmId}</span>}
                      {c?.pid && <span className="font-mono">pid {c.pid}</span>}
                      {job.exitCode != null && <span>exit {job.exitCode}</span>}
                    </div>

                    {/* Best-model mini summary */}
                    {phase === "done" && pdbCount >= 5 && hasRankedBest && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-teal-500/30 bg-teal-500/5 px-2.5 py-1.5 text-xs text-teal-700 dark:text-teal-300">
                        <Award className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="font-medium">
                          {pdbCount} models ranked
                        </span>
                        <span className="text-muted-foreground">
                          · ranked_0.pdb = highest pLDDT
                        </span>
                        <Badge
                          variant="outline"
                          className="ml-auto text-[10px]"
                        >
                          {fileCount} files
                        </Badge>
                      </div>
                    )}

                    {expanded && (
                      <div className="mt-3 space-y-2">
                        {job.command && (
                          <div className="break-all rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
                            $ {job.command}
                          </div>
                        )}
                        {(c?.logTailOut || job.stdout) && (
                          <div className="max-h-64 overflow-y-auto rounded-md border border-white/10 bg-black/90 p-3 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-teal-400/30">
                            <p className="mb-1.5 flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-teal-400">
                              <Terminal className="size-3" aria-hidden="true" />
                              {c ? "remote log tail" : "engine log"}
                            </p>
                            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-teal-100/90">
                              {(c?.logTailOut || job.stdout || "").slice(-4000)}
                            </pre>
                            {(c?.logTailErr ||
                              (phase === "failed" ? job.stderr : "")) && (
                              <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-rose-400">
                                {(
                                  c?.logTailErr ||
                                  job.stderr ||
                                  ""
                                ).slice(-2000)}
                              </pre>
                            )}
                          </div>
                        )}
                        {c?.error && (
                          <p className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-600 dark:text-rose-400">
                            {c.error}
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* ── ⑥ Footer honesty note ────────────────────────────────────── */}
      <footer className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>
          Local runs use the built-in Chou-Fasman engine (classical baseline).
          Real AlphaFold2 predictions run on the GPU cluster via{" "}
          <code className="font-mono text-[11px]">module load alphafold2</code>{" "}
          — outputs include five models ranked by pLDDT.
        </p>
      </footer>

      {/* Output viewer — ranked_*.pdb files sync back to local disk, so the
          shared dialog renders them in 3D unchanged. */}
      <OutputViewerDialog
        job={viewerJob}
        open={viewerJob != null}
        onClose={() => setViewerJob(null)}
      />
    </div>
  );
}

// ── small building blocks ───────────────────────────────────────────────────

/** Is the alphafold2 module tool installed per this probe? */
function af2ProbeInstalled(probe: ClusterProbeDTO): boolean {
  const t =
    probe.tools.find((x) => x.key === "alphafold") ?? probe.tools[0] ?? null;
  return t?.installed === true;
}

/** Dark monospace code block with a copy button (clipboard + toast). */
function CodeBlock({
  code,
  label,
  small,
}: {
  code: string;
  label?: string;
  small?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      useAppStore.getState().toast({
        title: "Copied to clipboard",
        description: label ? `${label} — copied.` : undefined,
        variant: "success",
      });
    } catch {
      useAppStore.getState().toast({
        title: "Copy failed",
        description: "The clipboard is unavailable in this context.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="relative overflow-hidden rounded-md border border-white/10 bg-zinc-950">
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : `Copy ${label ?? "code"} to clipboard`}
        className="absolute right-1.5 top-1.5 z-10 rounded p-1.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-teal-400/50"
      >
        {copied ? (
          <Check className="size-3.5 text-teal-400" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
      <pre
        className={cn(
          "whitespace-pre-wrap break-words p-3 pr-10 font-mono leading-relaxed text-teal-100/90",
          small ? "text-[10px]" : "text-[11px]",
        )}
      >
        {code}
      </pre>
    </div>
  );
}

/** One numbered tutorial step. */
function GuideStep({
  n,
  title,
  children,
}: {
  n: number | string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-teal-500/10 text-xs font-bold text-teal-700 dark:text-teal-300"
        aria-hidden="true"
      >
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold">{title}</p>
        {children}
      </div>
    </div>
  );
}

/** Submission-mode radio card (teal active state). */
function ModeCard({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        active
          ? "border-teal-500/60 bg-teal-500/10 text-teal-700 dark:text-teal-300"
          : "border-border text-muted-foreground hover:bg-accent",
      )}
    >
      <span className="block font-semibold">{title}</span>
      <span className="block text-[10px]">{desc}</span>
    </button>
  );
}
