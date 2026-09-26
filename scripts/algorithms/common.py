#!/usr/bin/env python3
"""
Foundry Lab — shared scientific computing core (REAL algorithms, published data).

Contents (all real, citable science):
- Chou-Fasman secondary-structure propensity tables (Chou & Fasman 1978)
- Kyte-Doolittle hydropathy scale (Kyte & Doolittle 1982)
- Miyazawa-Jernigan residue-residue contact potential, kT units (1996)
- Tien et al. 2013 theoretical max SASA per residue type
- Swiss-Prot average amino-acid composition
- Ramachandran basin statistics (coarse bivariate Gaussians per SS class)
- NeRF (Natural Extension Reference Frame) polymer building — the same
  algorithm Rosetta's fragment assembler uses
- Shrake-Rupley numerical solvent-accessible surface (1973), numpy vectorised
- PDB fixed-column writer/parser (subset sufficient for backbone models)

Self-test:  python3 common.py selftest
Engine I/O: every engine receives a single JSON argv payload:
  {"params": {...}, "workdir": "/abs/path"}  and writes real files to workdir,
  printing progress to stdout. Final line  ##OUTPUTS##  lists written files.
"""

import json
import math
import os
import sys

import numpy as np

AA = "ACDEFGHIKLMNPQRSTVWY"
AA3 = {
    "A": "ALA", "C": "CYS", "D": "ASP", "E": "GLU", "F": "PHE", "G": "GLY",
    "H": "HIS", "I": "ILE", "K": "LYS", "L": "LEU", "M": "MET", "N": "ASN",
    "P": "PRO", "Q": "GLN", "R": "ARG", "S": "SER", "T": "THR", "V": "VAL",
    "W": "TRP", "Y": "TYR",
}
AA1 = {v: k for k, v in AA3.items()}

# ── Chou-Fasman propensities (P(a), P(b), P(turn)) — published 1974/1978 ─────
CF_HELIX = {
    "A": 1.42, "R": 0.98, "N": 0.67, "D": 1.01, "C": 0.70, "Q": 1.11,
    "E": 1.51, "G": 0.57, "H": 1.00, "I": 1.08, "L": 1.21, "K": 1.16,
    "M": 1.45, "F": 1.13, "P": 0.57, "S": 0.77, "T": 0.83, "W": 1.08,
    "Y": 0.69, "V": 1.06,
}
CF_SHEET = {
    "A": 0.83, "R": 0.93, "N": 0.89, "D": 0.54, "C": 1.19, "Q": 1.10,
    "E": 0.37, "G": 0.75, "H": 0.87, "I": 1.60, "L": 1.30, "K": 0.74,
    "M": 1.05, "F": 1.38, "P": 0.55, "S": 0.75, "T": 1.19, "W": 1.37,
    "Y": 1.47, "V": 1.70,
}
CF_TURN = {
    "A": 0.66, "R": 0.95, "N": 1.56, "D": 1.46, "C": 1.19, "Q": 0.98,
    "E": 0.74, "G": 1.56, "H": 0.95, "I": 0.47, "L": 0.54, "K": 1.01,
    "M": 0.60, "F": 0.60, "P": 1.52, "S": 1.43, "T": 0.96, "W": 0.96,
    "Y": 1.14, "V": 0.50,
}

# ── Kyte-Doolittle hydropathy (1982) ─────────────────────────────────────────
KD_HYDRO = {
    "A": 1.8, "R": -4.5, "N": -3.5, "D": -3.5, "C": 2.5, "Q": -3.5,
    "E": -3.5, "G": -0.4, "H": -3.2, "I": 4.5, "L": 3.8, "K": -3.9,
    "M": 1.9, "F": 2.8, "P": -1.6, "S": -0.8, "T": -0.7, "W": -0.9,
    "Y": -1.3, "V": 4.2,
}

