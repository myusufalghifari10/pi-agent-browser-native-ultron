// wave19: the checkpoint `open <origin>` row actually reaches the process.
//
// This is a wave-4 bug (live-sweep W-V1), not a wave-18 regression, and it is the exact
// failure shape this project exists to prevent: the restore reported "Login evidence: page
// rendered" while grading the profile's START PAGE, because no open row ever ran.
//
// The dead end, confirmed by reading the whole chain rather than guessing:
//   prepare.js:538  toolStdin is destructured out of normalizeRunInput - a frozen string
//   prepare.js:595  preparedArgs = prepareAgentBrowserArgs(..., runtimeToolStdin, ...)
//   prepare.js:625  the gate runs and rewrites compiled.stdin
//   prepare.js:1224 the spawn reads preparedArgs.stdin ?? runtimeToolStdin
// The gate runs AFTER 595 and mutated an object nothing downstream reads. The row was built
// correctly and thrown away.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const store = await import(join(repo, "dist/extensions/agent-browser/lib/vault/checkpoint-store.js"));
const prepareSource = readFileSync(join(repo, "dist/extensions/agent-browser/lib/orchestration/browser-run/prepare.js"), "utf8");
const { rewriteCheckpointRestoreStdin } = await import(join(repo, "dist/extensions/agent-browser/lib/orchestration/browser-run/prepare.js"));

let failures = 0;
function group(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        failures += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

const ORIGINAL = JSON.stringify([["state", "load", "/tmp/piab-ckpt.state"], ["get", "url"], ["snapshot"]]);
const TARGET = "http://127.0.0.1:8741";

group("the rewritten stdin is a real batch with the open row spliced in", () => {
    const rewritten = rewriteCheckpointRestoreStdin(ORIGINAL, TARGET);
    assert.equal(typeof rewritten, "string", "a string must come back, because the spawn takes a string");
    const rows = JSON.parse(rewritten);
    assert.equal(rows.length, 4, "three rows become four; the open row is the point of the whole gate");
    assert.deepEqual(rows[0].slice(0, 2), ["state", "load"], "state load stays first - the state must load before navigating");
    assert.deepEqual(rows[1], ["open", TARGET], "the open row must name the saved origin exactly");
    assert.deepEqual(rows[2], ["get", "url"], "get url must run AFTER the open, or it reads the pre-open page");
    assert.deepEqual(rows[3], ["snapshot"], "the health-check snapshot runs last, so it grades the origin");
    assert.notEqual(rewritten, ORIGINAL, "the output must actually differ from the input, or nothing was injected");
});

group("the helper is total: every bad input returns undefined instead of throwing", () => {
    assert.equal(rewriteCheckpointRestoreStdin(undefined, TARGET), undefined);
    assert.equal(rewriteCheckpointRestoreStdin(ORIGINAL, undefined), undefined);
    assert.equal(rewriteCheckpointRestoreStdin(ORIGINAL, ""), undefined);
    assert.equal(rewriteCheckpointRestoreStdin(ORIGINAL, 42), undefined, "a non-string target is refused, not coerced");
    assert.equal(rewriteCheckpointRestoreStdin("not json at all", TARGET), undefined, "unparsable stdin is left untouched");
    assert.equal(rewriteCheckpointRestoreStdin(JSON.stringify([["get", "url"]]), TARGET), undefined, "no state load row means there is nothing to splice after");
    assert.equal(rewriteCheckpointRestoreStdin(JSON.stringify({ not: "an array" }), TARGET), undefined);
});

group("it agrees with the helper the gate already used", () => {
    // If these ever diverge, the gate and this test would be measuring different things.
    const viaOld = JSON.stringify(store.buildRestoreBatchRows(JSON.parse(ORIGINAL), TARGET));
    assert.equal(rewriteCheckpointRestoreStdin(ORIGINAL, TARGET), viaOld, "the rewrite must be exactly buildRestoreBatchRows, not a second implementation of it");
});

group("the gate uses the helper instead of inlining its own try/catch", () => {
    assert.match(prepareSource, /rewriteCheckpointRestoreStdin\(/, "the gate must go through the tested helper");
    assert.ok(!/const rows = buildRestoreBatchRows\(JSON\.parse\(compiled\.stdin\)/.test(prepareSource), "the old inline path must be gone, or it is still the one that runs");
});

group("THE ACTUAL FIX: the gate's result is pushed into the strings the spawn reads", () => {
    // This is the assertion that would have caught the bug. The old code mutated
    // compiled.stdin at line ~525 while the spawn reads preparedArgs.stdin ?? runtimeToolStdin
    // at line ~1224 - two different values, both frozen before the gate ran.
    assert.match(prepareSource, /if \(checkpointGateResult\)\s*\n\s*return \{ kind: "early-result", result: checkpointGateResult \};/,
        "the early-result return must stay where it is");
    assert.match(prepareSource, /restoreStdin[^\n]*\n?[\s\S]{0,400}?runtimeToolStdin = restoreStdin/,
        "the rewritten stdin must be assigned back to runtimeToolStdin, which the spawn falls back to");
    assert.match(prepareSource, /preparedArgs\.stdin = restoreStdin/,
        "and to preparedArgs.stdin, which the spawn prefers - assigning only one of the two is the same bug again");
});

group("the gate reports its rewrite through a sink, not by mutating a dead object", () => {
    assert.match(prepareSource, /restoreStdinSink/, "the gate needs a channel to the caller");
    assert.match(prepareSource, /restoreStdinSink\.stdin = /, "and it must write the new stdin into it");
    assert.match(prepareSource, /tryCheckpointPreSpawnGate\(\{[^}]*restoreStdinSink/s,
        "the sink must be passed into the gate call");
});

if (failures > 0) {
    console.log(`\nwave19-checkpoint-open: ${failures} group(s) FAILED`);
    process.exit(1);
}
console.log("\nwave19-checkpoint-open: all assertions passed");
