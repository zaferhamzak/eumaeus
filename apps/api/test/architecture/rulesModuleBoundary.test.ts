import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This phase's §10 is non-negotiable: "Keep the Rule Engine separate from
 * modules/jev/, modules/destinations/. The Rule Engine must not call the Jev API
 * itself. Do not create circular dependencies." Enforced structurally, mirroring
 * test/architecture/jevModuleBoundary.test.ts's approach — a static check of the
 * import graph, not a runtime assertion that happens not to have been exercised.
 */
const RULES_MODULE_DIR = join(import.meta.dirname, "../../src/modules/rules");

const FORBIDDEN_IMPORT_SUBSTRINGS = [
  "modules/jev", // zero dependency on Jev, not just "doesn't call the HTTP client" — see knownFields.ts's doc comment
  "/destination",
  "/action",
  "/webhook",
  "/forward",
  "/archive",
  "/reply",
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

describe("architecture guard — modules/rules/* does not depend on Jev or any action/destination module", () => {
  const files = listTsFiles(RULES_MODULE_DIR);

  it("found the rules module's source files (sanity check that this test isn't vacuously passing)", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file.replace(RULES_MODULE_DIR, "modules/rules")} has no forbidden imports`, () => {
      const source = readFileSync(file, "utf-8");
      const importPaths = extractImportPaths(source);
      for (const importPath of importPaths) {
        for (const forbidden of FORBIDDEN_IMPORT_SUBSTRINGS) {
          expect(
            importPath.toLowerCase(),
            `${file} imports "${importPath}", which looks like a Jev/action/destination dependency`,
          ).not.toContain(forbidden);
        }
      }
    });
  }

  it("modules/jev/* does not import modules/rules/* either (no circular dependency)", () => {
    const jevDir = join(import.meta.dirname, "../../src/modules/jev");
    const jevFiles = listTsFiles(jevDir);
    for (const file of jevFiles) {
      const source = readFileSync(file, "utf-8");
      const importPaths = extractImportPaths(source);
      for (const importPath of importPaths) {
        expect(importPath.toLowerCase(), `${file} imports "${importPath}"`).not.toContain("modules/rules");
      }
    }
  });
});
