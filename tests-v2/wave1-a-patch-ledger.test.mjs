/**
 * Purpose: Offline assertions for the wave1-A Patch Integrity Ledger (FINAL-DESIGN.md §1 pillar C reshape, §5 step 1).
 * Responsibilities: Pin the manifest schema, the PL1 self-coverage, the pre-spawn gate ordering in process.js, and the runtime verdict.
 * Scope: Pure filesystem + module assertions; never spawns agent-browser and never tampers the real tree.
 * Usage: node tests-v2/wave1-a-patch-ledger.test.mjs (exit 0 = all assertions hold).
 * Invariants/Assumptions: Run from the package root checkout; the real manifest must stay clean (tamper tests run on /tmp copies only).
 * Related: patches/patches.manifest.json, dist/extensions/agent-browser/lib/patches-ledger.js, scripts/verify-patches.mjs, PATCHES.md.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPatchLedger } from "../dist/extensions/agent-browser/lib/patches-ledger.js";

const packageRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const manifestPath = join(packageRoot, "patches", "patches.manifest.json");

// 1. Manifest schema: unique ids, no phantom P4, every entry fully populated.
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.version, 1);
const ids = manifest.entries.map((entry) => entry.id);
assert.equal(new Set(ids).size, ids.length, "entry ids must be unique");
assert.ok(!ids.includes("P4"), "there is no P4 in the patch numbering");
// 12 -> 14 in wave10+11 (P-W10-scrim added, P-W11-batch added) -> 13 after the wave-10
// scrim entry was REVERTED -> 16 in wave14 (P-W14-cdp-mode and P-W14-cdp-host pin two new
// local files) -> 17 in wave15 (P-W15-unknown-flag pins argv-grammar.js) -> 18 in wave16
// (P-W16-act-mode pins the new act.js).
// The count is a deliberate tripwire: it must be able to go down as well as
// up, and any change here should be a conscious decision, never a silent drift of the set.
assert.equal(manifest.entries.length, 21, "20 divergent files + PL1 self-coverage");
for (const entry of manifest.entries) {
    assert.ok(Array.isArray(entry.files) && entry.files.length > 0, `${entry.id} lists files`);
    assert.ok(Array.isArray(entry.patches) && entry.patches.length > 0, `${entry.id} lists patch ids`);
    assert.equal(typeof entry.upstreamDefect, "string", `${entry.id} states its upstream defect`);
    for (const file of entry.files) {
        assert.match(entry.sha256[file], /^[0-9a-f]{64}$/, `${file} carries a sha256 hex pin`);
    }
}

// 2. PL1 covers the ledger itself plus the spawn-hook file, and nothing else is self-referential.
const pl1 = manifest.entries.find((entry) => entry.id === "PL1");
assert.deepEqual([...pl1.files].sort(), [
    "dist/extensions/agent-browser/lib/patches-ledger.js",
    "dist/extensions/agent-browser/lib/process.js",
].sort());

// 3. process.js wires the ledger gate before any spawn of agent-browser.
const processSource = await readFile(join(packageRoot, "dist/extensions/agent-browser/lib/process.js"), "utf8");
const gateAt = processSource.indexOf("getPatchLedgerSpawnError()");
const spawnAt = processSource.indexOf("spawnBrowser(");
const requiredGuidance = "Local patches drifted from patches/patches.manifest.json — re-apply per PATCHES.md before continuing. No silent fallback.";
assert.ok(gateAt > -1, "pre-spawn ledger gate exists in process.js");
assert.ok(spawnAt > -1, "spawn site still present in process.js");
assert.ok(gateAt < spawnAt, "ledger gate must run before the spawn");
assert.ok(processSource.includes(requiredGuidance), "refusal message carries the exact guidance");

// 4. Runtime verdict on the clean tree: ok, not skipped, everything accounted for.
const result = await verifyPatchLedger();
assert.deepEqual(result, { ok: true, skipped: false, drifted: [], missing: [], manifestPath });

// 5. Manifest + hashes are cached in module scope: second call returns the identical verdict.
assert.equal(await verifyPatchLedger(), result);

console.log("wave1-a-patch-ledger: all assertions passed (21 entries, gate before spawn, verdict cached)");
