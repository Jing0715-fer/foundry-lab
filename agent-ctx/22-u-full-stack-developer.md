# Task 22-u — full-stack-developer — S/E-line UI layer (Skills panel + execution controls)

Task: Implement the UI layer for the S/E line: (1) new Skills panel wired into
nav; (2) RunsSheet Stop buttons + async Retry; (3) node-card cancelled status +
on-card Stop button; (4) agent-chat search-kind icon; (5) sweep-dialog
dependency-semantics hint. No backend/API changes, no test files.

## Work log

- Read worklog.md tail (22-s1, 22-s2, 22-e) plus the skill layer source
  (`src/lib/skills/types.ts`, `/api/skills`, `/api/skills/invocations`,
  `/api/workflow/nodes/[id]/stop`) to verify every wire contract verbatim
  (stop returns `{ ok, detail }`, 409 `{ error }`; run?async=1 returns
  `{ async: true, node }`), and curl'ed both skills endpoints for real payload
  shapes before writing UI.
- Created `src/components/panels/skills-panel.tsx` (~550 lines): header with
  title/protocol description/3-cell stats strip (skills, invocations, success
  rate) + Refresh; catalog grouped Compute/Bio/Search with per-category
  Cpu/Dna/Globe icon headers; per-skill Card (mono id, gate Badge
  tools→secondary/search→outline/none→default, description, humanized
  timeout, compact semantic params table with required `*` marker,
  ```skill fence example `<pre>`, per-skill stats line when non-null);
  invocations feed (status pill emerald/rose/amber/slate, mono skillId,
  agentTitle, caller badge, duration + relative time, 2-line-clamped
  result/error) in `max-h-96 overflow-y-auto` (global thin-scrollbar styling);
  Promise.allSettled dual-endpoint loading with independent error states
  (catalog failure → EmptyState + Retry; feed-only failure → inline note);
  empty state copy per spec; mobile 1-col → sm: 2-col catalog.
- Wiring: `"skills"` added to `activePanel` union in `src/lib/store.ts`;
  NavItem `{ key: "skills", label: "Skills", icon: Puzzle }` after Agents in
  `src/components/layout/sidebar.tsx` (Puzzle unused anywhere in src);
  conditional render in `src/app/page.tsx` next to the other panels; also
  added "Go to Skills" to command-palette NAV_TARGETS for nav consistency
  (small beyond-spec touch).
- `runs-sheet.tsx`: Retry URL → `/api/workflow/nodes/:id/run?async=1` (res.ok
  = success, toast "Retry started", spinner only during the sub-second fetch;
  3s poll surfaces progress). Per-row Stop in the Active lane: real
  `<Button>` sibling of ChevronRight (row root is div[role=button] — no
  nested interactive elements), `e.stopPropagation()`, POST stop → toast
  "Stop requested" + detail / destructive toast on 409, per-row `stoppingId`
  spinner. "Stop all" button in the Active section header (only when active
  rows exist; kept OUTSIDE the h3 so the heading name stays clean),
  Promise.allSettled batch → "Stopped N nodes" summary. Row status union
  extended with cancelled: zinc icon circle + Ban icon + muted
  line-through name (Recent lane cancelled rows now render).
- `node-card.tsx`: STATUS_PILL + STATUS_STRIP + `cancelled` (zinc), zinc ring
  on the card body, Ban corner badge, third-row cancelled branch (result
  excerpt, default "Stopped"); the running row became a flex with the
  progress bar (flex-1) + trailing h-7 plain `<button>` Stop (Square icon,
  stopPropagation, relies on the pointer-capture guard that already excludes
  `button` — the B-line e2e lesson). `stopping` local state; context-menu
  Run is unconditional so cancelled nodes re-run out of the box (backend
  reclaimer accepts completed/failed/cancelled).
- `agent-chat-drawer.tsx` ToolCallCard: kind==="search" → Globe icon;
  per-lane tint on the kind label (search=emerald, bio=teal, comp=muted).
- `sweep-dialog.tsx`: C5 hint line under the variant-count preview inside the
  `data-sweep-preview` box: "Variants inherit the source node's incoming
  edges — variants without upstream dependencies start immediately and run
  in parallel with the source."
- Verification: `bun run lint` clean; `bunx tsc --noEmit | grep ^src/` empty;
  GET / → 200 with "Skills" present in SSR HTML; GET /api/skills → 200;
  dev.log no new runtime errors (one mid-edit Fast Refresh full-reload
  warning that recovered cleanly).

## Stage Summary

- All five deliverables landed; zero backend modifications; lint/tsc/page
  smoke all green. QA reviewer should scrutinize: real-pointer-click on the
  node-card Stop button (pointer-capture guard), Stop all summary toast when
  some rows 409, cancelled rendering in both canvas + Runs Recent lane, and
  the Skills panel's dual-endpoint independent error degradation.
