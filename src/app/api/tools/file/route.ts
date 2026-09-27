// GET /api/tools/file?path=<absolute path under outputs/>
//   Serves REAL run artifacts (PDB/FASTA/JSON/CSV/images/text) from the
//   outputs tree. Security: the resolved path must live under <cwd>/outputs/
//   (engines and native tools write there). Used by the canvas inspector's
//   result tab + output viewer for workflow-node runs (which don't create
//   ToolJob rows).
//
// Query params:
//   path — the file to serve (absolute, or relative to outputs/)
//   meta — when "1", returns a JSON stat envelope { name, ext, size, modified }
//          instead of the file content. The inline result panel uses this to
//          render file sizes next to every output file.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { isAbsolute, normalize, resolve, sep } from "path";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

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

  const fileName = normalized.split("/").pop() ?? "output";
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";

  // Metadata envelope — consumed by the inline result panel for file sizes.
  if (url.searchParams.get("meta") === "1") {
    try {
      const stat = await fs.stat(abs);
      return NextResponse.json({
        path: abs,
        name: fileName,
        ext,
        size: stat.size,
        modified: stat.mtimeMs,
      });
    } catch {
      return NextResponse.json(
        { error: "File not found on disk.", path: abs },
        { status: 404 },
      );
    }
  }

  // Binary images are streamed as raw bytes with a proper image Content-Type
  // so <img src> previews work; everything else is utf-8 text.
  const imageType = IMAGE_TYPES[ext];
  if (imageType && ext !== "svg") {
    let buf: Buffer;
    try {
      buf = await fs.readFile(abs);
    } catch {
      return NextResponse.json(
        { error: "File not found on disk.", path: abs },
        { status: 404 },
      );
    }
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": imageType,
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
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
  const contentType =
    ext === "pdb"
      ? "chemical/x-pdb"
      : ext === "fasta" || ext === "fa"
        ? "text/fasta"
        : ext === "json"
          ? "application/json"
          : ext === "csv"
            ? "text/csv"
            : ext === "svg"
              ? "image/svg+xml"
              : "text/plain";
  return new Response(content, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
