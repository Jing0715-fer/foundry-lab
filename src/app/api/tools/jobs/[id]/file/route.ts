// GET /api/tools/jobs/[id]/file
//   - If `?path=<file>` is NOT provided → return the job's real `outputFiles`
//     list as JSON so clients can discover what's available.
//   - If `?path=<file>` IS provided → stream the REAL file from disk (the
//     path must be one of the job's recorded output files, or live inside
//     the job's workDir). PDB → chemical/x-pdb, FASTA → text/fasta,
//     everything else text/plain.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { promises as fs } from "fs";
import { isAbsolute, join, normalize, resolve, sep } from "path";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await db.toolJob.findUnique({ where: { id } });
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  let outputFiles: string[] = [];
  try {
    outputFiles = job.outputFiles ? JSON.parse(job.outputFiles) : [];
  } catch {
    /* ignore */
  }

  const url = new URL(_request.url);
  const filePath = url.searchParams.get("path");

  if (!filePath) {
    return NextResponse.json({ files: outputFiles });
  }

  // Security: the requested path must be an exact recorded output file, or
  // resolve inside this job's workDir (outputs/<tool>/<jobId>/…).
  const outputsRoot = resolve(process.cwd(), "outputs");
  const workDir = join(outputsRoot, job.tool, job.id);
  const normalized = normalize(filePath);
  const isRecorded = outputFiles.includes(normalized) || outputFiles.includes(resolve(normalized));
  const resolvedAbs = isAbsolute(normalized) ? resolve(normalized) : resolve(join(workDir, normalized));
  const inWorkDir = resolvedAbs === workDir || resolvedAbs.startsWith(workDir + sep);
  if (!isRecorded && !inWorkDir) {
    return NextResponse.json(
      { error: "Path is outside this job's outputs." },
      { status: 403 },
    );
  }

  let content: string;
  try {
    content = await fs.readFile(resolvedAbs, "utf-8");
  } catch {
    return NextResponse.json(
      {
        error: "File not found on disk.",
        hint:
          "This job has no persisted artifact for that path. Real engines " +
          "write files at run time — re-run the job to regenerate outputs.",
      },
      { status: 404 },
    );
  }

  const fileName = normalized.split("/").pop() ?? "output";
  const ext = fileName.split(".").pop()?.toLowerCase();
  const contentType =
    ext === "pdb"
      ? "chemical/x-pdb"
      : ext === "fasta"
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