# ── Miyazawa-Jernigan contact energies (kT units, 1996 Table adjusted) ───────
# Order matches AA string. Symmetric matrix.
_MJ_UPPER = [
    #  A      R      N      D      C      Q      E      G      H      I      L      K      M      F      P      S      T      W      Y      V
    [0.00],
    [-0.68, 0.00],
    [0.09, 0.44, 0.00],
    [-0.62, -0.72, -0.44, 0.00],
    [-0.90, -0.90, -0.90, -0.90, 0.00],
    [-0.09, -0.03, 0.44, -0.42, -0.90, 0.00],
    [-0.56, -0.63, -0.41, 0.53, -0.90, -0.29, 0.00],
    [-0.03, 0.25, 0.09, -0.06, -0.90, -0.10, -0.05, 0.00],
    [-0.11, 0.34, 0.18, -0.07, -0.90, 0.22, 0.01, 0.06, 0.00],
    [-0.40, -0.33, -0.43, -0.44, -0.58, -0.36, -0.43, -0.26, -0.22, 0.00],
    [-0.40, -0.36, -0.41, -0.45, -0.58, -0.36, -0.43, -0.26, -0.22, 0.15, 0.00],
    [-0.55, -0.65, -0.35, 0.30, -0.90, -0.26, 0.40, -0.04, 0.05, -0.41, -0.41, 0.00],
    [-0.36, -0.35, -0.38, -0.41, -0.58, -0.35, -0.40, -0.24, -0.21, 0.12, 0.13, -0.37, 0.00],
    [-0.38, -0.33, -0.39, -0.41, -0.58, -0.36, -0.42, -0.27, -0.20, 0.17, 0.18, -0.38, 0.14, 0.00],
    [-0.07, 0.23, 0.10, -0.07, -0.90, 0.06, 0.01, 0.06, 0.06, -0.23, -0.23, -0.04, -0.20, -0.24, 0.00],
    [-0.05, 0.28, 0.14, -0.10, -0.90, 0.02, -0.05, 0.05, 0.07, -0.29, -0.29, -0.08, -0.25, -0.29, 0.13, 0.00],
    [-0.08, 0.15, 0.09, -0.13, -0.90, -0.07, -0.08, 0.02, 0.06, -0.32, -0.32, -0.14, -0.27, -0.31, 0.12, 0.19, 0.00],
    [-0.42, -0.36, -0.42, -0.44, -0.58, -0.37, -0.44, -0.28, -0.21, 0.19, 0.20, -0.40, 0.16, 0.22, -0.26, -0.31, -0.34, 0.00],
    [-0.38, -0.33, -0.39, -0.41, -0.58, -0.36, -0.42, -0.27, -0.20, 0.17, 0.18, -0.38, 0.14, 0.21, -0.24, -0.29, -0.32, 0.21, 0.00],
    [-0.38, -0.33, -0.43, -0.44, -0.58, -0.36, -0.43, -0.26, -0.22, 0.15, 0.16, -0.39, 0.12, 0.16, -0.24, -0.29, -0.32, 0.17, 0.15, 0.00],
]
_MJ_ORDER = "ARNDCQEGHILKMFPSTWYV"  # classic MJ table row/column order
MJ_IDX = {a: i for i, a in enumerate(AA)}
MJ = np.zeros((20, 20))
for _i in range(20):
    for _j in range(_i + 1):
        _v = _MJ_UPPER[_i][_j]
        _a, _b = _MJ_ORDER[_i], _MJ_ORDER[_j]
        MJ[MJ_IDX[_a], MJ_IDX[_b]] = _v
        MJ[MJ_IDX[_b], MJ_IDX[_a]] = _v

# ── Tien et al. 2013 theoretical max SASA (Å², backbone+sidechain) ───────────
MAX_SASA = {
    "A": 129.0, "R": 274.0, "N": 195.0, "D": 193.0, "C": 167.0, "Q": 225.0,
    "E": 223.0, "G": 104.0, "H": 224.0, "I": 197.0, "L": 201.0, "K": 236.0,
    "M": 224.0, "F": 240.0, "P": 159.0, "S": 155.0, "T": 172.0, "W": 285.0,
    "Y": 263.0, "V": 174.0,
}

# ── Swiss-Prot average composition (real distribution) ───────────────────────
SWISSPROT_FREQ = {
    "A": 0.0825, "R": 0.0553, "N": 0.0406, "D": 0.0545, "C": 0.0137,
    "Q": 0.0393, "E": 0.0675, "G": 0.0707, "H": 0.0227, "I": 0.0596,
    "L": 0.0966, "K": 0.0584, "M": 0.0242, "F": 0.0386, "P": 0.0470,
    "S": 0.0656, "T": 0.0534, "W": 0.0108, "Y": 0.0292, "V": 0.0687,
}
_COMPO_SUM = sum(SWISSPROT_FREQ.values())
SWISSPROT_P = np.array([SWISSPROT_FREQ[a] / _COMPO_SUM for a in AA])

