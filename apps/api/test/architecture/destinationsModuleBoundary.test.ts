import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This phase's explicit instruction: "destinations modülü analysis, rule
 * evaluation, IMAP provider implementation details, review persistence internals
 * ile gereksiz şekilde tightly coupled olmamalı... archiveExecutor.ts provider
 * boundary'ye bağımlı olan tek executor olmalı." Enforced structurally, mirroring
 * test/architecture/{jev,rules}ModuleBoundary.test.ts exactly.
 */
const DESTINATIONS_MODULE_DIR = join(import.meta.dirname, "../../src/modules/destinations");

const FORBIDDEN_IMPORT_SUBSTRINGS = ["modules/jev", "modules/rules"];

/**
 * The only files allowed to talk IMAP. Phase 5A started with archiveExecutor.ts
 * alone; Phase 15 moved the shared connection setup into imapSession.ts and
 * added the flag executor and archive undo, which act on the same message
 * over the same connection. Everything else in the module stays IMAP-free.
 */
const IMAP_ALLOWED = ["executors/imapSession.ts", "executors/archiveExecutor.ts", "executors/flagExecutor.ts", "executors/archiveUndo.ts"];

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

describe("architecture guard — modules/destinations/*", () => {
  const files = listTsFiles(DESTINATIONS_MODULE_DIR);

  it("found the destinations module's source files (sanity check that this test isn't vacuously passing)", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of files) {
    const relative = file.replace(DESTINATIONS_MODULE_DIR, "modules/destinations");
    const imapAllowed = IMAP_ALLOWED.some((allowed) => relative.endsWith(allowed));

    it(`${relative} does not import modules/jev or modules/rules`, () => {
      const source = readFileSync(file, "utf-8");
      const importPaths = extractImportPaths(source);
      for (const importPath of importPaths) {
        for (const forbidden of FORBIDDEN_IMPORT_SUBSTRINGS) {
          expect(importPath.toLowerCase(), `${file} imports "${importPath}"`).not.toContain(forbidden);
        }
      }
    });

    if (!imapAllowed) {
      it(`${relative} does NOT import modules/mail-providers/imap`, () => {
        const importPaths = extractImportPaths(readFileSync(file, "utf-8"));
        const importsImap = importPaths.some((p) => p.toLowerCase().includes("mail-providers/imap"));
        expect(importsImap, `${file} imports an IMAP provider module`).toBe(false);
      });
    }
  }

  it("the IMAP boundary is real: imapSession.ts does use the provider module (this guard isn't vacuous)", () => {
    const session = files.find((f) => f.endsWith("executors/imapSession.ts"));
    expect(session).toBeDefined();
    expect(extractImportPaths(readFileSync(session!, "utf-8")).some((p) => p.includes("mail-providers/imap"))).toBe(true);
  });

  it("modules/jev/* does not import modules/destinations/* (no circular dependency)", () => {
    const jevDir = join(import.meta.dirname, "../../src/modules/jev");
    for (const file of listTsFiles(jevDir)) {
      const importPaths = extractImportPaths(readFileSync(file, "utf-8"));
      for (const importPath of importPaths) {
        expect(importPath.toLowerCase(), `${file} imports "${importPath}"`).not.toContain("modules/destinations");
      }
    }
  });

  it("modules/rules/* does not import modules/destinations/* — rules only ever write a destinationRef string", () => {
    const rulesDir = join(import.meta.dirname, "../../src/modules/rules");
    for (const file of listTsFiles(rulesDir)) {
      const importPaths = extractImportPaths(readFileSync(file, "utf-8"));
      for (const importPath of importPaths) {
        expect(importPath.toLowerCase(), `${file} imports "${importPath}"`).not.toContain("modules/destinations");
      }
    }
  });
});
