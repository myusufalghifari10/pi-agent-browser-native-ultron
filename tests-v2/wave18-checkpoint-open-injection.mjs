// wave18 (W18): the checkpoint restore open-injection gap.
//
// Real code path (read end to end before writing this file):
//   compileCheckpointRun (input-modes/checkpoint.js) compiles a restore to the batch
//     [["state","load",tmp],["get","url"],["snapshot"]] -- it names NO `open` row, because the
//     restore origin is only knowable after decryption.
//   The pre-spawn gate in orchestration/browser-run/prepare.js (~line 514) decrypts the snapshot,
//   reads `decrypted.metadata`, picks `restoreTarget = metadata.url ?? metadata.origin`, and only
//     when that string is non-empty does it call buildRestoreBatchRows() to splice
//     `["open", restoreTarget]` between the load and the health-check snapshot.
//   metadata.url / metadata.origin are written at SAVE time by finalizeCheckpointSave ->
//     saveCheckpoint({origin: plan.origin}), i.e. they exist ONLY when the caller passed
//     `checkpoint.url`. So a save without url metadata stored no restore target, the gate injected
//     no `open` row, and the restored session never opened its origin: the snapshot health check
//     ran against no page of the restored origin (wave4's W-V1 guard makes that fail, which is why
//     cross-session continuation stayed broken rather than silently wrong).
//
// Fix, inside the assigned file only (prepare.js and checkpoint-store.js are not mine to edit):
//   1. deriveCheckpointOriginFromState reads the origin out of the upstream storage-state the save
//      path already holds in memory (origins[].origin). That is not a guess: it is the snapshot's
//      own origin. It returns undefined when the state names zero or several origins, so the scheme
//      is never invented from a cookie domain and one of many origins is never picked arbitrarily.
//      finalizeCheckpointSave stores that derived origin, so the gate's existing condition is now
//      satisfied by real metadata and the `open` row is injected.
//   2. A snapshot that genuinely has no url/origin metadata (saved before this fix, or a state
//      with no unambiguous origin) can never get its origin opened. That is now an explicit,
//      self-explaining failure naming the missing metadata, instead of a snapshot that quietly
//      proves nothing.
//
// Run: node tests-v2/wave18-checkpoint-open-injection.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRestoreBatchRows, decryptCheckpoint, getCheckpointDirectory, readCheckpoint, saveCheckpoint } from "../dist/extensions/agent-browser/lib/vault/checkpoint-store.js";
import { compileCheckpointRun, deriveCheckpointOriginFromState, finalizeCheckpointRun, normalizeCheckpointInput } from "../dist/extensions/agent-browser/lib/input-modes/checkpoint.js";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "wave18-checkpoint-open-"));
process.env.PI_AGENT_BROWSER_VAULT_DIR = join(TEST_ROOT, "vault");
const ENV = { PI_AGENT_BROWSER_VAULT_DIR: process.env.PI_AGENT_BROWSER_VAULT_DIR, HOME: TEST_ROOT };
mkdirSync(getCheckpointDirectory(ENV), { mode: 0o700, recursive: true });

const stateBytesFor = (origins, cookies = []) => Buffer.from(JSON.stringify({ cookies, origins }), "utf8");
const SINGLE_ORIGIN_STATE = stateBytesFor(
    [{ origin: "https://layar.example", localStorage: [["token", "wave18"]] }],
    [{ name: "sess", value: "wave18-cookie", domain: "layar.example", path: "/", httpOnly: true }],
);

