# QA Deep Review — D+F Lane (Task 27-a)

**Scope:** uncommitted D+F change set — `git diff` (14 modified files, ~530 insertions) + 3 new untracked
files (`src/lib/superpose-compare.ts`, `src/components/screening/superpose-dialog.tsx`,
`src/lib/failure-reason.ts`) + staged `db/custom.db` deletion.

**Method:** line-by-line read of the diff and all three new files; read of every write-side neighbor the
review checklist names (workflow-engine watchdog, stop route, instrumentation orphan reconcile, stream
cluster reconcile, run/runner persist lanes, nodes POST/PATCH, inspector merge, template loader,
sweep route validation, real-executor/cluster-run param flow, parser/superpose core); pure-logic smoke
runs via `bun` (compareStructures, classifyFailure, templateMatches, Math.min spread limit) and
`python3` (antibody_engine with fixed/out-of-range H3); `bunx tsc --noEmit` (clean),
`bun run lint` (clean), dev server + `/api/runs` health-checked. **No source files were modified.**

**D-line features:** D1 superposition overlay (screening compare + sweep compare), D2 antibody
affinity-maturation (cdr_h3_length axis + chain template + 3 sweep templates), D3 exports
(screening Markdown report + sweep CSV). **F-line features:** F1 failure-reason classification
(runs API + node card + runs sheet), F6 commit hygiene (db/custom.db untracked, demo:fresh).

---

## P0 — correctness / data-integrity bugs

**None found.** In particular the Task 22–25 invariants hold in this diff:

- **Zero Node.status writes anywhere in the change set** — the only `db` access in the whole diff is the
  read-only `findMany` in `src/app/api/runs/route.ts:106`. Nothing resurrects stop/watchdog-settled rows.
- All new fetches are relative (`/api/tools/file?...` in superpose-dialog.tsx:115).
- No server-side import of `document`-touching code (scoring.ts is imported only by two `"use client"`
  components — sweep-compare-dialog.tsx:52, screening-panel.tsx:85).

---

## P1 — likely bugs / contract violations

### P1-1 — RunsSheet Row swallows keyboard activation of Stop/Retry (pre-existing, merge-discarded fix; adjacent to this diff)

- **File:** `src/components/panels/runs-sheet.tsx:114-119` (Row root `onKeyDown`), buttons at 452-473 / 500-514.
- **Evidence:** the Row is `div[role=button] tabIndex=0` with `onKeyDown` that fires
  `e.preventDefault(); onClick?.()` (jumpTo) for Enter/Space **without an event-source guard**. The Stop
  and Retry buttons only `stopPropagation()` on **click** (lines 462-465, 505-508), not on keydown. So
  focusing Stop/Retry and pressing Enter: keydown bubbles to the Row → `preventDefault()` kills the
  button's default activation *and* the row navigates the canvas — keyboard users cannot Stop/Retry at all.
  The parallel C+E session's Task 23-b fixed exactly this (`e.target !== e.currentTarget` guard, worklog
  line ~3548), but merge `bc8f3b3` resolved conflicts "--ours" (the Oct-9 line) and **discarded that fix**.
  The current diff touches this exact Row (failure pill, lines 149-160) without noticing.
- **Not introduced by this diff** (pre-existing on HEAD), but it is a live P1 in the modified file and a
  direct Task 28 e2e risk.
- **Fix:** first line of the Row `onKeyDown`: `if (e.target !== e.currentTarget) return;` — one line,
  identical to the discarded parallel-line fix.

---

## P2 — likely OK but worth hardening

### P2-1 — `matchedProteinChain` can re-resolve a DIFFERENT chain than the aligned one when the reported id is `"?"` (silent all-NaN deviations)

- **File:** `src/lib/superpose-compare.ts:76-98` (fallback), 180-183 (re-resolution), 189-204 (deviation join).
- **Evidence:** the core reports `chainId.trim() || '?'` (superpose.ts:305-306). `matchedProteinChain`
  tries to match `"?"` literally, never matches (no chain is literally named `?`), and falls back to the
  **longest protein chain**. If the *aligned* chain was a blank-id chain while a longer *named* protein
  chain exists (e.g. blank-id peptide + chain A protein), the wrapper renders chain A's path and keys
  `refCAByIdx` by chain A's residue indices — while `result.pairs` reference blank-chain indices → every
  `refCAByIdx.get()` misses → **all mobileDeviations NaN → all dots gray, histogram hidden**, while the
  RMSD chip stays correct. Silent degradation, no error.
