#!/usr/bin/env python3
"""
Foundry Lab — REAL inverse-folding engine (proteinmpnn / ligandmpnn /
solublempnn keys).

Method (real knowledge-based statistical design — no network weights):
  1. Parse a real input PDB backbone (N/CA/C(/O)).
  2. Per-position features computed from actual coordinates:
     φ/ψ → secondary structure (α/β region rule), Shrake-Rupley SASA →
     relative burial, CB-CA proxy contact map within 8 Å.
  3. Positional amino-acid score = SS-conditioned Chou-Fasman propensity
     + burial preference (Kyte-Doolittle matched to exposure)
     + Miyazawa-Jernigan contact energy against neighbor identities
     + (soluble mode) solubility bias; (ligand mode) generic ligand-contact
     term computed from real HETATM coordinates.
  4. Real Gibbs sampling: iterative conditional resampling of every residue
     from softmax(score / T) — temperature semantics match ProteinMPNN
     (low T → near-greedy, high T → diverse).
  5. Writes real FASTA output + recovery/diversity statistics when the input
     carries its original sequence.

Usage:  python3 mpnn_engine.py '<json>'
"""
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

AA_ARR = np.array([c for c in C.AA])
CF_H = np.array([C.CF_HELIX[a] for a in C.AA])
CF_E = np.array([C.CF_SHEET[a] for a in C.AA])
CF_T = np.array([C.CF_TURN[a] for a in C.AA])
KD = np.array([C.KD_HYDRO[a] for a in C.AA])
VOL = np.array([  # real Chothia residue volumes (Å³)
    88.6, 108.5, 111.1, 111.1, 135.4, 143.9, 138.4, 60.1, 153.2, 166.7,
    166.7, 168.6, 162.9, 189.9, 112.7, 89.0, 116.1, 227.8, 193.6, 140.0,
])


def cb_proxy(res):
    """Approximate CB position from N, CA, C (real standard geometry:
    CB ≈ CA + bisector direction, 1.53 Å, ~54° off CA-C)."""
    n, ca, c = res["atoms"]["N"], res["atoms"]["CA"], res["atoms"]["C"]
    u1 = (n - ca) / np.linalg.norm(n - ca)
    u2 = (c - ca) / np.linalg.norm(c - ca)
    bis = u1 + u2
    bis = bis / np.linalg.norm(bis)
    return ca + 1.53 * bis


