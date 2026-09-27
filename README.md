# Foundry Lab — Agentic Research Workflow Studio

An agentic research workflow studio for computational protein design: build
multi-agent workflows on an interactive canvas, orchestrate LLM agents,
and run **real computational algorithms** — never simulations.

![stack](https://img.shields.io/badge/Next.js%2016-App%20Router-teal)
![lang](https://img.shields.io/badge/TypeScript-5-blue)
![db](https://img.shields.io/badge/Prisma-SQLite-orange)

## What's inside

- **Workflow canvas** — drag-and-drop nodes (agents, tasks, meetings, research
  pipelines, computational tools, bio queries) with live progress streaming,
  minimap, undo/redo, grouping, export/import.
- **Agent layer** — LLM agents with knowledge configs, tool-calling loops,
  team meetings, multi-round research pipelines, and a PI Copilot.
- **Real tool execution** — every computational run goes through the
  execution engine:
  1. **Native**: if the upstream tool is installed on the host (e.g. a real
     ProteinMPNN clone + torch), it runs natively.
  2. **Built-in real algorithm engines**: otherwise, the shipped Python
     science engines execute the job with real algorithms and published
     data — Chou-Fasman secondary-structure prediction, Ramachandran-basin
     torsion sampling with NeRF chain construction, Miyazawa-Jernigan
     contact potentials, Shrake-Rupley SASA, Metropolis Monte-Carlo
     minimization, knowledge-based scoring with ΔSASA interfaces and
     alanine-scan ΔΔG.
  3. **Never simulated** — there is no fake data path anywhere in the app.
- **Bio APIs** — live BLAST (NCBI URL-API with RID polling), RCSB PDB
  search, PubMed EUtils, and UniProt REST, with honest error reporting.
- **3D output viewer** — three.js molecular viewer (cartoon / ball-stick /
  space-filling) over the real PDB artifacts each run produces.

## The Tools page

The Tools panel is an **environment & toolchain** page:

| Tier | What it shows |
|---|---|
| Runtime | python3 / numpy / scipy / biopython / git — live version detection |
| Engines | the five built-in real algorithm engines with self-test status |
| External | RFdiffusion, ProteinMPNN family, Rosetta, RF3, ESMFold, ColabFold… native install status + which engine covers the fallback |

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