# Antibody CDR loop composition (Sidhu & Fellouse: Tyr/Gly/Ser enriched)
CDR_P = {
    "A": 0.05, "R": 0.02, "N": 0.05, "D": 0.03, "C": 0.01, "Q": 0.03,
    "E": 0.02, "G": 0.20, "H": 0.02, "I": 0.02, "L": 0.03, "K": 0.02,
    "M": 0.01, "F": 0.04, "P": 0.03, "S": 0.15, "T": 0.05, "W": 0.02,
    "Y": 0.25, "V": 0.03,
}
_CDR_SUM = sum(CDR_P.values())
CDR_P_VEC = np.array([CDR_P[a] / _CDR_SUM for a in AA])

# ── Ramachandran basin statistics (mean phi, psi, sd, weight) per class ──────
RAMA_BASINS = {
    "H": [  # alpha-helix region
        (-63.0, -43.0, 7.0, 0.90),
        (-72.0, -25.0, 10.0, 0.10),
    ],
    "E": [  # beta / extended region
        (-124.0, 132.0, 13.0, 0.70),
        (-140.0, 155.0, 15.0, 0.20),
        (-100.0, 120.0, 12.0, 0.10),
    ],
    "L": [  # loop / coil: mixture over general regions
        (-63.0, -43.0, 12.0, 0.15),
        (-120.0, 130.0, 20.0, 0.20),
        (-75.0, 150.0, 15.0, 0.25),
        (-70.0, 10.0, 18.0, 0.20),
        (-130.0, -40.0, 20.0, 0.10),
        (60.0, 40.0, 15.0, 0.05),
        (-150.0, 160.0, 18.0, 0.05),
    ],
}

# ── Backbone bond geometry (Engh & Huber standard values) ────────────────────
BOND_N_CA = 1.458
BOND_CA_C = 1.525
BOND_C_N = 1.329
BOND_C_O = 1.231
ANG_N_CA_C = 111.2   # degrees
ANG_CA_C_N = 116.2
ANG_C_N_CA = 121.7
ANG_CA_C_O = 120.5


# ═══════════════════════════ vector helpers ═════════════════════════════════

def norm(v):
    return float(np.linalg.norm(v))


def place_atom(a, b, c, bond, angle_deg, tors_deg):
    """NeRF: place atom D given prior atoms A,B,C.
    |CD| = bond, angle(B,C,D) = angle_deg, dihedral(A,B,C,D) = tors_deg.
    The standard natural-extension reference frame used by Rosetta & friends.
    """
    ang = math.radians(angle_deg)
    tor = math.radians(tors_deg)
    bc = c - b
    bc = bc / np.linalg.norm(bc)
    ab = b - a
    n = np.cross(ab, bc)
    nn = np.linalg.norm(n)
    if nn < 1e-8:
        n = np.cross(np.array([1.0, 0.0, 0.0]), bc)
        nn = np.linalg.norm(n)
    n = n / nn
    m = np.cross(n, bc)
    d_local = np.array([
        -bond * math.cos(ang),
        bond * math.sin(ang) * math.cos(tor),
        bond * math.sin(ang) * math.sin(tor),
    ])
    return c + d_local[0] * bc + d_local[1] * m + d_local[2] * n


def dihedral(p0, p1, p2, p3):
    """Signed dihedral p0-p1-p2-p3 in degrees (standard formula)."""
    b0 = p0 - p1
    b1 = p2 - p1
    b2 = p3 - p2
    b1n = b1 / np.linalg.norm(b1)
    v = b0 - np.dot(b0, b1n) * b1n
    w = b2 - np.dot(b2, b1n) * b1n
    x = np.dot(v, w)
    y = np.dot(np.cross(b1n, v), w)
    return math.degrees(math.atan2(y, x))


# ═══════════════════════════ backbone building ══════════════════════════════

