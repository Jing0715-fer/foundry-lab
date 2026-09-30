# Task 25-d — frontend agent — AlphaFold2 Structure Prediction panel

Task: Create `src/components/panels/alphafold-panel.tsx`, the single, beautiful,
responsive "AlphaFold2 Structure Prediction" panel (default export
`AlphaFoldPanel`, no props) that replaces the removed comp-tool system. Teal
accent (the alphafold tool color), shadcn/ui + lucide icons, all API contracts
per task spec. The main agent wires it into the sidebar/page/store.

## Work log

- Read worklog.md tail (23-a/b/c, 23-final, 24-rfdiffusion-native) plus
  cluster-panel.tsx, tools-panel.tsx, output-viewer-dialog.tsx,
  lib/tools.ts, lib/types.ts, lib/cluster/types.ts, and the API routes
  (connections POST upsert with `af2`, [id]/test, [id]/gpus, tools/run,
  tools/jobs, jobs/[id]/stop, tools/scan) to verify every contract verbatim
  before writing UI code.
- Verified client-safety: only imports from `@/lib/tools`
  (parseFastaInput / af2OutputDirFor / buildTutorialPreview / type defs) and
  `@/lib/types` + `@/lib/cluster/types` (pure). Server-only `@/lib/alphafold`
  is NOT imported.
- Verified the local fold engine reads `params.sequence` as a BARE residue
  string (scripts/algorithms/fold_engine.py validates against the AA alphabet
  and rejects '>' headers) → local runs send `parsedSeq.seq`, cluster runs send
  the raw FASTA (server-side materializeSequence parses + stages input/<name>.fa).
- Wrote the panel (~2380 lines) with sections:
  1. Header — title + subtitle (Jumper et al. 2021, mgt → salloc → gpu05 →
     module load alphafold2) + live badges: # connections, cluster probe state
     (tools[0]/alphafold installed → "alphafold2: ready on cluster"), local
     engine state from GET /api/tools/scan (engine-fold self-test).
  2. Guide card — Collapsible, default OPEN on first load, remembered in
     localStorage `foundry-lab:af2-guide`. Steps 1 / 2 / 3 / 4a / 4b with dark
     monospace CodeBlocks + copy buttons (navigator.clipboard + toast via
     useAppStore.getState().toast), FASTA format note, output-files Table,
     paths card (AF2_db with "do not modify" warning, site-packages path),
     SSH login note.
  3. Connection card — Select with "＋ New connection", editor (name/host/port/
     username/password with "unchanged" placeholder when hasPassword/
     remoteRoot + AlphaFold cluster settings partition/node/module), POST
     upsert (id edit; password omitted = keep, "" = clear), Delete with
     confirm, Test connection (compact probe: identity, Slurm + partitions,
     moduleSystem, alphafold2 row, GPUs), "Check GPUs on <node>" (per-card
     table with memory progress bar + util% + busy-muted/free-highlighted +
     Use button that pins the GPU card select; 502 → inline actionable error),
     quick-add "Add local test cluster (mock)" (localhost:3022, partition gpu).
  4. Prediction form — input Tabs (Sequence (FASTA) / FASTA on cluster /
     features.pkl) with live parseFastaInput validation (green "name — N
     residues" / red error), Load tutorial example button (exact T1078
     fragment), output dir auto-derived via af2OutputDirFor + editable,
     max template date 2021-07-20, GPU card Select 0–7; Advanced Collapsible
     with salloc (default) / direct / slurm mode cards + partition/node/module
     (pre-filled from the connection's af2 settings, only on selection change)
     + walltime; live buildTutorialPreview command block
     (remoteWorkdir `~/foundry-lab/jobs/alphafold/<new>`; tutorial form when
     no connection); Run on cluster (202 → "Prediction dispatched" toast,
     spinner, disabled without connection; sends connectionId/mode/partition/
     node/module/cudaDevice/gpus:1+cpusPerTask:4 for slurm/timeLimitMin) and
     Run locally (201 → toast; honest Chou-Fasman hint; disabled in
     features.pkl mode).
  5. Jobs card — GET /api/tools/jobs polled at 2.5s ONLY while an alphafold
     job is live (staging/running/syncing), refresh on visibilitychange and
     on dispatch — no idle infinite polling; client-side filter
     j.tool === "alphafold". Rows: color-coded phase chips (staging slate,
     running teal pulse, syncing amber, done emerald, failed rose, cancelled
     zinc), input summary (sequence→"name, N aa" / fasta_path / feature_file
     basename), connection + mode badges (local · engine for local runs),
     started time + elapsed + out dir + file count/bytes synced + exit code,
     expanded live log tail (pre, max-h-64, custom thin teal scrollbar,
     stdout+stderr), Stop (active), View outputs (shared OutputViewerDialog →
     3D ranked_*.pdb viewer), best-model mini-summary ("N models ranked ·
     ranked_0.pdb = highest pLDDT" + file-count badge when ≥5 .pdb synced).
  6. Footer honesty note — local Chou-Fasman baseline vs real AF2 on the GPU
     cluster, five models ranked by pLDDT.
- Responsive: max-w-4xl mx-auto, p-4 sm:p-6, space-y-6; sm:grid-cols-2/3/4
  grids; wrap-safe tabs, tables, badges, log tails; no horizontal overflow at
  375px (all long paths/commands use break-words / truncate).
- A11y: Labels on all inputs, aria-labels on icon buttons, aria-expanded on
  expanders, aria-pressed on mode cards, aria-invalid + aria-live on FASTA
  validation, semantic header/section/footer landmarks, keyboard-focusable
  everywhere (radix + focus-visible rings).
- Loading/error states: skeletons (connections, GPUs, jobs), spinner badges,
  conn error card with Retry, probe error card with hints, GPU 502 inline
  error with hints, destructive toasts on every failed action.

## Verification

- `bunx eslint src/components/panels/alphafold-panel.tsx` → clean (exit 0).
- `bunx tsc --noEmit` → zero errors in my file (only pre-existing errors in
  src/lib/cluster/run-scripts.ts, another agent's in-progress backend file —
  a syntax error at line 201 that also breaks GET /api/workflow per dev.log;
  NOT touched by me).
- Icons verified against installed lucide-react 0.525.0; all shadcn components
  (card/tabs/input/textarea/label/button/badge/select/separator/collapsible/
  table/progress/skeleton) verified present with matching exports.
- OutputViewerDialog actual props confirmed: { job, open, onClose, nodeMode? }
  — used as specified; its Structure tab appears automatically when
  outputFiles contains .pdb files (covers alphafold ranked_*.pdb).
- Could NOT verify in-browser: the panel isn't wired into the page yet (main
  agent's job per task split) and /api/tools/jobs currently 500s until the
  backend agent finishes run-scripts.ts — the panel handles non-ok responses
  gracefully (empty state, no crash).

## Stage summary

- `src/components/panels/alphafold-panel.tsx` created: default export
  `AlphaFoldPanel`, no props, teal-accented, fully responsive, a11y-pass,
  lint-clean, type-clean, using only client-safe imports and verified API
  contracts.
- The whole tutorial flow (guide → connection → probe → GPU pick → prediction
  → live logs → 3D outputs) is self-contained in one panel.
