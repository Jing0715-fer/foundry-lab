#!/usr/bin/env python3
"""[mock-cluster shim] run_alphafold.py — the cluster's AlphaFold2 CLI (mock).

Loaded via `module load alphafold2` (the `module` bash function in
~/.bash_profile / ~/.bashrc prepends this directory — as an ABSOLUTE path —
to PATH). Accepts the exact grammar from the cluster tutorial:

    CUDA_VISIBLE_DEVICES="6" run_alphafold.py \\
        --fasta_paths T1078.fa --output_dir T1078_AF2 --max_template_date 2021-07-20
    CUDA_VISIBLE_DEVICES="7" run_alphafold.py \\
        --feature_file T1078_AF2/features.pkl --output_dir T1078_AF2_ft

Validates its inputs like the real wrapper (exactly one of
--fasta_paths / --feature_file; --max_template_date is required in fasta
mode), then runs the REAL built-in fold engine
(/home/z/my-project/scripts/algorithms/fold_engine.py) five times with
seeds 0–4 (model_1 … model_5) and assembles the full AF2 output tree:

    <output_dir>/features.pkl                    (fasta mode)
    <output_dir>/ranked_{0..4}.pdb               (by pLDDT; ranked_0 = best)
    <output_dir>/ranking_debug.json
    <output_dir>/relaxed_model_{1..5}.pdb
    <output_dir>/result_model_{1..5}.pkl
    <output_dir>/timings.json
    <output_dir>/unrelaxed_model_{1..5}.pdb
    <output_dir>/msas/{bfd_uniclust_hits.a3m,magnify_hits.sto,uniref90_hits.sto}

and finishes with `##OUTPUTS## <json array>` (the app's output protocol).

HONESTY (local test cluster): there is no AF2 network and no Amber here —
every structure is produced by the REAL numpy Chou-Fasman/NeRF engine,
"relaxation" is a byte-copy (the engine geometry already satisfies
Engh-Huber bond geometry), and the MSA files carry synthetic homologs
derived from the query (clearly labeled) for shape only.
"""
import argparse
import json
import os
import pickle
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ENGINE = os.environ.get(
    "FOUNDRY_AF2_ENGINE", "/home/z/my-project/scripts/algorithms/fold_engine.py"
)
MODEL_COUNT = 5          # model_1 … model_5 (the tutorial's ranked_0..4 set)
NUM_RECYCLES = 3
SEEDS = list(range(MODEL_COUNT))          # seeds 0 … 4
AA = "ACDEFGHIKLMNPQRSTVWY"
AA_LOWER = AA.lower()
MSA_HOMOLOGS_PER_DB = 2                  # query + 2 mutated homologs per DB


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.stderr.flush()
    sys.exit(code)


def note(msg):
    print(msg)
    sys.stdout.flush()


def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="run_alphafold.py",
        description="AlphaFold2 structure prediction (Foundry Lab mock cluster CLI)",
    )
    p.add_argument("--fasta_paths", default=None, metavar="P",
                   help="comma-separated FASTA path(s) — input mode 1")
    p.add_argument("--feature_file", default=None, metavar="P",
                   help="precomputed features.pkl from a previous run — input mode 2")
    p.add_argument("--output_dir", default="alphafold_out", metavar="D",
                   help="output directory (default: alphafold_out)")
    p.add_argument("--max_template_date", default=None, metavar="DATE",
                   help="template cut-off date — required with --fasta_paths")
    # accepted + ignored (common real-AF2 flags, none change the mock's flow)
    p.add_argument("--models_to_relax", default=None)
    p.add_argument("--random_seed", default=None)
    p.add_argument("--db_preset", default=None)
    p.add_argument("--num_ensemble", default=None)
    p.add_argument("--num_multimer_predictions_per_model", default=None)
    args, unknown = p.parse_known_args(argv)
    if unknown:
        note("[af2] ignoring unrecognized arguments: " + " ".join(unknown))
    return args


# ── input parsing ───────────────────────────────────────────────────────────

def read_fasta_first(path):
    """First FASTA record of <path> → (name, seq, n_records). Validates."""
    header = None
    parts = []
    n_records = 0
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith(">"):
                n_records += 1
                if header is None:
                    header = line[1:].strip() or "target"
                continue
            if n_records == 1:
                parts.append("".join(line.split()))
    if header is None:
        die("ERROR: no FASTA record found in " + path)
    seq = "".join(parts).upper()
    if not seq:
        die("ERROR: empty sequence for record '%s' in %s" % (header, path))
    bad = sorted(set(seq) - set(AA))
    if bad:
        die("ERROR: sequence '%s' contains non-amino-acid letters: %s — "
            "structure prediction requires a valid protein sequence"
            % (header, bad))
    name = header.split()[0] if header.split() else "target"
    return name, seq, n_records