- **Reachability:** low for this app — engine PDB writers use proper ids (`H`/`L` in
  antibody_engine.py:156-167, `A` in common.py write_multi_chain_pdb), and PDB-blank-chain files collapse
  into ONE chain at parse time (parser.ts:551-559 groups *contiguous* same-id residues; blank never
  changes), so "blank + another protein chain" needs an interleaved blank/named/blank file. Verified by
  smoke: blank-chain single-chain superpose works (`?<->?`, 19/19 finite devs); multi-chain H+L picks the
  right chain (19/19 finite); a non-contiguous duplicate-id file merges into one chain (34 residues, all
  consistent).
- **Fix (one-liner):** in `matchedProteinChain`, treat `want === "?"` as "blank/whitespace chain id":
  `const blank = want === "?"; … if ((blank ? c.id.trim() === "" : c.id.trim().toUpperCase() === want) && len > bestMatchLen)`.
  (Deeper fix: have `superposeStructures` return chain indices and skip id re-resolution entirely.)

### P2-2 — runs route reads full `result` bodies for classification (bounded, but prefix would do)

- **File:** `src/app/api/runs/route.ts:101-113`.
- **Evidence:** the second query is a single bounded `findMany` (`in: failedIds`, ≤ MAX_RECENT*2 = 80 rows —
  no N+1), but it selects the whole `result` column. All three markers live in the head of the string
  ("Stopped by user…", "Error: execution timed out … (watchdog)"). Realistic `result` bodies are summary
  strings (tool nodes store `summary`, biotool a JSON hit list, agents an LLM reply — KB-scale), so the 3s
  poll is fine today; the adversarial worst case (80 × 256KB restore-capped rows = 20MB per poll +
  80 × `toLowerCase()` allocations inside `classifyFailure`) is avoidable.
- **Fix:** `reasonById.set(r.id, classifyFailure(r.result?.slice(0, 512)))` — markers are prefixes; keeps
  the poll constant-bound regardless of row content.

### P2-3 — `classifyFailure` re-runs on every NodeCard render (drag frames included)

- **File:** `src/components/canvas/node-card.tsx:535-536` (`const failureReason = status === "failed" ? classifyFailure(node.result) : null`).
- **Evidence:** `classifyFailure` does `(result ?? "").toLowerCase()` + 2-3 `includes` over up to 256KB.
  The memo comparator (node-card.tsx:842-857) already includes `result`/`status`, so re-computation only
  happens when the node actually re-renders — but a *failed* node being dragged re-renders every pointer
  frame (x/y change) and pays ~3 passes over a possibly-256KB string each frame. Cheap fix:
  `React.useMemo(() => (status === "failed" ? classifyFailure(node.result) : null), [status, node.result])`.
  Not a correctness issue — polish.

### P2-4 — `affinity-library` template partially matches non-antibody nodes (label lies)

- **File:** `src/lib/sweep-templates.ts:69-75` + `templateMatches` 82-106.
- **Evidence (smoke):** on a plain rfdiffusion node (params: num_designs, total_length) the
  affinity-library template still matches via its `num_designs` axis alone (4/8 within min 1 max 50) and is
  offered as **"Affinity maturation library"** — sweeping only num_designs, duplicating "Design count
  ladder" with a misleading antibody label. This is the documented "mismatched keys are simply skipped"
  semantic (file header), so it's a semantics/polish call, not a crash.
- **Fix:** for multi-axis templates require ALL axes to match (`if (matches.length !== axes.length) hide`),
  or render "(partial: num_designs only)" in the sweep dialog's template row.

### P2-5 — Markdown report: tags cells are not pipe-escaped

