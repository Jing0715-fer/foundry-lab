// Server-side AlphaFold helper — sequence materialization for the cluster
// staging lane. (The tutorial command preview builder lives in tools.ts so
// client components can import it without pulling in node:fs.)
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseFastaInput } from "./tools";

/** Materialize a pasted FASTA sequence into a local file so the cluster
 *  staging lane uploads it like any other path input. Mutates `params`:
 *  sets params.fasta_path to the written file. Returns the FASTA name, or
 *  null when nothing needed writing. */
export function materializeSequence(
  params: Record<string, unknown>,
  workDir: string,
): string | null {
  const fastaPath = typeof params.fasta_path === "string" ? params.fasta_path.trim() : "";
  const featureFile = typeof params.feature_file === "string" ? params.feature_file.trim() : "";
  if (fastaPath || featureFile) return null;
  const sequence = typeof params.sequence === "string" ? params.sequence : "";
  const parsed = parseFastaInput(sequence);
  if (!parsed) return null;
  mkdirSync(join(workDir, "input"), { recursive: true });
  const local = join(workDir, "input", `${parsed.name}.fa`);
  writeFileSync(local, `>${parsed.name}\n${parsed.seq}\n`, "utf-8");
  params.fasta_path = local;
  return parsed.name;
}
