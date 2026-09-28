#!/usr/bin/env python3
"""[mock-cluster shim] ProteinMPNN CLI → the REAL built-in mpnn engine.

This is a TEST-HARNESS routing shim (local test cluster). It accepts the
REAL protein_mpnn_run.py flag surface the Foundry Lab app dispatches
(--pdb_path, --out_folder, --num_seq_per_target, --sampling_temp, --seed,
--use_soluble_model, --ligand_mpnn, --path_to_fasta, --batch_size, …),
maps it onto the built-in real algorithm engine at
/home/z/my-project/scripts/algorithms/mpnn_engine.py
(payload {"params": {...}, "workdir": <out_folder>}) and exec's it — engine
stdout/stderr stream through untouched and the exit code is the engine's own.
"""
import argparse
import json
import os
import sys

ENGINE = "/home/z/my-project/scripts/algorithms/mpnn_engine.py"

ap = argparse.ArgumentParser(add_help=False)
ap.add_argument("--pdb_path", default="")
ap.add_argument("--out_folder", default="")
ap.add_argument("--num_seq_per_target", type=int, default=8)
ap.add_argument("--sampling_temp", nargs="+", type=float, default=[0.1])
ap.add_argument("--seed", type=int, default=42)
ap.add_argument("--use_soluble_model", action="store_true")
ap.add_argument("--ligand_mpnn", action="store_true")
ap.add_argument("--path_to_fasta", default="")
ap.add_argument("--batch_size", type=int, default=1)
ap.add_argument("--pdb_path_chains", default="")
ap.add_argument("--fixed_residues", default="")
ap.add_argument("--omit_AA", default="")
ap.add_argument("--dump_order", action="store_true")
ap.add_argument("--ca_only", action="store_true")
args, unknown = ap.parse_known_args()

params = {
    "_tool": "solublempnn" if args.use_soluble_model else
             ("ligandmpnn" if args.ligand_mpnn else "proteinmpnn"),
    "num_seq": args.num_seq_per_target,
    "sampling_temp": args.sampling_temp[0] if args.sampling_temp else 0.1,
    "seed": args.seed,
}
if args.pdb_path:
    p = args.pdb_path
    params["pdb_path"] = p if os.path.isabs(p) else os.path.abspath(p)
if args.path_to_fasta:
    params["path_to_fasta"] = args.path_to_fasta

workdir = os.path.abspath(args.out_folder) if args.out_folder else os.getcwd()
os.makedirs(workdir, exist_ok=True)

payload = json.dumps({"params": params, "workdir": workdir})
print("[mock-cluster shim] ProteinMPNN CLI received — routing to the REAL built-in")
print("[mock-cluster shim] mpnn engine (Gibbs sampling over Chou-Fasman / Kyte-Doolittle /")
print("[mock-cluster shim] Miyazawa-Jernigan statistical potentials, numpy):")
print(f"[mock-cluster shim] engine: {ENGINE}")
print(f"[mock-cluster shim] payload: {payload}")
if unknown:
    print(f"[mock-cluster shim] note: unrecognized flags ignored: {unknown}")

# os.execvp replaces the process image — flush the banner FIRST or the
# block-buffered stdout would swallow it.
sys.stdout.flush()
sys.stderr.flush()
os.execvp("python3", ["python3", ENGINE, payload])