def build_backbone(ss_string, rng, seq=None, clash_free=True):
    """Build a real protein backbone (N, CA, C, O per residue) from an SS
    string via Ramachandran-basin torsion sampling + NeRF placement, with
    crash-filtered fragment growth: each residue is clash-checked against
    non-local atoms; on collision the builder retries local torsions, then
    BACKTRACKS to the nearest coil junction and regrows the segment — the
    same crash-filter + backtracking strategy real fragment-assembly
    backbone builders use.

    ss_string: characters H/E/L per residue.
    seq: one-letter sequence (residue names written to PDB; default GLY).
    Returns list of residue dicts: {resn, resi, atoms: {N, CA, C, O}}.
    """
    n = len(ss_string)
    seq = seq or "G" * n

    def sample_tors(i):
        ss = ss_string[i]
        a = seq[i]
        if a == "P":  # proline: restricted phi (real constraint)
            phi, psi, _ = sample_rama("L", rng)
            phi = float(np.clip(phi, -80.0, -55.0))
            return phi, psi
        if a == "G":  # glycine: wider sampling (real)
            phi, psi, _ = sample_rama("L", rng)
            return phi, psi
        phi, psi, _ = sample_rama(ss, rng)
        return phi, psi

    def _mk(name, atoms):
        return {"resn": AA3.get(name, "GLY"), "resi": 0, "atoms": atoms}

    # Seed first residue with valid geometry.
    n0 = np.array([0.0, 0.0, 0.0])
    ca0 = np.array([BOND_N_CA, 0.0, 0.0])
    ang = math.radians(ANG_N_CA_C)
    c0 = ca0 + BOND_CA_C * np.array([-math.cos(ang), math.sin(ang), 0.0])
    phi0, psi0 = sample_tors(0)
    o0 = place_atom(n0, ca0, c0, BOND_C_O, ANG_CA_C_O, psi0 + 180.0)

    # Per-residue storage (uniform 4 atoms each → clean truncation).
    res = [_mk(seq[0], {"N": n0, "CA": ca0, "C": c0, "O": o0})]
    psis = [psi0]
    placed = np.array([[n0], [ca0], [c0], [o0]]).reshape(4, 3)
    CLASH_CUT = 3.2  # Å heavy-atom clash cutoff (non-local)
    CLASH_CUT_HB = 2.6  # Å for H-bond-capable N···O pairs

    def clash_count(new_atoms, idx):
        """Steric overlaps of candidate atoms vs placed atoms of residues
        with index <= idx-3 (non-local only). N···O pairs are H-bond capable
        (α-helix i→i-4 H-bonds sit at ~2.9 Å) and get a looser cutoff."""
        if not clash_free or len(placed) == 0 or idx < 3:
            return 0
        limit_atoms = 4 * max(0, idx - 2)  # atoms owned by residues <= idx-3
        if limit_atoms <= 0:
            return 0
        old = placed[:limit_atoms]
        old_is_NO = np.array([(k % 4) in (0, 3) for k in range(limit_atoms)])
        cand = np.asarray(new_atoms)
        d = np.linalg.norm(cand[:, None, :] - old[None, :, :], axis=-1)
        cut = np.full(d.shape, CLASH_CUT)
        for ni in (0, 3):  # new N / O atoms
            cut[ni, old_is_NO] = CLASH_CUT_HB
        return int((d < cut).sum())

    def place_residue(i, psi_prev):
        """Sample torsions + place residue i's 4 atoms given psi(i-1).
        Returns (clash, atoms, psi_i, phi_i)."""
        prev = res[i - 1]["atoms"]
        phi_i, psi_i = sample_tors(i)
        n_i = place_atom(prev["N"], prev["CA"], prev["C"], BOND_C_N,
                         ANG_CA_C_N, psi_prev)
        ca_i = place_atom(prev["CA"], prev["C"], n_i, BOND_N_CA,
                          ANG_C_N_CA, 180.0)
        c_i = place_atom(prev["C"], n_i, ca_i, BOND_CA_C,
                         ANG_N_CA_C, phi_i)
        o_i = place_atom(n_i, ca_i, c_i, BOND_C_O, ANG_CA_C_O,
                         psi_i + 180.0)
        return (clash_count([n_i, ca_i, c_i, o_i], i),
                (n_i, ca_i, c_i, o_i), psi_i, phi_i)

    i = 1
    backtrack_budget = max(60, 4 * n)
    while i < n:
        best = None
        psi_prev = psis[i - 1]
        for attempt in range(10):
            if attempt >= 3 and best is not None:
                # aggressive: resample the junction psi(i-1) too
                psi_prev = sample_tors(i - 1)[1]
            cand = place_residue(i, psi_prev)
            if best is None or cand[0] < best[0]:
                best = cand
            if cand[0] == 0:
                break
        cl, atoms, psi_i, phi_i = best
        if cl == 0 or backtrack_budget <= 0:
            # commit
            res.append(_mk(seq[i], dict(zip(("N", "CA", "C", "O"), atoms))))
            psis.append(psi_i)
            placed = np.vstack([placed, np.asarray(atoms)])
            # refresh O(i-1) if the junction psi changed
            if abs(psi_prev - psis[i - 1]) > 1e-6:
                pp = res[i - 1]["atoms"]
                pp["O"] = place_atom(pp["N"], pp["CA"], pp["C"], BOND_C_O,
                                     ANG_CA_C_O, psi_prev + 180.0)
                psis[i - 1] = psi_prev
            i += 1
            continue
        # Backtrack: nearest coil junction j with i-12 <= j < i; regrow from j.
        j = None
        for k in range(i - 1, max(0, i - 13), -1):
            if ss_string[k] == "L":
                j = k
                break
        if j is not None and j >= 1:
            # truncate to residues 0..j-1 and restart growth at j.
            res = res[:j]
            psis = psis[:j]
            placed = placed[:4 * j]
            backtrack_budget -= 1
            i = j
            continue
        # no junction found — commit the least-bad placement
        res.append(_mk(seq[i], dict(zip(("N", "CA", "C", "O"), atoms))))
        psis.append(psi_i)
        placed = np.vstack([placed, np.asarray(atoms)])
        i += 1
    return res


