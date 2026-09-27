#!/usr/bin/env node
/**
 * Purpose: Verify the Patch Integrity Ledger (patches/patches.manifest.json) against the current tree.
 * Responsibilities: Print per-file OK/DRIFT/MISSING vs the pinned sha256; exit 0 when every ledgered file matches, else exit 1.
 * Scope: Offline and self-contained on purpose — the verifier must not import the dist ledger module it verifies.
 * Usage: node scripts/verify-patches.mjs (after any package update, before restarting Pi).
 * Invariants/Assumptions: Runs from any cwd; manifest paths are relative to the package root; a missing or unreadable manifest fails closed (exit 1).
 * Related: PATCHES.md (patch tables), dist/extensions/agent-browser/lib/patches-ledger.js (runtime pre-spawn gate).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const manifestPath = join(packageRoot, "patches", "patches.manifest.json");

let raw;
try {
    raw = await readFile(manifestPath, "utf8");
}
catch (error) {
    console.error(`FAIL    cannot read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
let manifest;
try {
    manifest = JSON.parse(raw);
}
catch (error) {
    console.error(`FAIL    cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

let total = 0;
let failures = 0;
for (const entry of manifest.entries) {
    for (const file of entry.files) {
        total += 1;
        const label = `${file} [${entry.id}]`;
        const expected = entry.sha256[file];
        if (typeof expected !== "string") {
            console.log(`MISSING ${label} (no pinned sha256 in manifest)`);
            failures += 1;
            continue;
        }
        let actual;
        try {
            actual = createHash("sha256").update(await readFile(join(packageRoot, file))).digest("hex");
        }
        catch {
            console.log(`MISSING ${label}`);
            failures += 1;
            continue;
        }
        if (actual !== expected) {
            console.log(`DRIFT   ${label}`);
            failures += 1;
        }
        else {
            console.log(`OK      ${label}`);
        }
    }
}
if (failures === 0) {
    console.log(`\nAll ${total} ledgered files match ${manifestPath}`);
}
else {
    console.log(`\n${failures} of ${total} ledgered files diverge — re-apply per PATCHES.md before continuing. No silent fallback.`);
    process.exitCode = 1;
}
