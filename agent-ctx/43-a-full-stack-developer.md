# Task 43-a — full-stack-developer (I lane: I-1 RMSD axis polish)

Scope: QA conclusions #38 (dangling PDB references in the RMSD reference
selector), the rescan-stale-axis hint, and #39 (reference rmsd=0 anchoring the
metric domain) — all inside the 8 files this task owns. The `rmsdExcludeRef`
Prisma column was already added/pushed before this task started.

## Backend

- `src/lib/types.ts`: `ScreeningCandidateDTO.pdbExists: boolean` (pdbPath is
  set AND the file exists on disk, checked server-side at serialization time)
  + `ScreeningDTO.rmsdExcludeRef: boolean`.
- `src/lib/screening.ts`:
  - `toCandidateDTO` computes `pdbExists` via `existsSync`.
  - New shared helper `parseDomainMetrics(candidates, row)`: when
    `rmsdExcludeRef` is on AND `rmsdRefId` resolves to a live candidate, the
    reference's `rmsd` key is omitted from the metrics fed to
    `computeMetricDefs` (domain exclusion; a deleted reference degrades to a
    no-op because nothing matches its id).
  - `toScreeningDTO` uses the helper + returns `rmsdExcludeRef ?? false`.
  - `refreshScreeningMetrics` selects `id` too and uses the SAME helper so
    persisted metricDefs and DTO-computed defs can never disagree.
  - `patchScreening` accepts `rmsdExcludeRef?: boolean` (strict typeof
    validation → `ScreeningError(…, 400)`) and writes the column.
- `src/app/api/screening/[id]/route.ts` PATCH whitelist: `body.rmsdExcludeRef`
  validated as boolean at the HTTP boundary (clear 400 message), passed
  through to the lib (which re-validates for direct callers).

## Frontend

- `screening-panel.tsx`: `rmsdCandidates` memo now carries `pdbExists` and
  KEEPS file-missing candidates; new `rmsdStaleCount` memo (pdbExists && no
  rmsd key), `rmsdRefFileMissing` memo (current ref's file gone);
  `toggleRmsdExcludeRef` callback (PATCH → setScreening(data.screening) →
  scores/ranking/sort reflow; success/destructive toasts; `rmsdOptBusy`
  double-click guard); all new props threaded to ControlsColumn;
  `rmsdRefId` threaded to ScreeningTable; `superposeOptions` carries
  `pdbExists` for the drawer's disabled options.
- `controls-column.tsx` (RMSD card): SelectItems for file-missing candidates
  render DISABLED with an amber "· file missing" suffix; ref chip appends an
  amber warning when the reference's file is gone; amber
  `[data-testid=rmsd-stale-hint]` paragraph when a reference is set and
  N>0 PDB-backed candidates lack the rmsd key; new Switch row
  `[data-testid=rmsd-exclude-ref-toggle]` ("Exclude reference from domain")
  with muted explanation, disabled while busy; chip suffix flips between
  "(rmsd 0 Å)" and "(rmsd 0 Å · excluded from domain)".
- `screening-table.tsx`: new `rmsdRefId?: string | null` prop; the reference
  row renders an always-on secondary "REF" badge
  (`[data-testid=rmsd-ref-row-badge]`, title "RMSD axis reference") next to
  the name — in BOTH the desktop table and the mobile card list.
- `candidate-detail.tsx`: the H1a "Structural comparison" partner select
  renders file-missing options as disabled with the same amber marker
  (options carry the new `pdbExists` field).
- `scoring.ts` (report only): after the "Ranking weights" line,
  `- **RMSD reference:** <name> (excluded from domain | rmsd 0 Å anchors
  the domain)` when a reference is set.

## Verification (throwaway scripts in /home/z/i-lane-smoke — NOT in the repo)

- API smoke 19/19 on a REAL demo-engine screening: anchored domain [0,30] →
  PATCH true → excluded domain [11.9,30] → ref row still SHOWS rmsd 0 →
  detail defs == PATCH defs → other values unchanged → re-anchored [0,30] →
  cleanup. Plus 7/7 persisted-defs check (recompute under flag → persisted
  metricDefs domain [11.9,30] == DTO, bun:sqlite direct DB read).
- PATCH validation: `"true"`/`1` → 400 "rmsdExcludeRef must be a boolean".
- Browser (agent-browser): #38 — AF2 Model Ranking selector shows all 20
  dangling-PDB candidates as disabled options with "· file missing" markers
  (same in the detail drawer's partner select, 19 options); #39 — chip
  suffix flips on toggle click AND via keyboard (focus + Space), success
  toast, RMSD range-filter domain label 0–30 ↔ 11.9–30, reference row rank
  moved (49) while excluded; REF badge renders on the reference row (desktop
  + mobile DOM); stale hint: fake new run dir + rescan → "1 candidate(s)
  with PDB files have no RMSD value yet…" amber paragraph; mobile 375×812
  docScrollW 375 / mainW 319; console + page errors zero.
- Baseline hygiene: two throwaway screenings deleted, outputs/screening
  empty, field-level check — 3 screenings (rmsdRefId all None,
  rmsdExcludeRef all 0), workflows 2, nodes 14/5, toolJobs 16,
  skillInvocations 0, candidates 60/20/6.
- `bun run lint` zero warnings; `npx tsc --noEmit` only the 4 pre-existing
  examples/skills errors (zero new); dev.log zero compile/runtime errors.
- Screenshots: docs/images/32-i1-rmsd-axis-polish.png (stale hint + toggle),
  33-i1-rmsd-mobile.png (mobile).

## Deliberately left out

- No Compute-button disable for a file-missing CURRENT pick (unreachable via
  the disabled select; the server 400s honestly in the residual path).
- No changes to files owned by the concurrent L-lane agent (run/stream
  routes, workflow-runner, node-run-control, workflow-engine, prisma schema,
  README, ROADMAP). The prisma/schema.prisma + demo-baseline.db working-tree
  modifications pre-date this task (43 setup) — untouched here.