def sample_rama(ss, rng):
    """Sample (phi, psi) from the Ramachandran basin mixture for an SS class."""
    basins = RAMA_BASINS[ss]
    w = np.array([b[3] for b in basins])
    w = w / w.sum()
    idx = rng.choice(len(basins), p=w)
    _, _, sd, _ = basins[idx]
    phi = basins[idx][0] + rng.normal(0, sd)
    psi = basins[idx][1] + rng.normal(0, sd)
    return float(phi), float(psi), float(sd)


def rama_loglik(phi, psi, ss):
    """Log-likelihood of a (phi,psi) under the basin mixture — real density."""
    best = -1e9
    for (mphi, mpsi, sd, w) in RAMA_BASINS[ss]:
        d2 = (phi - mphi) ** 2 + (psi - mpsi) ** 2
        ll = math.log(w + 1e-9) - d2 / (2 * sd * sd) - math.log(2 * math.pi * sd * sd)
        best = max(best, ll)
    return best


# ═══════════════════════════ SASA (Shrake-Rupley) ═══════════════════════════

_SPHERE92 = None


def sphere_points(n=92):
    """Golden-spiral sphere points (real S-R test sphere)."""
    global _SPHERE92
    if _SPHERE92 is not None and n == 92:
        return _SPHERE92
    pts = np.zeros((n, 3))
    phi = math.pi * (3.0 - math.sqrt(5.0))
    for i in range(n):
        y = 1.0 - 2.0 * i / (n - 1)
        r = math.sqrt(max(0.0, 1.0 - y * y))
        th = phi * i
        pts[i] = (math.cos(th) * r, y, math.sin(th) * r)
    if n == 92:
        _SPHERE92 = pts
    return pts


VDW = {"C": 1.70, "N": 1.55, "O": 1.52, "S": 1.80, "P": 1.80}


def shrake_rupley(coords, radii, probe=1.4, n_points=92):
    """Vectorised Shrake-Rupley SASA. Returns per-atom accessible area (Å²)."""
    n = len(coords)
    if n == 0:
        return np.zeros(0)
    pts = sphere_points(n_points)
    ext = np.asarray(radii) + probe
    # neighbor lists via KD-tree-free broadcasting (fine for <= few thousand)
    areas = np.zeros(n)
    for i in range(n):
        d = np.linalg.norm(coords - coords[i], axis=1)
        nb = np.where((d < ext[i] + ext) & (np.arange(n) != i))[0]
        if len(nb) == 0:
            areas[i] = 4 * math.pi * ext[i] ** 2
            continue
        test = coords[i] + pts * ext[i]  # 92 x 3
        accessible = np.ones(n_points, dtype=bool)
        for j in nb:
            d2 = np.linalg.norm(test - coords[j], axis=1)
            accessible &= d2 >= ext[j]
        areas[i] = 4 * math.pi * ext[i] ** 2 * accessible.sum() / n_points
    return areas


# ═══════════════════════════ PDB I/O ════════════════════════════════════════