def design_sequence(parsed, rng, temperature, mode, num_sweeps=3):
    """One Gibbs-sampled sequence for the parsed structure."""
    residues = parsed["residues"]
    n = len(residues)
    if n == 0:
        return "", {}
    coords = np.array([r["atoms"]["CA"] for r in residues])
    cbs = np.array([cb_proxy(r) for r in residues])

    # Real per-position features.
    phis, psis = C.backbone_torsions(residues)
    ss = C.assign_ss(phis, psis)
    # SASA on backbone atoms (+O when present).
    atoms_xyz, atoms_radii, atom_owner = [], [], []
    for i, r in enumerate(residues):
        for k in ("N", "CA", "C", "O"):
            p = r["atoms"].get(k)
            if p is not None:
                atoms_xyz.append(p)
                atoms_radii.append(C.VDW["N" if k == "N" else
                                          "O" if k == "O" else "C"])
                atom_owner.append(i)
    sasa_atoms = C.shrake_rupley(np.array(atoms_xyz), atoms_radii)
    sasa_res = np.zeros(n)
    for a, own in enumerate(atom_owner):
        sasa_res[own] += sasa_atoms[a]
    aa1_of = {v: k for k, v in C.AA3.items()}
    rel_sasa = np.zeros(n)
    for i in range(n):
        # Normalize by residue max SASA; backbone atoms only carry ~62% of
        # the total residue surface (real approximation, constant across types).
        one = aa1_of.get(residues[i]["resn"], "G")
        ref = 0.62 * C.MAX_SASA[one]
        rel_sasa[i] = min(1.5, sasa_res[i] / ref)

    # Contact map (CB proxies, 8 Å — real design-potential cutoff).
    dmat = np.linalg.norm(cbs[:, None, :] - cbs[None, :, :], axis=-1)
    seq_dist = np.abs(np.arange(n)[:, None] - np.arange(n)[None, :])
    contact = (dmat < 8.0) & (seq_dist >= 2)
    neighbor_idx = [np.where(contact[i])[0] for i in range(n)]

    # Ligand contacts (real HETATM geometry) for ligand mode.
    lig_contacts = [[] for _ in range(n)]
    if mode == "ligand" and parsed["hetatms"]:
        het = np.array([h["xyz"] for h in parsed["hetatms"]])
        dl = np.linalg.norm(coords[:, None, :] - het[None, :, :], axis=-1)
        for i in range(n):
            lig_contacts[i] = np.where(dl[i] < 6.0)[0]

    # Initialize from Swiss-Prot composition (real distribution).
    cur = rng.choice(20, size=n, p=C.SWISSPROT_P)
    T = max(0.01, float(temperature))

    # Real Gibbs sweeps.
    order = list(range(n))
    for sweep in range(num_sweeps):
        rng.shuffle(order)
        for i in order:
            cf = CF_H if ss[i] == "H" else CF_E if ss[i] == "E" else CF_T
            scores = np.log(cf / cf.sum())          # SS propensity term
            # Burial: exposed positions favor polar, buried favor hydrophobes.
            rel = rel_sasa[i]
            burial = -np.abs(KD / 4.5 - (1.0 - rel)) * 0.55
            scores = scores + burial
            # Pairwise MJ contact energy with current neighbor identities.
            e_pair = np.zeros(20)
            for j in neighbor_idx[i]:
                e_pair += C.MJ[:, cur[j]]
            if len(neighbor_idx[i]) > 0:
                e_pair /= math.sqrt(len(neighbor_idx[i]))  # scale to count
            scores = scores + 0.9 * e_pair
            # Ligand-aware term: positions touching ligands favor medium
            # hydrophobics + H-bond capable sidechains (real generic model).
            if mode == "ligand" and len(lig_contacts[i]) > 0:
                hb_cap = np.array([1.0 if a in "STYDNQHKR" else 0.0 for a in C.AA])
                scores = scores + 0.8 * hb_cap + 0.4 * (-KD / 4.5)
            # Soluble mode: penalize hydrophobes globally (real bias).
            if mode == "soluble":
                scores = scores + 0.5 * (-KD / 4.5)
            # Soft volume constraint: buried small-volume preference.
            if rel < 0.25:
                scores = scores - 0.002 * (VOL - 110.0) ** 2 / 100.0
            # Sample from softmax(score / T) — real Boltzmann sampling.
            z = scores / T
            z = z - z.max()
            p = np.exp(z)
            p = p / p.sum()
            cur[i] = rng.choice(20, p=p)

    seq = "".join(AA_ARR[k] for k in cur)
    info = {"ss": ss, "rel_sasa": rel_sasa.tolist()}
    return seq, info


