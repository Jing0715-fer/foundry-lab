// GET /api/tools/file?path=<absolute path under outputs/>
//   Serves REAL run artifacts (PDB/FASTA/JSON/text) from the outputs tree.
//   Security: the resolved path must live under <cwd>/outputs/ (engines and
//   native tools write there). Used by the canvas inspector's output viewer
//   for workflow-node runs (which don't create ToolJob rows).

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { isAbsolute, normalize, resolve, sep } from "path";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    return NextResponse.json({ error: "Missing 'path'" }, { status: 400 });
  }
  const outputsRoot = resolve(process.cwd(), "outputs");
  const normalized = normalize(filePath);
  const abs = isAbsolute(normalized) ? resolve(normalized) : resolve(outputsRoot, normalized);
  if (abs !== outputsRoot && !abs.startsWith(outputsRoot + sep)) {
    return NextResponse.json(
      { error: "Path must be inside the outputs directory." },
      { status: 403 },
    );
  }
  let content: string;
  try {
    content = await fs.readFile(abs, "utf-8");
  } catch {
    return NextResponse.json(
      { error: "File not found on disk.", path: abs },
      { status: 404 },
    );
  }
  const fileName = normalized.split("/").pop() ?? "output";
  const ext = fileName.split(".").pop()?.toLowerCase();
  const contentType =
    ext === "pdb"
      ? "chemical/x-pdb"
      : ext === "fasta" || ext === "fa"
        ? "text/fasta"
        : ext === "json"
          ? "application/json"
          : "text/plain";
  return new Response(content, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${fileName}"`,
    },
  });
}