def load_feature_file(path):
    """features.pkl written by a previous fasta-mode run of this shim."""
    try:
        with open(path, "rb") as f:
            feats = pickle.load(f)
    except Exception as e:  # noqa: BLE001 — report any unpicklable input honestly
        die("ERROR: cannot load feature file %s: %s" % (path, e))
    if not isinstance(feats, dict) or "sequence" not in feats:
        die("ERROR: feature file %s does not carry a 'sequence' — it was not "
            "written by this mock CLI's fasta mode" % path)
    seq = str(feats["sequence"]).upper()
    bad = sorted(set(seq) - set(AA))
    if bad:
        die("ERROR: features sequence contains non-amino-acid letters: %s" % bad)
    name = str(feats.get("name", "target"))
    msa_hits = int(feats.get("msa_hits", 0) or 0)
    return name, seq, msa_hits


# ── mock MSA files (clearly labeled synthetic homologs) ─────────────────────

def mutated(seq, rng, rate=0.08):
    chars = list(seq)
    for _ in range(max(1, int(round(len(seq) * rate)))):
        i = rng.randrange(len(chars))
        chars[i] = rng.choice([a for a in AA if a != chars[i]])
    return "".join(chars)


def write_sto(path, db, name, seq, rng):
    """Stockholm alignment: query + a few mutated homologs."""
    rows = [(name, seq)]
    for j in range(MSA_HOMOLOGS_PER_DB):
        rows.append(("%s_%03d" % (db, j + 1), mutated(seq, rng)))
    width = max(len(n) for n, _ in rows)
    lines = [
        "# STOCKHOLM 1.0",
        "",
        "# Foundry Lab mock MSA (%s) — synthetic homologs derived from the query"
        % db,
        "",
    ]
    lines += ["%s  %s" % (n.ljust(width), s) for n, s in rows]
    lines.append("//")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return MSA_HOMOLOGS_PER_DB


def write_a3m(path, db, name, seq, rng):
    """A3M: query plain, homologs with lowercase insertions."""

    def a3m_homolog():
        chars = list(mutated(seq, rng))
        for _ in range(rng.randint(1, 4)):
            chars.insert(rng.randint(0, len(chars)), rng.choice(AA_LOWER))
        return "".join(chars)

    lines = [
        "# Foundry Lab mock MSA (%s) — synthetic homologs derived from the query"
        % db,
        ">%s" % name,
        seq,
    ]
    for j in range(MSA_HOMOLOGS_PER_DB):
        lines.append(">%s_%03d" % (db, j + 1))
        lines.append(a3m_homolog())
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return MSA_HOMOLOGS_PER_DB


# ── the REAL engine (one run per model) ─────────────────────────────────────

