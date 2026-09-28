#!/usr/bin/env python3
"""[mock-cluster shim helper] Build the diffusion_engine.py JSON payload.

argv: contigmap num_designs total_length symmetry seed partial_T output_prefix

Emitted payload: {"params": {...non-empty…, "_tool": "rfdiffusion"}, "workdir": …}
workdir = realpath(dirname(output_prefix)) when an output_prefix is given
(its parent directory is created first), else the current working directory.
"""
import json
import os
import sys


def main():
    contigmap, num_designs, total_length, symmetry, seed, partial_t, prefix = [
        (a if a else "") for a in sys.argv[1:8]
    ]
    params: dict = {"_tool": "rfdiffusion"}
    if contigmap:
        params["contigmap"] = contigmap
    if num_designs:
        params["num_designs"] = int(float(num_designs))
    if total_length:
        params["total_length"] = int(float(total_length))
    if symmetry:
        params["symmetry"] = symmetry
    if seed:
        params["seed"] = int(float(seed))
    if partial_t:
        params["diffuser_partial_T"] = int(float(partial_t))
    workdir = os.getcwd()
    if prefix:
        d = os.path.dirname(prefix) or "."
        os.makedirs(d, exist_ok=True)
        workdir = os.path.realpath(d)
    print(json.dumps({"params": params, "workdir": workdir}))


if __name__ == "__main__":
    main()
