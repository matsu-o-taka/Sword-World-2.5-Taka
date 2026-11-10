// Sword World 2.5: Taka Edition - production single-identity test
//
// The system runs under a single identity ("sw25-taka"). Since v0.18.1 there
// is no migration path from the retired "sword-world-25" identity, and no
// production code may reference it as a flag scope, world setting namespace,
// socket channel, or path segment.
//
// This test scans every production ES module (module/**/*.mjs and sw25.mjs)
// and asserts none of them mention the retired identity.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RETIRED_ID = "sword-world-25";
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function listMjsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listMjsFiles(full));
    else if (entry.name.endsWith(".mjs")) files.push(full);
  }
  return files;
}

const productionFiles = [
  ...await listMjsFiles(path.join(rootDir, "module")),
  path.join(rootDir, "sw25.mjs")
];

assert.ok(
  productionFiles.length > 20,
  `expected to scan the real production modules, found ${productionFiles.length}`
);

for (const file of productionFiles) {
  const source = await readFile(file, "utf8");
  assert.ok(
    !source.includes(RETIRED_ID),
    `${path.relative(rootDir, file)} must not reference the retired identity "${RETIRED_ID}"`
  );
}

console.log(`Production identity test passed: ${productionFiles.length} production files scanned, no reference to "${RETIRED_ID}".`);
