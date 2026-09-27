#!/usr/bin/env python3
"""[mock-cluster shim] RFdiffusion repo-style entry point → REAL engine.

Provisioned at ~/foundry-lab/tools/RFdiffusion/scripts/run_inference.py —
the path the Foundry Lab cluster lane targets for script-mode tools (the
same layout a real cluster gets from `git clone RFdiffusion` into the
remote tools dir). Accepts the REAL run_inference.py hydra flag grammar:

    python3 run_inference.py \
        "contigmap.contigs=['60']" inference.num_designs=1 \
        "inference.output_prefix=<W>/design" inference.write_trajectory=False

and routes to the REAL built-in numpy engine (scripts/algorithms/
diffusion_engine.py) with {"params", "workdir"} JSON — workdir = dirname of
output_prefix. Engine stdout/exit code pass through untouched.
"""
import json
import os
import sys

ENGINE = "/home/z/my-project/scripts/algorithms/diffusion_engine.py"


def norm_contig(v: str) -> str:
    """['60'] / ['A30-60/0', '100'] / 100-150 → plain contig string."""
    s = v.strip()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    s = s.replace("'", "").replace('"', "")
    return " ".join(p.strip() for p in s.replace(",", " ").split() if p.strip())


def main() -> None:
    params = {"_tool": "rfdiffusion"}
    prefix = ""
    for a in sys.argv[1:]:
        if "=" not in a:
            continue  # bare flags: nothing on this surface needs them
        k, v = a.split("=", 1)
        if k in ("contigmap.contigs", "contigmap.contigmap", "contigmap"):
            params["contigmap"] = norm_contig(v)
        elif k in ("inference.num_designs", "num_designs"):
            params["num_designs"] = int(float(v))
        elif k in ("inference.total_length", "total_length"):
            params["total_length"] = int(float(v))
        elif k in ("inference.symmetry", "symmetry"):
            params["symmetry"] = v
        elif k in ("inference.seed", "seed"):
            params["seed"] = int(float(v))
        elif k in ("diffuser.partial_T", "partial_T"):
            params["diffuser_partial_T"] = int(float(v))
        elif k in ("inference.output_prefix", "output_prefix"):
            prefix = v
        # ppi.hotspot_res / inference.ckpt_override_path / …: accepted, engine ignores

    workdir = os.getcwd()
    if prefix:
        d = os.path.dirname(prefix) or "."
        os.makedirs(d, exist_ok=True)
        workdir = os.path.realpath(d)

    print("[mock-cluster shim] RFdiffusion run_inference.py received — routing to the REAL built-in")
    print("[mock-cluster shim] diffusion engine (Ramachandran/NeRF torsion diffusion, numpy):")
    payload = json.dumps({"params": params, "workdir": workdir})
    print(f"[mock-cluster shim] payload: {payload}")
    sys.stdout.flush()
    os.execv(sys.executable, [sys.executable, ENGINE, payload])


if __name__ == "__main__":
    main()
