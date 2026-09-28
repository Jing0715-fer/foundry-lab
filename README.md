# Foundry Lab — Agentic Research Workflow Studio

An agentic research workflow studio for computational protein design: build
multi-agent workflows on an interactive canvas, orchestrate LLM agents,
and run **real computational algorithms** — never simulations.

![stack](https://img.shields.io/badge/Next.js%2016-App%20Router-teal)
![lang](https://img.shields.io/badge/TypeScript-5-blue)
![db](https://img.shields.io/badge/Prisma-SQLite-orange)

## What's inside

- **Workflow canvas** — drag-and-drop nodes (agents, tasks, meetings, research
  pipelines, AlphaFold prediction, bio queries) with live progress streaming,
  minimap, undo/redo, grouping, export/import.
- **Agent layer** — LLM agents with knowledge configs, tool-calling loops,
  team meetings, multi-round research pipelines, and a PI Copilot.
- **AlphaFold2 structure prediction** — the computational tool, following the
  cluster tutorial end-to-end:
  - **Cluster lane (primary)**: connect the mgt login node over SSH (IP +
    username/password), then the app runs the tutorial flow verbatim —
    `salloc -N 1 --gres=gpu:1 -p brain2` → `ssh gpu05` →
    `module load alphafold2` → `CUDA_VISIBLE_DEVICES="6" run_alphafold.py
    --fasta_paths … --output_dir <name>_AF2 --max_template_date 2021-07-20`
    (or `--feature_file` to skip the MSA stage) — with live logs and the full
    output tree synced back (ranked_0..4.pdb by pLDDT, relaxed/unrelaxed
    models, ranking_debug.json, features.pkl, timings.json, msas/).
  - **Local lane (fallback)**: the built-in Structure Prediction Engine runs
    the published Chou-Fasman algorithm offline — a classical baseline, NOT
    the AF2 network (honest positioning everywhere).
  - **Never simulated** — there is no fake data path anywhere in the app.
- **Bio APIs** — live BLAST (NCBI URL-API with RID polling), RCSB PDB
  search, PubMed EUtils, and UniProt REST, with honest error reporting.
- **3D output viewer** — three.js molecular viewer (cartoon / ball-stick /
  space-filling) over the real PDB artifacts each run produces.

## The Environment panel

The Environment sheet (sidebar → Environment) is a **host scan + toolchain**
page:

| Tier | What it shows |
|---|---|
| Runtime | python3 / numpy / scipy / biopython / git — live version detection |
| Engines | the built-in Structure Prediction engine (local AlphaFold fallback) with self-test status |
| External | AlphaFold2 — provided on the GPU cluster via `module load alphafold2` (native status + fallback mapping) |

Uninstalled items with an **Install** button support real one-click
installation (pip / git clone + pip) with a live-streaming terminal and
automatic re-scan. Installs land in the same environment the engines use.

## Getting started

```bash
bun install
bun run db:push        # SQLite schema
bun run dev            # http://localhost:3000
```

Runtime requirements for the built-in engines: `python3` with `numpy`
(the Tools page shows exactly what's detected and installs what's missing).

## Repository layout

```
scripts/algorithms/     # the real algorithm engines (pure numpy Python)
  common.py             # Chou-Fasman, MJ potential, NeRF, Shrake-Rupley, …
  diffusion_engine.py   # rfdiffusion — torsion diffusion + backtracking
  fold_engine.py        # esmfold / rf3 / colabfold — SS prediction + assembly
  mpnn_engine.py        # proteinmpnn family — Gibbs inverse folding
  score_engine.py       # rosetta / pyrosetta — knowledge-based scoring
  antibody_engine.py    # rfantibody — germline Fv builder
src/lib/                # execution engine, registries, workflow runtime
src/app/api/            # REST API (tools run/scan/install, workflow, agents…)
src/components/         # canvas, panels, 3D viewers
prisma/                 # SQLite schema
```