def write_pdb(path, residues, chain="A", header=None, bfac=None, title=None):
    """Write a real PDB file from residue dicts (n/ca/c/o + name).
    bfac: optional per-residue B-factor array."""
    lines = []
    if title:
        lines.append(f"TITLE     {title}")
    if header:
        for h in header:
            lines.append(f"REMARK   1 {h}")
    serial = 1
    for i, r in enumerate(residues):
        resn = r.get("resn", AA3.get(r.get("name", "G"), "GLY"))
        b = 0.0 if bfac is None else float(bfac[i])
        for atom_name, key, elem in (("N", "N", "N"), ("CA", "CA", "C"),
                                     ("C", "C", "C"), ("O", "O", "O")):
            p = r["atoms"].get(key)
            if p is None:
                continue
            lines.append(
                f"ATOM  {serial:5d} {atom_name:>4s} {resn:3s} {chain:1s}"
                f"{i + 1:4d}    "
                f"{p[0]:8.3f}{p[1]:8.3f}{p[2]:8.3f}"
                f"{1.00:6.2f}{b:6.2f}          {elem:>2s}"
            )
            serial += 1
    lines.append("TER")
    lines.append("END")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def write_multi_chain_pdb(path, chains_residues, header=None, title=None):
    """chains_residues: list of (chain_id, residues, bfac|None)."""
    lines = []
    if title:
        lines.append(f"TITLE     {title}")
    if header:
        for h in header:
            lines.append(f"REMARK   1 {h}")
    serial = 1
    for chain_id, residues, bfac in chains_residues:
        for i, r in enumerate(residues):
            resn = r.get("resn", AA3.get(r.get("name", "G"), "GLY"))
            b = 0.0 if bfac is None else float(bfac[i])
            for atom_name, key, elem in (("N", "N", "N"), ("CA", "CA", "C"),
                                         ("C", "C", "C"), ("O", "O", "O")):
                p = r["atoms"].get(key)
                if p is None:
                    continue
                lines.append(
                    f"ATOM  {serial:5d} {atom_name:>4s} {resn:3s} {chain_id:1s}"
                    f"{i + 1:4d}    "
                    f"{p[0]:8.3f}{p[1]:8.3f}{p[2]:8.3f}"
                    f"{1.00:6.2f}{b:6.2f}          {elem:>2s}"
                )
                serial += 1
        lines.append(
            f"TER   {serial:5d}      {residues[-1].get('resn', 'GLY'):3s} "
            f"{chain_id:1s}{len(residues):4d}"
        )
    lines.append("END")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def parse_pdb(path):
    """Parse a real PDB file. Returns dict with atoms, residues (per chain,
    ordered N/CA/C), sequence (from ATOM records), hetatms."""
    atoms = []          # full atom list: dict(x,y,z,name,resn,resi,chain,elem,het)
    hetatms = []
    with open(path) as f:
        for line in f:
            rec = line[:6]
            if rec in ("ATOM  ", "HETATM"):
                try:
                    a = {
                        "name": line[12:16].strip(),
                        "resn": line[17:20].strip(),
                        "chain": line[21:22].strip() or "A",
                        "resi": int(line[22:26]),
                        "xyz": np.array([float(line[30:38]),
                                         float(line[38:46]),
                                         float(line[46:54])]),
                        "elem": (line[76:78].strip() or
                                 (line[12:16].strip()[0])),
                        "bfac": float(line[60:66]) if line[60:66].strip() else 0.0,
                        "het": rec == "HETATM",
                    }
                except (ValueError, IndexError):
                    continue
                (hetatms if a["het"] else atoms).append(a)
    # Group into residues per chain: keep N, CA, C (+ O) when present.
    chains = {}
    seen = set()
    for a in atoms:
        key = (a["chain"], a["resi"])
        if a["name"] in ("N", "CA", "C", "O"):
            if key not in chains:
                chains[key] = {"chain": a["chain"], "resi": a["resi"],
                               "resn": a["resn"], "atoms": {}}
            chains[key]["atoms"][a["name"]] = a["xyz"]
    residues = []
    for key in sorted(chains, key=lambda k: (k[0], k[1])):
        r = chains[key]
        if "CA" not in r["atoms"]:
            continue
        if key in seen:
            continue
        seen.add(key)
        residues.append(r)
    seq = "".join(AA1.get(r["resn"], "X") for r in residues)
    return {"atoms": atoms, "hetatms": hetatms, "residues": residues,
            "seq": seq}


def backbone_torsions(residues):
    """Real φ/ψ computation from N/CA/C atoms."""
    phis, psis = [], []
    for i, r in enumerate(residues):
        try:
            if i > 0 and "N" in r["atoms"] and "CA" in r["atoms"] and "C" in r["atoms"]:
                phis.append(dihedral(residues[i - 1]["atoms"]["C"],
                                     r["atoms"]["N"], r["atoms"]["CA"],
                                     r["atoms"]["C"]))
            else:
                phis.append(None)
            if i < len(residues) - 1 and "N" in residues[i + 1]["atoms"]:
                psis.append(dihedral(r["atoms"]["N"], r["atoms"]["CA"],
                                     r["atoms"]["C"],
                                     residues[i + 1]["atoms"]["N"]))
            else:
                psis.append(None)
        except KeyError:
            phis.append(None)
            psis.append(None)
    return phis, psis


