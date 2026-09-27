#!/usr/bin/env python3
"""CPU-compatibility patches for RFdiffusion's Python dependencies.

Two upstream issues break RFdiffusion inference on CPU-only hosts:

1. se3_transformer annotates its forward pass with `torch.cuda.nvtx.range(...)`
   profiling ranges. On CPU-only torch builds, entering an NVTX range raises
   `RuntimeError: NVTX functions not installed`. These are *profiling
   annotations only* — swapping them for a no-op context manager when CUDA is
   unavailable changes zero numerics.

2. `import dgl` hard-fails at import time when the GraphBolt C++ library was
   not compiled for the installed torch version (dgl 2.1.0 ships graphbolt
   libs for torch 2.0-2.2 only). RFdiffusion uses classic `dgl.graph()` (core
   libdgl.so, which loads fine), never GraphBolt dataloaders — so the loader
   is made best-effort with a warning instead of a hard ImportError.

Idempotent: safe to re-run (the one-click install runs it after pip steps).
"""
import pathlib
import sysconfig

PURELIB = pathlib.Path(sysconfig.get_paths()["purelib"])

NVTX_MARKER = "# foundry-lab cpu-safe nvtx"
NVTX_OLD = "from torch.cuda.nvtx import range as nvtx_range"
NVTX_NEW = (
    f"{NVTX_MARKER}\n"
    "from contextlib import contextmanager as _cm\n"
    "import torch as _torch\n"
    "if _torch.cuda.is_available():\n"
    "    from torch.cuda.nvtx import range as nvtx_range\n"
    "else:\n"
    "    @_cm\n"
    "    def nvtx_range(*a, **k):\n"
    "        yield\n"
)

DGL_MARKER = "# foundry-lab best-effort graphbolt"
DGL_OLD = "\nload_graphbolt()\n"
DGL_NEW = (
    f"\n{DGL_MARKER}\n"
    "try:\n"
    "    load_graphbolt()\n"
    "except Exception:\n"
    "    import warnings\n"
    "    warnings.warn(\"DGL GraphBolt C++ library not loaded (torch version "
    "mismatch) - GraphBolt dataloaders unavailable; classic dgl.graph() is unaffected.\")\n"
)


def patch_nvtx() -> int:
    n = 0
    for rel in [
        "se3_transformer/model/basis.py",
        "se3_transformer/model/layers/attention.py",
        "se3_transformer/model/layers/convolution.py",
        "se3_transformer/model/layers/norm.py",
    ]:
        p = PURELIB / rel
        if not p.exists():
            print(f"  [patch:nvtx] skip (not installed): {rel}")
            continue
        s = p.read_text()
        if NVTX_MARKER in s:
            print(f"  [patch:nvtx] already patched: {rel}")
            continue
        if NVTX_OLD not in s:
            print(f"  [patch:nvtx] skip (import not found): {rel}")
            continue
        p.write_text(s.replace(NVTX_OLD, NVTX_NEW, 1))
        print(f"  [patch:nvtx] patched: {rel}")
        n += 1
    return n


def patch_dgl() -> int:
    p = PURELIB / "dgl" / "graphbolt" / "__init__.py"
    if not p.exists():
        print("  [patch:dgl] skip (dgl not installed)")
        return 0
    s = p.read_text()
    if DGL_MARKER in s:
        print("  [patch:dgl] already patched")
        return 0
    if DGL_OLD not in s:
        print("  [patch:dgl] skip (loader call not found - newer dgl?)")
        return 0
    p.write_text(s.replace(DGL_OLD, DGL_NEW, 1))
    print("  [patch:dgl] patched: graphbolt load is now best-effort")
    return 1


if __name__ == "__main__":
    print(f"Applying RFdiffusion CPU patches in {PURELIB} …")
    patch_nvtx()
    patch_dgl()
    print("Done.")