// ---------------------------------------------------------------------------
// 1. origin derivation from the snapshot's own storage-state: never a guess.
// ---------------------------------------------------------------------------
{
    assert.equal(deriveCheckpointOriginFromState(SINGLE_ORIGIN_STATE), "https://layar.example", "the single origins[].origin is read as-is");
    assert.equal(deriveCheckpointOriginFromState(stateBytesFor([{ origin: "https://a.example" }, { origin: "https://a.example" }])), "https://a.example", "duplicate entries of one origin are still unambiguous");
    assert.equal(deriveCheckpointOriginFromState(stateBytesFor([{ origin: "https://A.Example/path" }])), "https://a.example", "the origin is normalized");
    // Ambiguity and absence are both "no origin" -- picking one would be a lie.
    assert.equal(deriveCheckpointOriginFromState(stateBytesFor([{ origin: "https://a.example" }, { origin: "https://b.example" }])), undefined, "two origins: no arbitrary pick");
    assert.equal(deriveCheckpointOriginFromState(stateBytesFor([])), undefined, "cookie-only state has no origin (the scheme must never be invented from a cookie domain)");
    assert.equal(deriveCheckpointOriginFromState(stateBytesFor([], [{ name: "s", domain: "layar.example" }])), undefined, "a bare cookie domain is not an origin");
    assert.equal(deriveCheckpointOriginFromState(stateBytesFor([{ origin: "file:///tmp" }])), undefined, "non-http(s) origins are ignored");
    assert.equal(deriveCheckpointOriginFromState(stateBytesFor([{ localStorage: [] }])), undefined, "an origin entry without an origin string is ignored");
    assert.equal(deriveCheckpointOriginFromState(Buffer.from("not json", "utf8")), undefined, "unparsable state yields no origin, never a throw");
    assert.equal(deriveCheckpointOriginFromState(undefined), undefined);
    assert.equal(deriveCheckpointOriginFromState(Buffer.from(JSON.stringify({ cookies: "nope" }), "utf8")), undefined, "a malformed origins field yields no origin");
}