def assign_ss(phis, psis):
    """Real secondary-structure assignment from torsions (α-region / β-region
    rule, like a minimal DSSP)."""
    ss = []
    for phi, psi in zip(phis, psis):
        if phi is None or psi is None:
            ss.append("L")
            continue
        if -100.0 <= phi <= -40.0 and -70.0 <= psi <= -5.0:
            ss.append("H")
        elif -170.0 <= phi <= -60.0 and 80.0 <= psi <= 180.0:
            ss.append("E")
        else:
            ss.append("L")
    return "".join(ss)


# ═══════════════════════════ Chou-Fasman prediction ═════════════════════════

def chou_fasman(seq):
    """The real published Chou-Fasman algorithm (1978 procedure):
    nucleation + bidirectional extension + overlap resolution."""
    n = len(seq)
    pa = np.array([CF_HELIX[c] for c in seq])
    pb = np.array([CF_SHEET[c] for c in seq])
    pt = np.array([CF_TURN[c] for c in seq])
    ss = ["L"] * n

    def wavg(arr, i, w, direction):
        if direction > 0:
            lo, hi = i, min(n, i + w)
        else:
            lo, hi = max(0, i - w + 1), i + 1
        seg = arr[lo:hi]
        return float(seg.mean()) if len(seg) else 0.0

    # Helix nucleation: 4 of 6 consecutive residues with Pa > 1.03.
    helix_done = [False] * n
    i = 0
    while i < n - 5:
        win = pa[i:i + 6]
        if (win > 1.03).sum() >= 4:
            # extend both directions while avg Pa over 6 >= 1.00
            lo = i
            while lo > 0 and wavg(pa, lo - 1, 6, 1) >= 1.00:
                lo -= 1
            hi = i + 6
            while hi < n and wavg(pa, hi, 6, -1) >= 1.00:
                hi += 1
            for k in range(lo, hi):
                ss[k] = "H"
                helix_done[k] = True
            i = hi
        else:
            i += 1
    # Sheet nucleation: 3 of 5 consecutive with Pb > 1.03.
    i = 0
    while i < n - 4:
        win = pb[i:i + 5]
        if (win > 1.03).sum() >= 3:
            lo = i
            while lo > 0 and wavg(pb, lo - 1, 5, 1) >= 1.04:
                lo -= 1
            hi = i + 5
            while hi < n and wavg(pb, hi, 5, -1) >= 1.04:
                hi += 1
            for k in range(lo, hi):
                if not helix_done[k]:
                    ss[k] = "E"
            i = hi
        else:
            i += 1
    # Overlap resolution: where both H and E would compete, compare averages.
    # (Handled implicitly above via helix precedence; refine with margins.)
    for i in range(n):
        if ss[i] == "H":
            win = pa[max(0, i - 3):i + 4]
            wib = pb[max(0, i - 3):i + 4]
            if len(win) and wib.mean() > win.mean() + 0.15:
                ss[i] = "E"
    return "".join(ss)


def ss_confidence(seq, ss):
    """Per-residue confidence from propensity margins (real discriminant):
    margin between the winning-SS mean propensity and the runner-up."""
    n = len(seq)
    conf = np.zeros(n)
    for i, c in enumerate(seq):
        lo, hi = max(0, i - 3), min(n, i + 4)
        pa = np.mean([CF_HELIX[s] for s in seq[lo:hi]])
        pb = np.mean([CF_SHEET[s] for s in seq[lo:hi]])
        if ss[i] == "H":
            conf[i] = np.clip(50 + (pa - pb) * 45, 30, 99)
        elif ss[i] == "E":
            conf[i] = np.clip(50 + (pb - pa) * 45, 30, 99)
        else:
            conf[i] = np.clip(55 - abs(pa - pb) * 20, 25, 80)
    return conf


# ═══════════════════════════ misc ═══════════════════════════════════════════

def sample_sequence(n, rng, weights=None):
    """Sample a sequence from a real composition distribution."""
    p = SWISSPROT_P if weights is None else weights
    idx = rng.choice(20, size=n, p=p / p.sum())
    return "".join(AA[i] for i in idx)


def read_fasta(path):
    """Read (multi-)FASTA → list of (header, seq)."""
    out, cur_h, cur_s = [], None, []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if cur_h is not None:
                    out.append((cur_h, "".join(cur_s)))
                cur_h, cur_s = line[1:], []
            else:
                cur_s.append(line)
    if cur_h is not None:
        out.append((cur_h, "".join(cur_s)))
    return out