def run_model(idx, seq, output_dir):
    """Spawn fold_engine.py with the model's payload; stream its stdout
    (filtering its own ##OUTPUTS## trailer — this shim emits the final one).
    The per-model scratch dir lives UNDER output_dir (cleaned up at the end).
    Returns (model_dir, plddt, ptm)."""
    model_dir = tempfile.mkdtemp(prefix=".af2_model_%d_" % (idx + 1),
                                 dir=output_dir)
    payload = json.dumps({
        "params": {
            "sequence": seq,
            "_tool": "alphafold",
            "num_recycles": NUM_RECYCLES,
            "seed": SEEDS[idx],
        },
        "workdir": model_dir,
    })
    note("Predicting model_%d (seed %d) ..." % (idx + 1, SEEDS[idx]))
    try:
        proc = subprocess.Popen(
            [sys.executable, ENGINE, payload],
            stdout=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except OSError as e:
        die("ERROR: cannot start the fold engine (%s): %s" % (ENGINE, e))
    for line in proc.stdout:
        if line.startswith("##OUTPUTS##"):
            continue  # engine-internal trailer — replaced by the shim's own
        sys.stdout.write(line)
        sys.stdout.flush()
    rc = proc.wait()
    if rc != 0:
        die("ERROR: fold engine failed for model_%d (exit %d)"
            % (idx + 1, rc), code=rc or 1)
    try:
        with open(os.path.join(model_dir, "metrics.json")) as f:
            metrics = json.load(f)
    except (OSError, ValueError) as e:
        die("ERROR: cannot read engine metrics for model_%d: %s" % (idx + 1, e))
    return (model_dir,
            float(metrics.get("plddt_style_confidence", 0.0)),
            float(metrics.get("ptm_proxy", 0.0)))


# ── main ────────────────────────────────────────────────────────────────────

def main():
    t_total0 = time.time()
    args = parse_args(sys.argv[1:])

    host = os.environ.get("FOUNDRY_MOCK_HOST") or socket.gethostname()
    note("[af2] alphafold2 mock CLI on %s" % host)
    cvd = os.environ.get("CUDA_VISIBLE_DEVICES")
    note("[af2] CUDA_VISIBLE_DEVICES=%s" % ("unset" if cvd is None else cvd))

    # input-mode validation (real AF2 semantics)
    if args.fasta_paths and args.feature_file:
        die("ERROR: --fasta_paths and --feature_file are mutually exclusive — "
            "provide exactly one")
    if not args.fasta_paths and not args.feature_file:
        die("ERROR: one of --fasta_paths or --feature_file is required")
    fasta_mode = bool(args.fasta_paths)
    if fasta_mode and not args.max_template_date:
        die("ERROR: --max_template_date is required for template search")
    if not os.path.isfile(ENGINE):
        die("ERROR: fold engine not found: %s" % ENGINE)

    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(output_dir, exist_ok=True)
    note("[af2] output_dir: %s" % output_dir)

    # ── preprocessing: FASTA + mock MSA, or precomputed features.pkl ────────
    t_pre0 = time.time()
    msa_hits = 0
    if fasta_mode:
        fasta_path = args.fasta_paths.split(",")[0].strip()
        if not os.path.isfile(fasta_path):
            die("ERROR: FASTA file not found: %s" % fasta_path)
        name, seq, n_records = read_fasta_first(fasta_path)
        if n_records > 1:
            note("[af2] NOTE: %d FASTA records found — using the first ('%s')"
                 % (n_records, name))
        note("[af2] fasta: %s ('%s', %d residues)" % (fasta_path, name, len(seq)))
        note("[af2] max_template_date: %s" % args.max_template_date)

        msa_dir = os.path.join(output_dir, "msas")
        os.makedirs(msa_dir, exist_ok=True)
        rng = random.Random(20210720)  # the tutorial's template date, why not
        msa_hits += write_sto(os.path.join(msa_dir, "uniref90_hits.sto"),
                              "uniref90", name, seq, rng)
        msa_hits += write_a3m(os.path.join(msa_dir, "bfd_uniclust_hits.a3m"),
                              "bfd_uniclust", name, seq, rng)
        msa_hits += write_sto(os.path.join(msa_dir, "magnify_hits.sto"),
                              "magnify", name, seq, rng)
        note("[af2] MSA: %d synthetic homologs across uniref90/bfd_uniclust/"
             "magnify (mock MSA — labeled as such in every file)" % msa_hits)
        for fn in ("uniref90_hits.sto", "bfd_uniclust_hits.a3m",
                   "magnify_hits.sto"):
            note("Wrote %s" % os.path.join(msa_dir, fn))
    else:
        feature_path = args.feature_file
        if not os.path.isfile(feature_path):
            die("ERROR: feature file not found: %s" % feature_path)
        note("[af2] Skipping MSA preprocessing (using precomputed features.pkl)")
        name, seq, msa_hits = load_feature_file(feature_path)
        note("[af2] feature_file: %s ('%s', %d residues, %d stored MSA hits)"
             % (feature_path, name, len(seq), msa_hits))
    t_pre = time.time() - t_pre0

    # ── predict: MODEL_COUNT REAL engine runs (model_1..5, seeds 0..4) ──────
    t_pred0 = time.time()
    model_dirs = []
    plddts = []
    ptms = []
    for idx in range(MODEL_COUNT):
        model_dir, plddt, ptm = run_model(idx, seq, output_dir)
        model_dirs.append(model_dir)
        plddts.append(plddt)
        ptms.append(ptm)
        note("model_%d mean pLDDT=%.1f" % (idx + 1, plddt))
    t_pred = time.time() - t_pred0

    # ── rank by pLDDT (descending; stable on ties) ──────────────────────────
    note("Ranking models by pLDDT ...")
    # Rank on the SAME 1-decimal values written to ranking_debug.json so the
    # file and the ranked_*.pdb ordering can never disagree.
    plddts_rank = [round(p, 1) for p in plddts]
    order = sorted(range(MODEL_COUNT), key=lambda i: (-plddts_rank[i], i))
    model_names = ["model_%d" % (i + 1) for i in range(MODEL_COUNT)]

    # ── relax + write the model PDBs (honest mock: no Amber on this cluster) ─
    t_relax0 = time.time()
    note("[af2] Relaxing models ... NOTE: the mock cluster has no Amber, so")
    note("[af2] relaxed_model_* are byte-copies of the unrelaxed models (the")
    note("[af2] engine geometry already satisfies Engh-Huber bond geometry —")
    note("[af2] no restraint optimization is needed).")
    unrelaxed = []
    for i in range(MODEL_COUNT):
        dst = os.path.join(output_dir, "unrelaxed_model_%d.pdb" % (i + 1))
        shutil.copyfile(os.path.join(model_dirs[i], "predicted.pdb"), dst)
        unrelaxed.append(dst)
        note("Wrote %s" % dst)
    for i in range(MODEL_COUNT):
        dst = os.path.join(output_dir, "relaxed_model_%d.pdb" % (i + 1))
        shutil.copyfile(unrelaxed[i], dst)
        note("Wrote %s" % dst)
    ranked = []
    for k, mi in enumerate(order):
        dst = os.path.join(output_dir, "ranked_%d.pdb" % k)
        shutil.copyfile(os.path.join(output_dir,
                                     "relaxed_model_%d.pdb" % (mi + 1)), dst)
        ranked.append(dst)
        note("ranked_%d.pdb <- model_%d (pLDDT %.1f)" % (k, mi + 1, plddts[mi]))
        note("Wrote %s" % dst)
    t_relax = time.time() - t_relax0

    # ── ranking_debug.json / result pickles / features.pkl / timings.json ───
    ranking_debug_path = os.path.join(output_dir, "ranking_debug.json")
    with open(ranking_debug_path, "w") as f:
        json.dump({
            "plddts": plddts_rank,
            "model_names": model_names,
            "order": order,
        }, f, indent=2)
    note("Wrote %s" % ranking_debug_path)

    for i in range(MODEL_COUNT):
        dst = os.path.join(output_dir, "result_model_%d.pkl" % (i + 1))
        with open(dst, "wb") as f:
            pickle.dump({"plddt": plddts[i], "ptm": ptms[i]}, f)
        note("Wrote %s" % dst)

    if fasta_mode:
        features_path = os.path.join(output_dir, "features.pkl")
        with open(features_path, "wb") as f:
            pickle.dump({
                "sequence": seq,
                "msa_hits": msa_hits,
                "note": "Foundry Lab mock features",
            }, f)
        note("Wrote %s" % features_path)

    timings_path = os.path.join(output_dir, "timings.json")
    t_total = time.time() - t_total0
    with open(timings_path, "w") as f:
        json.dump({
            "pre_process": round(t_pre, 3),
            "predict": round(t_pred, 3),
            "relax": round(t_relax, 3),
            "total": round(t_total, 3),
        }, f, indent=2)
    note("Wrote %s" % timings_path)

    # ── drop the per-model scratch dirs (the tree above is the deliverable) ─
    for d in model_dirs:
        shutil.rmtree(d, ignore_errors=True)

    # ── the full tutorial output tree, for the app's ##OUTPUTS## protocol ───
    outputs = []
    if fasta_mode:
        outputs.append(os.path.join(output_dir, "features.pkl"))
    outputs += ranked
    outputs.append(ranking_debug_path)
    outputs += [os.path.join(output_dir, "relaxed_model_%d.pdb" % (i + 1))
                for i in range(MODEL_COUNT)]
    outputs += [os.path.join(output_dir, "result_model_%d.pkl" % (i + 1))
                for i in range(MODEL_COUNT)]
    outputs.append(timings_path)
    outputs += unrelaxed
    if fasta_mode:
        outputs += [
            os.path.join(output_dir, "msas", "bfd_uniclust_hits.a3m"),
            os.path.join(output_dir, "msas", "magnify_hits.sto"),
            os.path.join(output_dir, "msas", "uniref90_hits.sto"),
        ]
    note("[af2] done in %.1fs — %d output file(s)" % (t_total, len(outputs)))
    print("##OUTPUTS## " + json.dumps(outputs))


if __name__ == "__main__":
    main()
