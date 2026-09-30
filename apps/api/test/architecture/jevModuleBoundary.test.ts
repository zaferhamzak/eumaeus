import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This phase's §14 is non-negotiable: "The Jev module must NOT import
 * destination/action/webhook/forward/archive/reply or any equivalent
 * action-execution module." This test enforces that structurally rather than by
 * convention — a future PR that accidentally adds such an import fails this test,
 * not just a code review.
 *
 * Deliberately a static source-text check, not a runtime mock/spy: the guarantee
 * we actually want ("this code CANNOT reach an action-execution module") is a
 * property of the import graph, and checking the graph directly is stronger than
 * checking that a particular test run happened not to call one.
 */
const JEV_MODULE_DIR = join(import.meta.dirname, "../../src/modules/jev");

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "/destination",
  "/action",
  "/webhook",
  "/forward",
  "/archive",
  "/reply",
  "modules/review", // Human Review escalation is deliberately the WORKER's job, not Jev's — see analyzeEmail.ts's doc comment
];

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function extractImportPaths(source: string): string[] {
  const paths: string[] = [];
  const importRegex = /import\s+(?:type\s+)?(?:[^'"]+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source))) {
    paths.push(match[1] as string);
  }
  return paths;
}

describe("architecture guard — modules/jev/* has zero action/destination dependencies", () => {
  const files = listTsFiles(JEV_MODULE_DIR);

  it("found the jev module's source files (sanity check that this test isn't vacuously passing)", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file.replace(JEV_MODULE_DIR, "modules/jev")} does not import any action/destination-execution module`, () => {
      const source = readFileSync(file, "utf-8");
      const importPaths = extractImportPaths(source);
      for (const importPath of importPaths) {
        for (const forbidden of FORBIDDEN_IMPORT_SUBSTRINGS) {
          expect(importPath.toLowerCase(), `${file} imports "${importPath}", which looks like an action/destination dependency`).not.toContain(
            forbidden,
          );
        }
      }
    });
  }
});