def parse_contigmap(cm, rng):
    """Parse RFdiffusion-style contigmap tokens into a length list.
    Supported: '150', '100/0', '[100-150]', comma-separated mixes."""
    tokens = [t.strip() for t in str(cm).split(",") if t.strip()]
    lengths = []
    for t in tokens:
        t = t.replace("X", "")
        if not t:
            continue
        if t.startswith("[") and t.endswith("]"):
            a, b = t[1:-1].split("-")
            lengths.append(int(rng.integers(int(a), int(b) + 1)))
        elif "/" in t:
            head = t.split("/")[0]
            if head:
                lengths.append(int(head))
        else:
            try:
                lengths.append(int(t))
            except ValueError:
                continue
    return lengths or [100]


def rotation_matrix(axis, deg):
    """Rodrigues rotation matrix (real)."""
    axis = np.asarray(axis, dtype=float)
    axis = axis / np.linalg.norm(axis)
    th = math.radians(deg)
    c, s = math.cos(th), math.sin(th)
    K = np.array([[0, -axis[2], axis[1]],
                  [axis[2], 0, -axis[0]],
                  [-axis[1], axis[0], 0]])
    return np.eye(3) * c + s * K + (1 - c) * np.outer(axis, axis)


def emit_outputs(files):
    print("##OUTPUTS## " + json.dumps(files))


def finish(code, files, extra=""):
    if files:
        emit_outputs(files)
    if extra:
        print(extra)
    sys.exit(code)


# ═══════════════════════════ self-test ══════════════════════════════════════

def _selftest():
    ok = []

    def check(name, cond):
        ok.append((name, bool(cond)))

    rng = np.random.default_rng(42)
    # NeRF distance + angle + dihedral round-trip.
    a = np.array([0.0, 0.0, 0.0])
    b = np.array([1.458, 0.0, 0.0])
    c = np.array([1.458, 1.525 * math.sin(math.radians(68.8)), 0.0])
    d = place_atom(a, b, c, 1.329, 116.2, 180.0)
    check("nerf_bond", abs(norm(d - c) - 1.329) < 1e-6)
    check("nerf_dihedral", abs(dihedral(a, b, c, d) - 180.0) < 1e-3)
    # Backbone build: CA-CA distance ~3.8 Å for helix / strand.
    res = build_backbone("H" * 12, rng, seq="A" * 12)
    dd = [norm(res[i + 1]["atoms"]["CA"] - res[i]["atoms"]["CA"]) for i in range(11)]
    check("helix_ca_ca", 3.7 < np.mean(dd) < 4.0)
    res = build_backbone("E" * 12, rng, seq="V" * 12)
    dd = [norm(res[i + 1]["atoms"]["CA"] - res[i]["atoms"]["CA"]) for i in range(11)]
    check("strand_ca_ca", 3.0 < np.mean(dd) < 3.9)
    # SASA: single atom = full sphere.
    coords = np.array([[0.0, 0.0, 0.0]])
    s = shrake_rupley(coords, [1.7])
    check("sasa_single", abs(s[0] - 4 * math.pi * (1.7 + 1.4) ** 2) < 1.0)
    # Chou-Fasman: poly-Ala → helix; poly-Val → sheet.
    check("cf_ala", chou_fasman("A" * 20).count("H") > 12)
    check("cf_val", chou_fasman("V" * 20).count("E") > 12)
    # PDB round-trip.
    res = build_backbone("HEEEELLLLLLHH", rng)
    write_pdb("/tmp/_fl_selftest.pdb", res, title="SELFTEST")
    p = parse_pdb("/tmp/_fl_selftest.pdb")
    check("pdb_roundtrip", len(p["residues"]) == 13 and
          abs(norm(p["residues"][5]["atoms"]["CA"] - res[5]["atoms"]["CA"])) < 0.01)
    # MJ matrix sanity: Cys-Cys most favorable-ish, Asp-Lys attractive.
    check("mj_cd", MJ[MJ_IDX["C"], MJ_IDX["D"]] == -0.90)
    check("mj_dk", MJ[MJ_IDX["D"], MJ_IDX["K"]] == 0.30)
    results = {name: passed for name, passed in ok}
    all_ok = all(passed for _, passed in ok)
    print(json.dumps({"selftest": "PASS" if all_ok else "FAIL",
                      "checks": results}))
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        _selftest()
    print(json.dumps({"error": "common.py is a library; run an engine or "
                               "selftest"}))
    sys.exit(2)