// ---------------------------------------------------------------------------
// 2. end to end: a save WITHOUT url metadata now stores the derived origin, so the pre-spawn gate
//    condition (metadata.url ?? metadata.origin) is satisfied and the `open` row is injected.
// ---------------------------------------------------------------------------
const SAVED_WITHOUT_URL = await (async () => {
    const plan = normalizeCheckpointInput({ action: "save", label: "no url given" });
    assert.equal(plan.error, undefined, "save without url is a valid plan");
    assert.equal(plan.value.origin, undefined, "the caller gave no url, so the plan carries no origin");
    const compiled = compileCheckpointRun(plan.value);
    writeFileSync(compiled.tempPath, SINGLE_ORIGIN_STATE, { mode: 0o600 });
    const run = await finalizeCheckpointRun({
        compiledCheckpoint: compiled,
        presentation: { content: [{ type: "text", text: "{}" }], summary: "upstream completed" },
        presentationEnvelope: { success: true },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(run.succeeded, true, "the save succeeded");
    assert.equal(existsSync(compiled.tempPath), false, "the decrypted temp state file is deleted");

    const read = readCheckpoint(run.checkpoint.id, { env: ENV });
    assert.equal(read.status, "ok");
    assert.equal(read.envelope.metadata.url, undefined, "no url metadata was invented");
    assert.equal(read.envelope.metadata.origin, "https://layar.example", "the origin came from the snapshot's own storage-state");

    // Reproduce the pre-spawn gate exactly: restoreTarget = metadata.url ?? metadata.origin.
    const metadata = decryptCheckpoint(run.checkpoint.id, { env: ENV }).metadata ?? {};
    const restoreTarget = typeof metadata.url === "string" && metadata.url.length > 0 ? metadata.url : typeof metadata.origin === "string" && metadata.origin.length > 0 ? metadata.origin : undefined;
    const restoreCompile = compileCheckpointRun({ action: "restore", id: run.checkpoint.id });
    assert.equal(JSON.parse(restoreCompile.stdin).some((row) => row[0] === "open"), false, "the compiler itself names no open row (the origin is only known after decryption)");
    const injected = buildRestoreBatchRows(JSON.parse(restoreCompile.stdin), restoreTarget);
    assert.ok(Array.isArray(injected), "the gate injects rows for a url-less save");
    assert.deepEqual(injected[1], ["open", "https://layar.example"], "the restored session is actually OPENED at its origin");
    assert.deepEqual(injected[2], ["get", "url"], "get url still follows the injected open");
    assert.deepEqual(injected[3], ["snapshot"], "the health-check snapshot still runs last");
    return run.checkpoint.id;
})();

// An explicit url still wins over the derived one (the caller's word is not overridden).
{
    const compiled = compileCheckpointRun({ action: "save", origin: "https://explicit.example" });
    writeFileSync(compiled.tempPath, SINGLE_ORIGIN_STATE, { mode: 0o600 });
    const run = await finalizeCheckpointRun({
        compiledCheckpoint: compiled,
        presentation: { content: [], summary: "" },
        presentationEnvelope: { success: true },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(readCheckpoint(run.checkpoint.id, { env: ENV }).envelope.metadata.origin, "https://explicit.example", "an explicit url origin is stored as given");
}

// A state with two origins stores no origin rather than picking one.
{
    const compiled = compileCheckpointRun({ action: "save" });
    writeFileSync(compiled.tempPath, stateBytesFor([{ origin: "https://a.example" }, { origin: "https://b.example" }]), { mode: 0o600 });
    const run = await finalizeCheckpointRun({
        compiledCheckpoint: compiled,
        presentation: { content: [], summary: "" },
        presentationEnvelope: { success: true },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(readCheckpoint(run.checkpoint.id, { env: ENV }).envelope.metadata.origin, undefined, "an ambiguous state stores no origin");
    const text = run.presentation.content[0].text;
    assert.ok(/url/i.test(text), "the save result tells the caller that the url/origin metadata is missing");
    assert.ok(/derive|cannot|unable|no origin|without/i.test(text), "the save result explains that the origin could not be derived");
}

// ---------------------------------------------------------------------------
// 3. a snapshot with no url/origin metadata cannot be opened: the restore must SAY so.
// ---------------------------------------------------------------------------
{
    const stored = saveCheckpoint({ env: ENV, label: "legacy, no origin metadata", stateBytes: SINGLE_ORIGIN_STATE });
    assert.equal(stored.status, "ok");
    assert.equal(readCheckpoint(stored.id, { env: ENV }).envelope.metadata.origin, undefined, "this snapshot really has no url/origin metadata");

    // Even a perfectly green health check proves nothing when no origin was ever opened.
    const compiled = compileCheckpointRun({ action: "restore", id: stored.id });
    writeFileSync(compiled.tempPath, SINGLE_ORIGIN_STATE, { mode: 0o600 });
    const run = await finalizeCheckpointRun({
        compiledCheckpoint: compiled,
        presentation: {
            batchSteps: [
                { command: ["state", "load", compiled.tempPath], success: true, result: { loaded: true } },
                { command: ["snapshot"], success: true, result: { refs: {} } },
            ],
            content: [],
            summary: "",
        },
        presentationEnvelope: { success: true },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(run.succeeded, false, "a url-less snapshot cannot claim a restored login");
    assert.equal(run.checkpoint.reauthRequired, true, "it is reported as reauth-required");
    assert.equal(run.checkpoint.loginEvidence, undefined, "no page-rendered evidence is claimed");
    assert.equal(run.checkpoint.originMetadataMissing, true, "the details name the missing metadata");
    const text = run.presentation.content[0].text;
    assert.ok(/url/i.test(text), "the failure names the missing url metadata");
    assert.ok(/origin/i.test(text), "the failure names the missing origin metadata");
    assert.ok(/re-save|save/i.test(text), "the failure says what to do about it");
    assert.equal(run.presentation.failureCategory, "checkpoint-reauth-required");
    assert.equal(run.presentationEnvelope.success, false);

    // A snapshot that DOES carry an origin keeps the honest healthy-restore behaviour.
    const healthy = compileCheckpointRun({ action: "restore", id: SAVED_WITHOUT_URL });
    writeFileSync(healthy.tempPath, SINGLE_ORIGIN_STATE, { mode: 0o600 });
    const healthyRun = await finalizeCheckpointRun({
        compiledCheckpoint: healthy,
        presentation: {
            batchSteps: [
                { command: ["state", "load", healthy.tempPath], success: true, result: { loaded: true } },
                { command: ["open", "https://layar.example"], success: true, result: { url: "https://layar.example" } },
                { command: ["snapshot"], success: true, result: { refs: {} } },
            ],
            content: [],
            summary: "",
        },
        presentationEnvelope: { success: true },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(healthyRun.succeeded, true, "the fixed path restores cleanly");
    assert.equal(healthyRun.checkpoint.loginEvidence, "page rendered");
    assert.equal(healthyRun.checkpoint.originMetadataMissing, undefined, "a snapshot with an origin is not flagged");
}

rmSync(TEST_ROOT, { recursive: true, force: true });
console.log("wave18-checkpoint-open-injection: all assertions passed (url-less save derives the origin from the snapshot's own storage-state so the pre-spawn gate injects the `open` row; ambiguous/absent origin is never guessed; a snapshot with no url/origin metadata fails explicitly naming it)");
