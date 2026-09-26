#!/usr/bin/env python3
"""[mock-cluster shim helper] Generic engine-payload builder.

Usage: generic_payload.py <toolKey> <workdir> [key=value] …

Builds {"params": {...non-empty…, "_tool": toolKey}, "workdir": workdir}.
Numeric values are coerced to ints; "true"/"false" to bools.
"""
import json
import sys


def coerce(v: str):
    if v.lower() in ("true", "false"):
        return v.lower() == "true"
    try:
        return int(v)
    except ValueError:
        return v


def main():
    tool, workdir = sys.argv[1], sys.argv[2]
    params = {"_tool": tool}
    for kv in sys.argv[3:]:
        if not kv or "=" not in kv:
            continue
        key, val = kv.split("=", 1)
        if val == "":
            continue
        params[key] = coerce(val)
    print(json.dumps({"params": params, "workdir": workdir}))


if __name__ == "__main__":
    main()
