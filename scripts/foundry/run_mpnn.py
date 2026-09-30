#!/usr/bin/env python3
"""Foundry MPNN runner — real ProteinMPNN/LigandMPNN/SolubleMPNN inference.

Bridges the app's ProteinMPNN-family job surface onto the official
RosettaCommons *foundry* re-implementation (rc-foundry wheel, models/mpnn).

Usage (spawned by the app's real executor with the foundry venv python):
    run_mpnn.py --pdb_path <in.pdb> [--num_seq 8] [--sampling_temp 0.1]
                [--model protein_mpnn|ligand_mpnn] [--soluble]
                [--out_fasta <out.fa>] [--out_pdb_dir <dir>] [--seed 42]
                [--selftest]

Outputs:
    --out_fasta  : designed sequences (FASTA, one per sampled sequence)
    stdout       : JSON result blob (sequences, recovery, metadata) for the app

Everything here is the REAL trained network (official legacy weights loaded
through foundry's MPNNInferenceEngine) — no simulation anywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

# Silence atomworks' harmless mirror-path env warnings before imports.
os.environ.setdefault("CCD_MIRROR_PATH", "")
os.environ.setdefault("PDB_MIRROR_PATH", "")


def _selftest() -> int:
    """Import-only smoke test (fast, no weights touched)."""
    import torch

    import mpnn  # noqa: F401
    from mpnn.inference_engines.mpnn import MPNNInferenceEngine

    print(f"mpnn module: {mpnn.__file__}")
    print(f"torch: {torch.__version__} (cuda={torch.cuda.is_available()})")
    print(f"MPNNInferenceEngine: {MPNNInferenceEngine.__module__}")
    print("SELFTEST OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdb_path", default="", help="Input backbone PDB")
    ap.add_argument("--num_seq", type=int, default=8, help="Sequences per backbone")
    ap.add_argument("--sampling_temp", type=float, default=0.1)
    ap.add_argument(
        "--model",
        default="auto",
        choices=["auto", "protein_mpnn", "ligand_mpnn"],
        help="Which foundry MPNN variant to run",
    )
    ap.add_argument("--soluble", action="store_true", help="Use SolubleMPNN weights")
    ap.add_argument("--out_fasta", default="", help="Output FASTA path")
    ap.add_argument("--out_pdb_dir", default="", help="Output PDB directory")
    ap.add_argument("--batch_size", type=int, default=1)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    if not args.pdb_path or not os.path.isfile(args.pdb_path):
        print(f"ERROR: --pdb_path not found: {args.pdb_path!r}", file=sys.stderr)
        return 2

    # Heavy imports kept after arg parsing so --selftest stays fast.
    import torch

    torch.manual_seed(args.seed)
    from biotite.sequence import ProteinSequence
    from biotite.structure import get_residues
    from mpnn.inference_engines.mpnn import MPNNInferenceEngine

    t0 = time.time()

    # ── Pick the foundry model variant ────────────────────────────────────
    model_type = args.model
    if model_type == "auto":
        # SolubleMPNN is the protein_mpnn architecture with soluble weights;
        # otherwise prefer ligand_mpnn (ligand-aware superset, still handles
        # protein-only inputs perfectly).
        model_type = "protein_mpnn" if args.soluble else "ligand_mpnn"

    # ── Native sequence from the input PDB (for recovery metric) ──────────
    native_seq = ""
    try:
        from atomworks.io.utils.io_utils import load_any

        loaded = load_any(args.pdb_path)
        # load_any may return an AtomArrayStack (multi-model file) — take model 0.
        atom_array = loaded[0] if hasattr(loaded, "stack_depth") else loaded
        _, res_names = get_residues(atom_array)
        for c3 in res_names:
            try:
                native_seq += ProteinSequence.convert_letter_3to1(str(c3))
            except KeyError:
                native_seq += "X"
    except Exception as e:
        print(f"NOTE: native-sequence extraction failed: {e}", file=sys.stderr)

    # ── Run the real network ──────────────────────────────────────────────
    engine_kwargs = {
        "model_type": model_type,
        "is_legacy_weights": True,  # official dauparas weights
        "out_directory": None,      # results in memory
        "write_fasta": False,
        "write_structures": False,
    }
    if args.soluble:
        # SolubleMPNN = protein_mpnn architecture + the soluble checkpoint.
        # foundry's engine only accepts protein_mpnn/ligand_mpnn model types,
        # so the soluble weights are selected via checkpoint_path (honors
        # $FOUNDRY_CHECKPOINT_DIRS through foundry's registry).
        try:
            from foundry_cli.download_checkpoints import REGISTERED_CHECKPOINTS

            engine_kwargs["checkpoint_path"] = str(
                REGISTERED_CHECKPOINTS["solublempnn"].get_default_path()
            )
        except Exception as e:
            print(f"WARNING: soluble checkpoint resolution failed: {e}", file=sys.stderr)

    engine = MPNNInferenceEngine(**engine_kwargs)
    per_input = {
        "structure_path": os.path.abspath(args.pdb_path),
        "name": "design",
        "batch_size": max(1, args.num_seq),
        "number_of_batches": 1,
        "temperature": args.sampling_temp,
        "seed": args.seed,
        "remove_waters": True,
    }
    outputs = engine.run(input_dicts=[per_input], atom_arrays=None)

    # ── Extract designed sequences ────────────────────────────────────────
    seqs: list[str] = []
    for item in outputs:
        aa = item.atom_array
        _, res_names = get_residues(aa)
        s = ""
        for c3 in res_names:
            try:
                s += ProteinSequence.convert_letter_3to1(str(c3))
            except KeyError:
                s += "X"
        seqs.append(s)

    # ── Recovery vs native (real designability metric) ────────────────────
    def recovery(designed: str) -> float | None:
        if not native_seq or len(designed) != len(native_seq):
            return None
        match = sum(a == b for a, b in zip(native_seq, designed))
        return round(match / len(native_seq), 4)

    recoveries = [r for r in (recovery(s) for s in seqs) if r is not None]

    # ── FASTA output ──────────────────────────────────────────────────────
    fasta_path = ""
    if args.out_fasta:
        d = os.path.dirname(os.path.abspath(args.out_fasta))
        os.makedirs(d, exist_ok=True)
        with open(args.out_fasta, "w") as fh:
            for i, s in enumerate(seqs):
                tag = "soluble" if args.soluble else model_type
                fh.write(f">foundry_{tag}_seq{i} T={args.sampling_temp} L={len(s)}\n")
                fh.write(s + "\n")
        fasta_path = os.path.abspath(args.out_fasta)

    result = {
        "engine": "foundry",
        "model_type": model_type,
        "soluble": bool(args.soluble),
        "is_legacy_weights": True,
        "input_pdb": os.path.abspath(args.pdb_path),
        "num_requested": args.num_seq,
        "num_designed": len(seqs),
        "sampling_temp": args.sampling_temp,
        "native_sequence": native_seq,
        "sequences": seqs[:50],
        "mean_recovery": round(sum(recoveries) / len(recoveries), 4) if recoveries else None,
        "recoveries": recoveries[:50],
        "fasta": fasta_path,
        "seconds": round(time.time() - t0, 2),
        "torch": torch.__version__,
        "cuda": bool(torch.cuda.is_available()),
    }
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
