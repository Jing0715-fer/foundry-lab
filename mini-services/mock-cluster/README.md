# Foundry Lab mock-cluster

A LOCAL TEST CLUSTER (test harness — NOT part of the product's algorithm path): an ssh2 SSH
server that emulates the tutorial's HPC login node (`mgt`) so the cluster-execution lane can be
E2E-tested without a real HPC. Commands arriving over SSH execute FOR REAL via /bin/bash (with
HOME=`fs/home/foundry`, PATH=`fs/opt/bin:/usr/bin:/bin:/usr/local/bin`); only the scheduler is
an in-memory mini-SLURM state machine (jobs 900001+, PENDING→RUNNING after 1.5 s, `#SBATCH
--output/--error` honored, scancel SIGTERMs the process group). No science is simulated: the
comp-tool shims below route to the REAL built-in numpy engines under `scripts/algorithms/`.

## The AlphaFold2 tutorial flow (Task 25-c)

The app's AlphaFold2 tool follows this tutorial (Task 25-c):

```
salloc -N 1 --gres=gpu:1 -p brain2   # on the mgt login node
ssh gpu05                            # stage 2 only runs on GPU05
module load alphafold2
nvidia-smi                           # check free cards
CUDA_VISIBLE_DEVICES="6" run_alphafold.py --fasta_paths $test_fa \
    --output_dir T1078_AF2 --max_template_date 2021-07-20
# or from precomputed features:
CUDA_VISIBLE_DEVICES="7" run_alphafold.py --feature_file T1078_AF2/features.pkl \
    --output_dir T1078_AF2_ft
```

The mock cluster emulates every step of it:

- **`module load alphafold2`** — a `module()` bash function defined in BOTH
  `fs/home/foundry/.bash_profile` and `fs/home/foundry/.bashrc` prepends the ABSOLUTE
  `fs/opt/alphafold2/bin` to PATH (absolute so it survives any later `cd`) and echoes
  `Loading alphafold2 (mock module)`. `module list` prints the loaded mock modules; anything
  else → `module: unknown <args>` on stderr, exit 1.
- **`salloc`** — intercepted in the JS exec layer (single-segment execs starting with `salloc`):
  `-N/--nodes`, `--gres=gpu:<n>`/`-g`, `-p/--partition` are parsed (`-w/--nodelist` ignored),
  an allocation id from the SAME 900001+ counter the sbatch state machine uses is granted with
  `salloc: Granted job allocation <id>` on stderr, then the trailing command executes FOR REAL
  (detached spawn, `SLURM_JOB_ID`/`SLURM_JOB_PARTITION`/`SLURM_GPUS_ON_NODE` exported) and its
  exit code is forwarded. No trailing command → `salloc: error: interactive mode unsupported on
  this channel — append a command`, exit 1. `fs/opt/bin/salloc` is a FILE-shim twin (ids
  910001+) covering salloc NESTED inside scripts — e.g. the app's `.fl-run.sh` wrappers, whose
  setsid'd inner command is `salloc -N 1 --gres=gpu:1 -p brain2 ssh gpu05 bash <W>/.fl-node.sh`.
- **`ssh`** (`fs/opt/bin/ssh`) — `ssh gpuNN …` "logs in" to the compute node: cds to `$HOME`,
  then runs the remaining argv via `bash -c`, forwarding the exit code (`FOUNDRY_MOCK_HOST` is
  exported so tools can report the node name). Any other host → `ssh: connect to host <host>:
  No route to host`, exit 255.
- **`nvidia-smi`** — answered BOTH in the JS exec layer (direct execs) and by the
  `fs/opt/bin/nvidia-smi` file shim (nvidia-smi spawned by other commands, e.g.
  `ssh gpu05 nvidia-smi …`). Both report the same inventory: 8 × NVIDIA A100-SXM4-40GB
  (40960 MiB each), cards 0–5 busy (mem 28000–39000 MiB, util 60–98 %), cards 6–7 nearly free
  (mem < 1200 MiB, util < 5 %) — the tutorial pins `CUDA_VISIBLE_DEVICES` to 6 / 7.
- **`run_alphafold.py`** (`fs/opt/alphafold2/bin/run_alphafold.py`, on PATH after
  `module load alphafold2`) — the mock of the cluster's AF2 CLI: argparse validation with real
  AF2 semantics (`--fasta_paths` XOR `--feature_file`; `--max_template_date` required in fasta
  mode), then 5 REAL fold-engine runs (seeds 0–4) via
  `python3 /home/z/my-project/scripts/algorithms/fold_engine.py '<json>'`, assembling the full
  tutorial tree in `--output_dir`: `unrelaxed_model_{1..5}.pdb`, `relaxed_model_{1..5}.pdb`
  (byte-copies — no Amber on the mock; engine geometry already Engh-Huber valid),
  `ranked_{0..4}.pdb` (pLDDT-descending), `ranking_debug.json`, `features.pkl` (fasta mode;
  pickle with `sequence`/`msa_hits` — feeds `--feature_file` re-runs), `result_model_{1..5}.pkl`,
  `timings.json`, and `msas/{uniref90_hits.sto,bfd_uniclust_hits.a3m,magnify_hits.sto}`
  (query + 2 clearly-labeled synthetic homologs each). Finishes with the app's
  `##OUTPUTS## <json>` trailer. Per-model scratch dirs live under `--output_dir` and are
  cleaned up.

## Comp-tool shims (RESTORED — Task 26-mock)

The cluster serves BOTH tool surfaces: the 10 comp tools (RFdiffusion, RFantibody, ProteinMPNN,
LigandMPNN, SolubleMPNN, Rosetta, PyRosetta, RF3, ESMFold, ColabFold) via plain `fs/opt/bin`
shims — no `module` needed, they sit on the login PATH — AND the AlphaFold2 tutorial chain above
via `module load alphafold2`. The comp shims are TEST-HARNESS routing shims that accept each
tool's real CLI grammar and invoke the REAL built-in numpy engines, passing engine stdout and
exit codes through untouched:

- **`fs/opt/bin/RFdiffusion`** — hydra-style flags (`contigmap.contigs`/`contigmap.contigmap`,
  `inference.num_designs`, `inference.symmetry`, `inference.output_prefix`, …; aliases and bare
  names tolerated) → `shims/rfdiffusion_payload.py` builds the JSON payload → REAL
  `scripts/algorithms/diffusion_engine.py` (Ramachandran/NeRF torsion diffusion).
- **`fs/opt/bin/RFantibody`** — hydra flags (`inference.num_designs`, `inference.target_pdb`,
  `inference.hotspot_res`, `inference.cdr_scheme`) → `shims/generic_payload.py` → REAL
  `scripts/algorithms/antibody_engine.py` (germline frameworks + IMGT CDRs).
- **`fs/opt/bin/rosetta_scripts`** — Rosetta flags (`-s <pdb>`, `-parser:protocol <xml>`,
  `-nstruct N`, `-scorefunction …`, other flags swallowed token-by-token) → REAL
  `scripts/algorithms/score_engine.py` (MJ + Ramachandran + Metropolis MC).
- **`fs/opt/bin/colabfold_batch`** — `--fasta`/`--recycles`/… plus the classic positional form
  (`colabfold_batch IN [OUTDIR]`) → REAL `scripts/algorithms/fold_engine.py`
  (Chou-Fasman + recycle consensus).
- **`fs/opt/bin/rf3`** — hydra subcommand grammar (`rf3 fold input.fasta=<path>
  num_recycles=3 use_msa=true seed=42`) → REAL `scripts/algorithms/fold_engine.py`.
- **`fs/home/foundry/foundry-lab/tools/RFdiffusion/scripts/run_inference.py`** — the repo-style
  script entry point the cluster lane targets for script-mode tools (same layout a real cluster
  gets from cloning RFdiffusion into the remote tools dir); accepts the REAL `run_inference.py`
  hydra grammar incl. `contigmap.contigs=['60']` list tokens → REAL
  `scripts/algorithms/diffusion_engine.py`.
- **`fs/home/foundry/foundry-lab/tools/ProteinMPNN/protein_mpnn_run.py`** (reachable as
  `~/tools/ProteinMPNN/protein_mpnn_run.py` via the `fs/home/foundry/tools/ProteinMPNN`
  symlink) — the REAL `protein_mpnn_run.py` argparse surface (`--pdb_path`, `--out_folder`,
  `--num_seq_per_target`, `--sampling_temp`, `--seed`, `--use_soluble_model`, `--ligand_mpnn`,
  `--path_to_fasta`, …) → REAL `scripts/algorithms/mpnn_engine.py` (Gibbs sampling over
  Chou-Fasman / Kyte-Doolittle / MJ statistical potentials).

## Scheduler emulations (Task 23-b)

`sbatch`, `squeue`, `sacct`, `scancel`, `sinfo`, `nvidia-smi` are intercepted in JS and served
by the mini-SLURM state machine (plus `salloc` above). Scheduler commands must arrive as
standalone execs (`sbatch <script>`, `squeue -j <id> -h -o %T`, `sacct -j <id> [-o …]`,
`scancel <id>`, `sinfo -h -o '%P|%D|%G|%T|%l'`) — optionally prefixed by `cd <dir> &&` or
`;`-separated batches; anything embedded deeper in a bash script is not intercepted (the
`fs/opt/bin` file shims cover it). Partitions: `brain2` (gpu05, 8 GPUs — the tutorial's AF2
stage-2 node), `gpu`, `cpu`.

Password auth only; sftp is refused (files sync via exec + stdin, e.g. `head -c N > file`).

## Scheduler calls nested in scripts / command substitutions

The exec layer intercepts scheduler commands that arrive as TOP-LEVEL segments
(`sbatch <script>`, `cd W && squeue …`, `;`-separated batches). The app's
reconcile sweep however embeds `$(squeue …)` / `$(sacct …)` inside command
substitutions — real bash resolves those against PATH, where the
`fs/opt/bin/{squeue,sacct,sinfo,scancel,sbatch}` FILE SHIMS live. Shims are
separate processes and cannot see the SSH server's in-memory jobs map, so each
one (`shims/sched-client.ts`) calls the server's LOOPBACK endpoint
`http://127.0.0.1:3023/sched?tool=<t>&argv=<json>&cwd=<dir>` and replays its
stdout/stderr/exit code verbatim — one state machine, two doors (the exec
interceptor and the shims answer from the same emulators, so standalone and
nested invocations always agree). Loopback binds 127.0.0.1 only; fixed port
3023; test harness, not a product surface.

Run: `bun run dev` (hot) or `bun run start`; then connect with host `localhost`, port
`3022`, user `foundry`, password `demo`, remoteRoot `~/foundry-lab`, remoteToolsDir
`~/foundry-lab/tools`. Host key auto-generated at `keys/host_key_rsa` on first run.
