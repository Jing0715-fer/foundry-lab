#!/usr/bin/env python3
"""
Foundry Lab — REAL structure prediction engine (alphafold local fallback).

Method (all real computation, no network weights required):
  1. Secondary-structure prediction with the published Chou-Fasman algorithm
     (nucleation + bidirectional extension + overlap resolution).
  2. Recycles: each pass refines the assignment using neighborhood consensus
     (real smoothing — analogous to recycles in learned predictors).
  3. Backbone construction via Ramachandran-basin torsion sampling + NeRF
     chain building with Engh & Huber covalent geometry.
  4. Per-residue confidence from propensity margins (B-factor column), with
     the mean reported as a pLDDT-style confidence estimate.

This is the LOCAL fallback for the alphafold tool — a classical baseline,
NOT the AlphaFold2 network. Real AF2 predictions run on the GPU cluster
(mgt → salloc → gpu05 → module load alphafold2 → run_alphafold.py).

Usage:  python3 fold_engine.py '<json>'     # json = {"params": {...}, "workdir": ...}
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

TOOL_LABELS = {
    "alphafold": "AlphaFold2-style folding (local Chou-Fasman engine)",
    "esmfold": "ESMFold-style single-sequence folding",
    "rf3": "RoseTTAFold3-style folding",
    "colabfold": "AlphaFold2/ColabFold-style folding",
}


def predict_chain(seq, recycles, rng, use_msa):
    """Real prediction pipeline for one chain. Returns (ss, conf, residues)."""
    ss = C.chou_fasman(seq)
    # Recycles: neighborhood-consensus refinement (real smoothing passes).
    for _ in range(max(0, int(recycles))):
        new = list(ss)
        for i in range(len(seq)):
            lo, hi = max(0, i - 2), min(len(seq), i + 3)
            counts = {"H": 0, "E": 0, "L": 0}
            for k in range(lo, hi):
                counts[ss[k]] += 1
            cur = ss[i]
            counts[cur] += 1  # self weight
            best = max(counts, key=counts.get)
            new[i] = best
        ss = "".join(new)
    conf = C.ss_confidence(seq, ss)
    residues = C.build_backbone(ss, rng, seq=seq)
    return ss, conf, residues


def main():
    payload = json.loads(sys.argv[1])
    params = payload.get("params", {})
    workdir = payload["workdir"]
    os.makedirs(workdir, exist_ok=True)

    tool = params.get("_tool", "alphafold")
    label = TOOL_LABELS.get(tool, tool)
    recycles = int(params.get("num_recycles", 3) or 3)
    use_msa = bool(params.get("use_msa", True))
    seed = int(params.get("seed", 42) or 42)
    rng = np.random.default_rng(seed)

    # Resolve sequences: inline sequence (bare or with a >FASTA header), or
    # a FASTA file.
    seqs = []
    if params.get("sequence"):
        raw = str(params["sequence"]).strip()
        if raw.startswith(">"):
            # Pasted FASTA — header line(s) + wrapped sequence. Strip them.
            lines = [l.strip() for l in raw.splitlines()]
            body = "".join(l for l in lines[1:] if l and not l.startswith(">"))
            name = lines[0][1:].split()[0] if len(lines[0]) > 1 else "target"
            seqs.append((name or "target", body.upper()))
        else:
            seqs.append((f"{tool}_target", "".join(raw.split()).upper()))
    elif params.get("fasta_path") and os.path.exists(params["fasta_path"]):
        for hdr, s in C.read_fasta(params["fasta_path"]):
            seqs.append((hdr.split()[0] if hdr.split() else "target", s.upper()))
    if not seqs:
        print(f"[ERROR] No input sequence: provide 'sequence' or an existing "
              f"'fasta_path'.")
        sys.exit(1)

    # Validate.
    for name, s in seqs:
        bad = set(s) - set(C.AA)
        if bad:
            print(f"[ERROR] Sequence '{name}' contains non-amino-acid letters: "
                  f"{sorted(bad)}. Real folding requires a valid protein "
                  f"sequence.")
            sys.exit(1)

    ts = lambda: __import__("datetime").datetime.now().strftime("%H:%M:%S")
    print(f"[{ts()}] {label} — REAL algorithm engine (Chou-Fasman SS "
          f"prediction + Ramachandran/NeRF backbone construction)")
    print(f"[{ts()}] Method: knowledge-based statistical prediction "
          f"(published Chou-Fasman parameters; no neural-network weights "
          f"required)")
    if use_msa and tool == "alphafold":
        print(f"[{ts()}] NOTE: the real MSA search (jackhmmer/MMseqs2 against "
              f"the AF2_databases) runs on the GPU cluster; the local engine "
              f"predicts in single-sequence mode. Connect the mgt cluster for "
              f"real AlphaFold2 predictions with MSA.")
    print(f"[{ts()}] Targets: {len(seqs)} | recycles={recycles} | seed={seed}")

    chains_out = []
    all_conf = []
    offset = np.array([0.0, 0.0, 0.0])
    files = []
    metrics = {"targets": [], "recycles": recycles, "method": label}

    for idx, (name, seq) in enumerate(seqs):
        chain_id = chr(ord("A") + idx)
        print(f"[{ts()}] Predicting target {idx + 1}/{len(seqs)} '{name}' "
              f"({len(seq)} residues)...")
        ss, conf, residues = predict_chain(seq, recycles, rng, use_msa)
        for r_i in range(len(residues)):
            for k in ("N", "CA", "C", "O"):
                residues[r_i]["atoms"][k] = residues[r_i]["atoms"][k] + offset
        nh = ss.count("H")
        ne = ss.count("E")
        conf_mean = float(np.mean(conf))
        print(f"[{ts()}]   SS: {nh} helical / {ne} extended / "
              f"{len(seq) - nh - ne} loop residues")
        print(f"[{ts()}]   Confidence (propensity-margin pLDDT-style): "
              f"{conf_mean:.1f}")
        chains_out.append((chain_id, residues, conf))
        all_conf.extend(conf.tolist())
        metrics["targets"].append({
            "name": name, "length": len(seq), "helical": nh, "extended": ne,
            "confidence": round(conf_mean, 1),
            "ss": ss,
        })
        # offset next chain to the right to avoid overlap
        xmax = max(r["atoms"]["CA"][0] for r in residues)
        offset = offset + np.array([xmax + 12.0, 0.0, 0.0])

    plddt = float(np.mean(all_conf))
    ptm = float(np.clip(0.3 + plddt / 160.0, 0.0, 0.95))
    print(f"[{ts()}] Mean confidence pLDDT-style={plddt:.1f} "
          f"pTM-proxy={ptm:.2f}")

    pdb_path = os.path.join(workdir, "predicted.pdb")
    C.write_multi_chain_pdb(
        pdb_path, chains_out,
        header=[
            f"REAL ENGINE: {label}",
            "SS: Chou-Fasman 1978 (nucleation/extension rules)",
            "GEOMETRY: Ramachandran basin sampling + NeRF, Engh-Huber bonds",
            f"RECYCLES: {recycles}  SEED: {seed}",
        ],
        title=f"{tool} prediction",
    )
    files.append(pdb_path)
    print(f"[{ts()}] Wrote {pdb_path} ({len(chains_out)} chain(s))")

    m_path = os.path.join(workdir, "metrics.json")
    with open(m_path, "w") as f:
        json.dump({**metrics,
                   "plddt_style_confidence": round(plddt, 1),
                   "ptm_proxy": round(ptm, 2)}, f, indent=2)
    files.append(m_path)

    # FASTA echo of the input (useful downstream).
    fa_path = os.path.join(workdir, "input.fasta")
    with open(fa_path, "w") as f:
        for name, seq in seqs:
            f.write(f">{name}\n")
            for i in range(0, len(seq), 60):
                f.write(seq[i:i + 60] + "\n")
    files.append(fa_path)

    print(f"[{ts()}] {label} completed — REAL algorithm run, "
          f"{len(files)} output file(s).")
    C.emit_outputs(files)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        # Fast self-test: validates the shared scientific core this engine
        # depends on (NeRF geometry, Ramachandran stats, SASA, potentials).
        C._selftest()
    main()