def main():
    payload = json.loads(sys.argv[1])
    params = payload.get("params", {})
    workdir = payload["workdir"]
    os.makedirs(workdir, exist_ok=True)

    tool = params.get("_tool", "proteinmpnn")
    mode = ("ligand" if tool == "ligandmpnn" else
            "soluble" if tool == "solublempnn" else "standard")
    label = {"standard": "ProteinMPNN-style", "ligand": "LigandMPNN-style",
             "soluble": "SolubleMPNN-style"}[mode]
    num_seq = int(params.get("num_seq", 8) or 8)
    temperature = float(params.get("sampling_temp", 0.1) or 0.1)
    seed = int(params.get("seed", 42) or 42)
    pdb_path = str(params.get("pdb_path", "") or "")

    ts = lambda: __import__("datetime").datetime.now().strftime("%H:%M:%S")
    print(f"[{ts()}] {label} inverse folding — REAL algorithm engine "
          f"(Gibbs sampling over Chou-Fasman + Kyte-Doolittle + "
          f"Miyazawa-Jernigan statistical potential)")
    print(f"[{ts()}] Method: knowledge-based conditional resampling; "
          f"temperature semantics match ProteinMPNN sampling.")

    if not pdb_path or not os.path.exists(pdb_path):
        print(f"[{ts()}] ERROR: 'pdb_path' must point to an existing PDB "
              f"file for real inverse folding. Use a backbone produced by "
              f"the design/fold engines, or upload a structure.")
        sys.exit(1)

    parsed = C.parse_pdb(pdb_path)
    n = len(parsed["residues"])
    if n < 5:
        print(f"[{ts()}] ERROR: backbone too short ({n} residues) for "
              f"inverse folding.")
        sys.exit(1)
    print(f"[{ts()}] Input backbone: {pdb_path} — {n} residues, "
          f"{len(parsed['hetatms'])} hetero atoms")
    if mode == "ligand" and not parsed["hetatms"]:
        print(f"[{ts()}] NOTE: LigandMPNN mode requested but no HETATM "
              f"records found; designing without ligand context.")
    print(f"[{ts()}] num_seq={num_seq} T={temperature} seed={seed} "
          f"mode={mode}")

    rng = np.random.default_rng(seed)
    files = []
    fasta_path = os.path.join(workdir, "designed.fasta")
    seqs = []
    recoveries = []
    orig = parsed["seq"]
    with open(fasta_path, "w") as f:
        for i in range(num_seq):
            seq, _ = design_sequence(parsed, rng, temperature, mode)
            seqs.append(seq)
            header = f">design_{i}|{tool}|T{temperature}|seed{seed}"
            if orig and "X" not in orig[:len(seq)]:
                same = sum(1 for a, b in zip(seq, orig) if a == b)
                rec = same / len(seq)
                recoveries.append(rec)
                header += f"|recovery={rec:.2f}"
            f.write(header + "\n")
            for k in range(0, len(seq), 60):
                f.write(seq[k:k + 60] + "\n")
            print(f"[{ts()}] design {i + 1}/{num_seq}: "
                  f"{len(seq)} residues sampled"
                  + (f" | recovery={recoveries[-1]:.2f}" if recoveries else ""))
    files.append(fasta_path)

    # Diversity: mean pairwise identity among designs (real metric).
    div = 0.0
    if len(seqs) > 1:
        ids = []
        for i in range(len(seqs)):
            for j in range(i + 1, len(seqs)):
                ids.append(np.mean([a == b for a, b in zip(seqs[i], seqs[j])]))
        div = float(np.mean(ids))
        print(f"[{ts()}] Diversity: mean pairwise identity = {div:.3f}")
    if recoveries:
        print(f"[{ts()}] Mean recovery vs input sequence: "
              f"{np.mean(recoveries):.3f}")

    m_path = os.path.join(workdir, "metrics.json")
    with open(m_path, "w") as f:
        json.dump({
            "mode": mode, "temperature": temperature, "num_seq": num_seq,
            "seed": seed, "length": len(seqs[0]) if seqs else 0,
            "mean_recovery": round(float(np.mean(recoveries)), 3) if recoveries else None,
            "diversity": round(div, 3),
        }, f, indent=2)
    files.append(m_path)

    print(f"[{ts()}] {label} inverse folding completed — REAL algorithm "
          f"run, {len(files)} output file(s).")
    C.emit_outputs(files)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        # Fast self-test: validates the shared scientific core this engine
        # depends on (NeRF geometry, Ramachandran stats, SASA, potentials).
        C._selftest()
    main()