- **File:** `src/components/screening/scoring.ts:280-383` — `mdCell` is applied to name/description/notes,
  but the Tags column joins raw: `(c.tags ?? []).join("; ")` (line ~355 in buildReportMarkdown's table loop).
- **Evidence:** tags are user-editable free text (candidate-detail.tsx:174 only trims+lowercases; the PATCH
  API casts `addTags` without filtering). A tag containing `|` adds a phantom column to the report table.
- **Fix:** `(c.tags ?? []).map(mdCell).join("; ")`.

### P2-6 — sweep CSV `files` column is a count under a paths-sounding header

- **File:** `src/components/canvas/sweep-compare-dialog.tsx:240-266` — header `"files"`, cell
  `String(v.files.length)`.
- **Fix:** rename the header to `file_count` (or emit the actual paths — note they're absolute server
  paths, so the count is actually the privacy-friendlier choice; just name it honestly).

### P2-7 — superpose fetch has no AbortController

- **File:** `src/components/screening/superpose-dialog.tsx:112-157`.
- **Evidence:** closing the dialog mid-download sets `cancelled = true` (cleanup, line 158-160) and every
  setState is guarded, so there is no state corruption — but the two fetches keep downloading in the
  background (wasted bytes on big PDBs). Passing an `AbortController.signal` and `controller.abort()` in
  the cleanup would match the guard semantics exactly.

### P2-8 — commit hygiene: staged DB deletion vs unstaged everything else

- **Evidence:** `git status --short` shows `D db/custom.db` **staged** while all code changes are unstaged
  and the 3 new files are untracked. If the D+F commit is made from a partial stage, the untracking lands
  without the `.gitignore`/`demo:fresh` context. `git check-ignore` confirms db/custom.db is ignored and
  `db/demo-baseline.db` remains tracked — the end state is correct; just ensure .gitignore + deletion +
  CONTRIBUTING.md land in one commit.

### P2-9 — deviation histogram tick labels are not positionally accurate

- **File:** `src/components/screening/superpose-dialog.tsx:457-491` — the four labels (0 / 1.0 / 2.5 / max)
  are flex-evenly-spaced, but 1.0 Å and 2.5 Å sit at 1.0/max and 2.5/max of the actual bar width
  (max ≥ 2.5 by construction). With max = 8 Å the "1 Å" label sits at ~33% instead of 12.5%. Cosmetic;
  fix by absolutely positioning the threshold labels or dropping them.

### P2-10 — cdr_h3_length hint doesn't disclose the engineOnly boundary

- **File:** `src/lib/tools.ts:115`.
- **Evidence:** `buildArgs` skips engineOnly params for the native CLI (tools.ts:399) and cluster-run
  reuses buildArgs (cluster-run.ts:174) — so a user sweeping the H3 ladder on a **cluster-routed**
  RFantibody node gets variants where the axis silently does nothing (compare table shows 6/9/12/15 with
  identical outputs). The hint explains 0=auto and 4–25 but not "built-in engine only — ignored by the
  native/cluster CLI". One hint-sentence fix, or gray the axis when `_cluster` is set.

---

## P3 — nits (recorded, not blocking)

- `downloadText` prepends a UTF-8 BOM to the Markdown report too (scoring.ts:255-256) — harmless for
  `.md`, slightly unusual; could gate the BOM on CSV only.
- `antibody_engine.py:86` `int(params.get("cdr_h3_length", 0) or 0)` raises ValueError on non-numeric
  string params ("12.5") — pre-existing pattern shared with `num_designs`; the node fails visibly with
  the Python traceback, which is acceptable.
- Superposition error strings from the molecular core are i18n dual-text (`tt()`), default zh until the
  user toggles locale — consistent with the app-wide convention (i18n/index.tsx r62/r64 notes).
- Compare-dialog reference/mobile order follows *selection* order (rows[0] = first-clicked), not score
  order; the dialog description does say which is which. Consider a "swap" affordance later.
- tutorial.md / README.md do not yet mention superpose / failure pills / report export / H3 ladder —
  already tracked as Task 29 (noted per instructions, not a defect of this diff).

---

## Verified OK (each with one-line evidence)

1. **SuperposeDialog effect correctness** — deps `[open, entries]` capture everything used; the
   missing-file guard (104-108) captures `refPath`/`mobPath` into consts so narrowing survives the async
   closure; `""`/`null` pdbPath never reaches fetch (sweep's `pdbOf` `?? ""` is unreachable — the filter
   at 209-213 guarantees a `.pdb` exists).
2. **Cancelled-guard coverage** — every async setState is behind `cancelled` (143, 151, 155); reset branch
   (91-98) is synchronous; parent-unmount (both dialogs closing, or compare+sweep unmount mid-fetch)
   triggers the effect cleanup (158-160) which flips `cancelled` — no setState-after-unmount path exists.
3. **Fetch error paths** — non-JSON bodies fall back to `HTTP <status>` (JSON.parse in try/catch, 123-128);
   `/api/tools/file` returns `{error}` JSON on 400/403/404 so the message surfaces inline; `res.ok false`
   throws into the same catch; a binary/HTML 200 body degrades into "PDB parse failed: …" — all inline.
4. **superpose-compare index math** — `positions[i*3..]` matches AtomData (`Float32Array xyz*count`,
   parser.ts:24); `residueCA` scans `r.start..r.end` matching Residue semantics (parser.ts:42-43);
   `pairs` order `[mobResIdx, refResIdx]` matches the core's `residuePairs.push([mob.residueIdx…, best.seq.residueIdx…])`
   (superpose.ts:298); transform is R·p+t with the core's quat/translation; deviations = ‖T(mobCA) − refCA‖.
5. **Pure-logic smoke on real artifacts** — identical design → RMSD 0.000, 100/100 finite devs at 0.000;
   two different designs → RMSD 30.1 Å (plausible for unrelated backbones), 74/100 matched (gaps → NaN →
   gray, by design); real Fv pair (H3-12 vs H3-17 engine outputs, chains H/L) → H↔H, 95 matched, RMSD
   16.9 Å, 95/103 finite; multi-chain H+L ref vs single-chain mobile → aligns H, 19/19 finite; garbage
   input → `ok:false` inline error, no throw.
6. **`Math.min(...spread)` scaling is safe at realistic sizes** — probe: spread OK at 200k args in bun;
   worst case (parser MAX_RESIDUES 60k → 120k points × 6 spreads) is below the limit.
7. **Nested Radix Dialog behavior** — SuperposeDialog renders its own portal (ui/dialog.tsx DialogContent →
   DialogPortal), z-50 stacking by DOM order puts it above the parent; Esc dismisses the topmost
   DismissibleLayer only (superpose), leaving the parent open; while superpose is open, the parent's
   overlay/Close/table are covered so the parent cannot close from under it; in screening-panel the
   SuperposeDialog is a sibling of CompareDialog (independent Roots) — same layering logic.
8. **runs route second query** — one bounded `findMany` (`in: failedIds`, ≤80) → no N+1; classification
   requested only when `failedIds.length > 0` (line 105); `trim(n, failureReason?)` optional param, and
   `activeRows.map((n) => trim(n))` (line 125) correctly avoids the `map(trim)` index-as-second-arg footgun
   (would have been a TS error with the new signature — good defensive change).
9. **failureReason leakage** — the field is spread only when `n.status === "failed"` (route line 60);
   completed rows in `recent` omit it; a failed row missing from `reasonById` (deleted between queries)
   defaults to `"engine"`, never undefined-shaped; runs-sheet renders the pill only for
   `status === "failed" && run.failureReason` (149), so old payloads without the field degrade cleanly.
10. **Failure marker contract — all three lanes + extras** (string-level test against the exact write-side
    texts): stop route result `"Stopped by user before completion."` (stop/route.ts:110) → `stopped`;
    watchdog result `"Error: execution timed out after … (watchdog) — …"` (workflow-engine.ts:708) →
    `watchdog`; engine `Tool failed (exit N)…`/`Error: …`/cluster reconcile `Cluster job … failed` (stream
    route 153-156)/boot orphan `"Error: server restarted mid-run — re-run this node."`
    (instrumentation.ts:70) → `engine`; null/undefined/empty → `engine`. Retry-then-failed reclassifies
    from the fresh result. `classifyFailure` is case-insensitive and marker-substring based — no false
    positives among the real failure texts (runProcess timeout text `[TIMEOUT after …]` contains neither
    marker).
11. **node-card memo comparator** — `nodeEqual` (842-857) already compares `result` and `status`, so the
    pill can never go stale relative to the node; `FAILURE_META` lookups are total (Record over the union);
    e2e hooks `data-node-failure-pill` / `data-failure-pill` present.
12. **sweep-compare onSuperposeTop2** — filters completed **and** has-PDB before ranking; V8 sort is stable
    (ties keep table order); `score ?? 0` fallback is unreachable (scored.rows covers every variant);
    <2 eligible → toast, no dialog; `completedCount < 2` disables the button early (a 2-completed-no-PDB
    case still clicks → graceful toast).
13. **CSV export** — `csvEscape` is exported from scoring.ts:195 and imported correctly;
    metric cells guarded by `typeof number && Number.isFinite` (no NaN/undefined leaks, → `""`);
    score rendered only for completed rows (`.toFixed(1)` on a number); axis cells `String(v.params[k] ?? "")`;
    relative `downloadText` browser-only helper; success toast counts honest.
14. **screening-panel** — `openSuperpose` is `useCallback([])` using only setters → stable identity for the
    CompareDialog prop; `exportReport` is a plain render-scope function → fresh closure over
    `scoredRows`/`selectedIds`/`selectedSet`/`screening`/`metricDefs` each render (no stale-closure risk);
    row semantics (selection subset when selectedIds non-empty, else all rows) mirror exportCsv exactly;
    Report button mirrors Export CSV (h-11/md:h-9, `hidden sm:inline` label, `disabled={detailLoading}`,
    data-hook-less but visually paired).
15. **compare-dialog gating** — `bothHavePdb = rows.length === 2 && rows.every(r => !!r.candidate.pdbPath)`
    (65-66); disabled + explanatory title for 3-4 rows and for missing PDBs; the click handler re-checks
    `rows.length === 2` (defense in depth); `[rows[0], rows[1]]` order is documented in SuperposeDialog's
    description ("mobile is rigid-fitted onto reference"); early `return null` for 0 rows unchanged.
16. **antibody engine cdr_h3_length** — smoke: `cdr_h3_length: 12` → "Fixed CDR-H3 length: 12 residues"
    and `H3=12` in the design stats; `30` (out of range) → auto-sample (H3=17); absent → auto; the 4-25
    clamp lives in the engine (86-91) and the UI schema min 0/max 25 agrees.
17. **Param reaches the engine** — node.params → workflow-engine per-tool branch copies params minus
    `_cluster` (523-525) → executeCompTool → executeCompToolReal → runBuiltinEngine JSON payload
    `{ params: { ...params, _tool } }` (real-executor.ts ~535) → engine `params.get("cdr_h3_length")`;
    same flow for the manual tool-run route. Inspector edits merge `{...node.params, [key]: value}`
    (inspector.tsx:1176) so the key survives; nodes POST stores params unvalidated (paramsJson
    passthrough, nodes/route.ts:77-80) — engineOnly keys are IN the spec, so nothing is "unknown".
18. **engineOnly never reaches a CLI** — buildArgs skips `f.engineOnly` (tools.ts:399) and cluster-run
    reuses buildArgs with the same skip (cluster-run.ts:174) — native/cluster lanes are unaffected by
    the new param.
19. **sweep templates** — templateMatches smoke on the rfantibody schema: cdr-scheme 3/3 select options
    exact-match; h3-ladder 6/9/12/15 all within [0,25]; affinity-library 2 axes → 4 combos ≤
    MAX_COMBINATIONS 24 (client sweep-dialog.tsx:37 and server sweep route :27 agree); <2 valid values
    hides the axis; number/select/bool filtering per schema.
20. **workflow template validity** — `rfantibody` is a real NodeSpec type (COMP_TOOLS key, tools.ts:102 →
    catalog 141-179); ports: input.text → rfantibody.input (accepts text ✓), files → proteinmpnn.input
    (accepts files ✓), files → output.value (accepts files ✓) — all present in workflow-catalog;
    param keys all exist in tool specs (num_designs, cdr_h3_length, num_seq, sampling_temp within
    0.01-1.0, output_dir, gpu "0" ∈ options); template loader POSTs nodes with params verbatim
    (workflow-templates.tsx:222-249) and the nodes POST accepts them; COL/ROW constants exist
    (template-defs 46-47).
21. **SSR safety** — scoring.ts (document.createElement in downloadText) is imported only by the two
    `"use client"` components; buildReportMarkdown is pure (`new Date()` fine, only invoked from a click
    handler); failure-reason.ts and superpose-compare.ts are pure modules.
22. **Regression sweep** — no Node.status writes in the diff (grep-verified: the only db access is the
    runs-route read); no absolute URLs; stop route / stream reconcile / runner conditional persists all
    untouched; runs route remains read-only.
23. **Tooling** — `bunx tsc --noEmit` (examples/skills filtered) → zero output; `bun run lint` → zero
    warnings; dev server GET / → 200; `GET /api/runs` → 200 with the new payload shape
    (`scannedAt/active/failed/recent/summary`, no failureReason on the empty baseline).
24. **F6 commit hygiene** — `git check-ignore db/custom.db` hits (new .gitignore:79);
    `db/demo-baseline.db` still tracked (`git ls-files db/`); `demo:fresh` = `reset --force` + restart
    reminder, and reset-demo.ts supports `--force` (line 31); CONTRIBUTING.md documents the
    snapshot/reset/fresh triad + daemon-run restart.

---

## E2e test suggestions for Task 28 (risk-ordered)

1. **Failure pills, all three lanes (F1 core promise):** (a) run an agent node → Stop from RunsSheet →
   node card shows `Stopped` pill (`[data-node-failure-pill=stopped]`) + failed row pill in the sheet;
   (b) `FOUNDRY_NODE_TIMEOUT_MS=4000` + run an agent → `Watchdog` pill on card + sheet;
   (c) run rfantibody with a bad param → `Engine` pill; (d) kill/restart the dev server mid-run →
   boot-orphan row classifies `Engine` in the sheet (instrumentation reconcile); (e) network tab:
   completed rows in `recent` have NO `failureReason` field. Cleanup: `demo:fresh` + daemon-run restart.
2. **Keyboard Stop/Retry regression (expected to FAIL until P1-1 is fixed):** focus a failed row's Retry
   button, press Enter → should fire Retry, currently triggers canvas jump instead. Cover Stop the same
   way — this is the invariant "card-level interactive elements must survive real interaction" extended
   to the runs sheet.
3. **Superpose happy path (screening):** select exactly 2 candidates with PDBs → Compare → physical click
   `Superpose 3D` (`[data-superpose-trigger]`) → wait → RMSD chip + chain chip + colored mobile dots +
   histogram (`[data-superpose-canvas]`, `[data-superpose-histogram]`); press Esc → superpose closes,
   compare STAYS open; reopen → re-fetches. Also drive the zoom/spin buttons with real pointer events
   (they sit on a pointer-heavy surface).
4. **Superpose error paths:** (a) select a candidate whose PDB file was deleted from outputs/ → inline
   destructive error with the file route's message; (b) two FASTA-only candidates → button disabled +
   title "Both candidates need a linked PDB file"; (c) 3 selected → disabled, "needs 2 (has 3)".
5. **Sweep superpose + CSV (D1+D3 on real engines):** sweep `cdr_h3_length` 6/9/12/15 on an RFantibody
   node (h3-length-ladder template) → run all → SweepCompare → `Superpose top 2`
   (`[data-sweep-superpose]`) → reference = top-scored variant; `Export CSV` (`[data-sweep-export-csv]`)
   → file has 4 rows + axis column `cdr_h3_length` with 6/9/12/15, no NaN cells; also verify the engine
   log line "Fixed CDR-H3 length: N residues" per variant (proves the axis reached the engine).
6. **Report export (D3):** star + shortlist a couple of candidates, add a note, select 2 rows → Report →
   .md contains only the selected rows, weights line, Curated digest, Notes; repeat with no selection →
   all rows. (If P2-5 not fixed, avoid `|` in tags for the golden file.)
7. **Workflow template end-to-end (D2):** apply "Antibody Affinity Maturation" → 5 nodes / 4 edges
   appear; run → RFantibody (fixed H3 12) → ProteinMPNN shotgun → AlphaFold → Output cascade completes
   (engine lane; watch auto-wired pdb_path/fasta_path chain notes in logs).
8. **Nested-dialog focus/layering:** with superpose open over sweep-compare, click the dimmed area →
   only superpose closes; Esc twice → back to canvas. Confirm no page console errors throughout.
9. **Mobile sanity (375px):** screening panel header with the new Report button (icon-only below sm)
   stays overflow-free; superpose dialog scrolls within max-h-90vh.

---

*Report generated by Task 27-a (qa-reviewer). No source files were modified; throwaway scripts live in
/tmp/qa27 (outside the repo).*
