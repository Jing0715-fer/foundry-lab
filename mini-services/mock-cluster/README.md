# Foundry Lab mock-cluster

A LOCAL TEST CLUSTER (test harness — NOT part of the product's algorithm path): an ssh2 SSH
server that emulates an HPC login node so the cluster-execution lane (Task 23-a) can be
E2E-tested without a real HPC. Commands arriving over SSH execute FOR REAL via /bin/bash
(with HOME=`fs/home/foundry`, PATH=`fs/opt/bin:/usr/bin:/bin:/usr/local/bin`); only the
scheduler (`sbatch/squeue/sacct/scancel/sinfo`, `nvidia-smi`) is an in-memory mini-SLURM
state machine (jobs 900001+, PENDING→RUNNING after 1.5 s, `#SBATCH --output/--error` honored,
scancel SIGTERMs the process group). No science is simulated: the tool shims in `fs/opt/bin`
(RFdiffusion, RFantibody, rosetta_scripts, colabfold_batch, rf3) and
`fs/home/foundry/{,foundry-lab/}tools/ProteinMPNN/protein_mpnn_run.py` route to the REAL
built-in numpy engines under `scripts/algorithms/`. Scheduler commands must arrive as
standalone execs (`sbatch <script>`, `squeue -j <id> -h -o %T`, `sacct -j <id> [-o …]`,
`scancel <id>`, `sinfo -h -o '%P|%D|%G|%T|%l'`) — optionally prefixed by `cd <dir> &&` or
`;`-separated batches; anything embedded deeper in a bash script is not intercepted.
Password auth only; sftp is refused (files sync via exec + stdin, e.g. `head -c N > file`).

Run: `bun run dev` (hot) or `bun run start`; then connect with host `localhost`, port
`3022`, user `foundry`, password `demo`, remoteRoot `~/foundry-lab`, remoteToolsDir
`~/foundry-lab/tools`. Host key auto-generated at `keys/host_key_rsa` on first run.
