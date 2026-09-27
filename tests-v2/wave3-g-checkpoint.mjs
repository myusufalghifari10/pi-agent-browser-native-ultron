// FINAL-DESIGN.md §1 pillar B reshape + §5 step 7 (G-lane, wave3) — offline verifier for
// origin auth-snapshots (mode `checkpoint`).
//
// Honest-fidelity invariants under test:
//   - real crypto roundtrips through the SHARED vault key machinery (store.js encryptVaultBytes /
//     decryptVaultBytes; the legacy credential vault still roundtrips after the refactor);
//   - AAD domain separation: a checkpoint envelope never decrypts as a credential payload;
//   - content-addressed storage: <sha256(ciphertext)[0:16]>.ckpt at 0600 inside a 0700 dir;
//   - TTL logic (default 30d, PI_AGENT_BROWSER_CHECKPOINT_TTL_DAYS override) + pure gate decisions
//     (expired -> force, live target session -> confirm, both category "confirmation-required");
//   - id opacity: save results and details carry ids/byte counts/labels only — no plaintext
//     storage-state substring, no ciphertext or temp path in model-visible objects;
//   - exactly-one-input-mode ladder shape (P15) with the new `checkpoint` kind;
//   - the finalizer against MOCKED pipeline results (no live browser): save finalization, restore
//     health-check grading ("page rendered" vs reauth-required), temp-file deletion, registry scrub.
//
// Run: node tests-v2/wave3-g-checkpoint.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    CHECKPOINT_DEFAULT_TTL_DAYS,
    CHECKPOINT_FIDELITY,
    CHECKPOINT_ID_PATTERN,
    CHECKPOINT_TTL_DAYS_ENV,
    createCheckpointTempPath,
    decryptCheckpoint,
    describeCheckpointEnvelope,
    getCheckpointDirectory,
    getCheckpointTtlDays,
    isCheckpointExpired,
    listCheckpoints,
    readCheckpoint,
    reapStaleCheckpointTempFiles,
    saveCheckpoint,
    secureDeleteFile,
    writeCheckpointTempFile,
} from "../dist/extensions/agent-browser/lib/vault/checkpoint-store.js";
import { decryptVaultBytes, encryptVaultBytes, readVaultEntries, writeVaultEntries } from "../dist/extensions/agent-browser/lib/vault/store.js";
import { clearVaultSecrets, getVaultSecretValues, registerVaultSecret, scrubVaultSecrets, scrubVaultSecretValues } from "../dist/extensions/agent-browser/lib/vault/secret-registry.js";
import { CHECKPOINT_SESSION_PREFIX, checkpointSessionNameForId, isCheckpointSessionName } from "../dist/extensions/agent-browser/lib/argv-grammar.js";
import { compileCheckpointRun, describeCheckpointPlan, finalizeCheckpointRun, normalizeCheckpointInput, resolveCheckpointGateDecision } from "../dist/extensions/agent-browser/lib/input-modes/checkpoint.js";
import { resolveAgentBrowserInput } from "../dist/extensions/agent-browser/lib/orchestration/input-plan.js";

// The finalizer stores with process.env (the pipeline's environment), so the whole run points the
// vault dir at a throwaway temp directory. Nothing here spawns a browser.
const TEST_ROOT = mkdtempSync(join(tmpdir(), "wave3-g-checkpoint-"));
process.env.PI_AGENT_BROWSER_VAULT_DIR = join(TEST_ROOT, "vault");
const ENV = { PI_AGENT_BROWSER_VAULT_DIR: process.env.PI_AGENT_BROWSER_VAULT_DIR, HOME: TEST_ROOT };
const PLAINTEXT_STATE = JSON.stringify({
    cookies: [{ name: "sess", value: "TOPSECRET-STATE-VALUE", domain: "layar.example", path: "/", httpOnly: true, secure: true, sameSite: "Lax", expires: 1790000000 }],
    origins: [{ origin: "https://layar.example", localStorage: [["token", "TOPSECRET-LOCALSTORAGE"]] }],
});

function freshStateBytes() {
    return Buffer.from(PLAINTEXT_STATE, "utf8");
}

function assertNoLeak(serialized, label) {
    assert.equal(serialized.includes("TOPSECRET-STATE-VALUE"), false, `${label} leaks the storage-state cookie value`);
    assert.equal(serialized.includes("TOPSECRET-LOCALSTORAGE"), false, `${label} leaks localStorage content`);
    assert.equal(serialized.includes("auth-snapshots"), false, `${label} leaks the snapshot directory path`);
    assert.equal(serialized.includes(TEST_ROOT), false, `${label} leaks a filesystem path`);
}

// ---------------------------------------------------------------------------
// 1. store.js refactor: legacy credential roundtrip + shared raw-byte crypto + AAD domain split.
// ---------------------------------------------------------------------------
{
    const written = writeVaultEntries([{ id: "vault-x", handle: "gh", type: "login", origin: "https://github.com", secret: "s3cret-value" }], { env: ENV });
    assert.equal(written.status, "ok", "legacy vault write after refactor");
    const read = readVaultEntries({ env: ENV });
    assert.equal(read.status, "ok");
    assert.equal(read.entries[0].secret, "s3cret-value", "legacy credential secret survives the encryptWithKey refactor");

    const enc = encryptVaultBytes(freshStateBytes(), { env: ENV, domain: "checkpoint" });
    assert.equal(enc.status, "ok");
    assert.equal(enc.kdfMode, "keyfile");
    const dec = decryptVaultBytes(enc.envelope, { env: ENV, domain: "checkpoint" });
    assert.equal(dec.status, "ok");
    assert.equal(dec.bytes.toString("utf8"), PLAINTEXT_STATE, "checkpoint-domain raw roundtrip");

    assert.equal(decryptVaultBytes(enc.envelope, { env: ENV, domain: "credential" }).status, "locked", "checkpoint envelope refuses the credential AAD");
    const credEnc = encryptVaultBytes(Buffer.from("credential-bytes"), { env: ENV });
    assert.equal(decryptVaultBytes(credEnc.envelope, { env: ENV, domain: "checkpoint" }).status, "locked", "credential envelope refuses the checkpoint AAD");

    const tampered = JSON.parse(JSON.stringify(enc.envelope));
    tampered.payload = `${tampered.payload.slice(0, -4)}AAAA`;
    assert.equal(decryptVaultBytes(tampered, { env: ENV, domain: "checkpoint" }).status, "locked", "tampered ciphertext is rejected (GCM tag)");
    assert.equal(encryptVaultBytes("not-a-buffer", { env: ENV }).status, "error", "encryptVaultBytes demands a Buffer");
}

// ---------------------------------------------------------------------------
// 2. checkpoint-store: content addressing, perms, metadata, TTL, list, failures.
// ---------------------------------------------------------------------------
const SAVED_ID = (() => {
    const saved = saveCheckpoint({ env: ENV, label: "LAYAR login", origin: "https://layar.example", stateBytes: freshStateBytes() });
    assert.equal(saved.status, "ok", "saveCheckpoint succeeds");
    assert.equal(CHECKPOINT_ID_PATTERN.test(saved.id), true, "id is 16 lowercase hex chars");
    assert.equal((statSync(saved.path).mode & 0o777).toString(8), "600", "ckpt file is 0600");
    assert.equal((statSync(getCheckpointDirectory(ENV)).mode & 0o777).toString(8), "700", "snapshot dir is 0700");
    assert.ok(saved.path.includes(`${saved.id}.ckpt`), "file is content-addressed by the id");
    assertNoLeak(JSON.stringify({ ...saved, path: undefined }), "saveCheckpoint projection");
    return saved.id;
})();
{
    const read = readCheckpoint(SAVED_ID, { env: ENV });
    assert.equal(read.status, "ok");
    const described = describeCheckpointEnvelope(read.envelope);
    assert.equal(described.label, "LAYAR login");
    assert.equal(described.origin, "https://layar.example");
    assert.equal(typeof described.createdAtMs, "number");
    assert.equal(described.ageDays, 0);
    assert.equal(described.stateBytes, Buffer.byteLength(PLAINTEXT_STATE));
    assert.equal(described.fidelity, CHECKPOINT_FIDELITY);
    assert.equal(described.payload, undefined, "metadata projection never carries the payload");

    const decrypted = decryptCheckpoint(SAVED_ID, { env: ENV });
    assert.equal(decrypted.status, "ok");
    assert.equal(Buffer.compare(decrypted.bytes, freshStateBytes()), 0, "decryptCheckpoint roundtrip is byte-identical");

    const second = saveCheckpoint({ env: ENV, stateBytes: freshStateBytes(), nowMs: Date.now() - 40 * 86_400_000 });
    assert.equal(second.status, "ok");
    const freshEnvelope = JSON.parse(readFileSync(readCheckpoint(SAVED_ID, { env: ENV }).path, "utf8"));
    const oldEnvelope = JSON.parse(readFileSync(readCheckpoint(second.id, { env: ENV }).path, "utf8"));
    assert.equal(isCheckpointExpired(freshEnvelope, { env: ENV }), false, "fresh snapshot inside the 30d TTL");
    assert.equal(isCheckpointExpired(oldEnvelope, { env: ENV }), true, "40-day-old snapshot is expired at the default TTL");
    assert.equal(getCheckpointTtlDays({ ...ENV, [CHECKPOINT_TTL_DAYS_ENV]: "7" }), 7, "TTL env override");
    assert.equal(getCheckpointTtlDays({ ...ENV, [CHECKPOINT_TTL_DAYS_ENV]: "nope" }), CHECKPOINT_DEFAULT_TTL_DAYS, "non-numeric TTL falls back to 30d");
    assert.equal(isCheckpointExpired(oldEnvelope, { env: { ...ENV, [CHECKPOINT_TTL_DAYS_ENV]: "90" } }), false, "larger TTL un-expires");

    const listed = listCheckpoints({ env: ENV });
    assert.equal(listed.status, "ok");
    assert.equal(listed.checkpoints.length, 2);
    assert.ok(listed.checkpoints[0].createdAtMs >= listed.checkpoints[1].createdAtMs, "list is newest-first");
    assertNoLeak(JSON.stringify(listed), "listCheckpoints");

    assert.equal(readCheckpoint("zz", { env: ENV }).status, "invalid-id");
    assert.equal(readCheckpoint("0123456789abcdef", { env: ENV }).status, "missing");
    const corruptPath = join(getCheckpointDirectory(ENV), "ffffffffffffffff.ckpt");
    writeFileSync(corruptPath, "{not json", { mode: 0o600 });
    assert.equal(readCheckpoint("ffffffffffffffff", { env: ENV }).status, "corrupt");
    const listedAfterCorrupt = listCheckpoints({ env: ENV });
    assert.equal(listedAfterCorrupt.unreadable, 1, "corrupt snapshots are counted, never decrypted");

    const tempPath = createCheckpointTempPath(ENV, "aabbccddeeff");
    assert.equal(writeCheckpointTempFile(tempPath, freshStateBytes()), undefined);
    assert.equal((statSync(tempPath).mode & 0o777).toString(8), "600", "decrypted temp file is 0600");
    const refused = writeCheckpointTempFile(tempPath, freshStateBytes());
    assert.notEqual(refused, undefined, "wx refuses to overwrite a temp file");
    assert.match(refused, /^failed to write checkpoint temp file: /, "temp-write failure message is generic");
    assert.equal(refused.includes(tempPath), false, "temp-write failure message is path-free");
    assert.equal(refused.includes(getCheckpointDirectory(ENV)), false, "temp-write failure message never names the snapshot dir");
    assert.equal(secureDeleteFile(tempPath), true);
    assert.equal(existsSync(tempPath), false, "secureDeleteFile removes the temp file");

    const staleTemp = join(getCheckpointDirectory(ENV), "tmp-000000000000.state");
    writeFileSync(staleTemp, Buffer.from("stale"), { mode: 0o600 });
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(staleTemp, twoHoursAgo, twoHoursAgo);
    const reaped = reapStaleCheckpointTempFiles({ env: ENV });
    assert.ok(reaped.includes("tmp-000000000000.state"), "a tmp-*.state older than 1h is reaped");
    assert.equal(existsSync(staleTemp), false, "reaped stale temp is gone");
    const recentTemp = join(getCheckpointDirectory(ENV), "tmp-111111111111.state");
    writeFileSync(recentTemp, Buffer.from("recent"), { mode: 0o600 });
    assert.equal(reapStaleCheckpointTempFiles({ env: ENV }).includes("tmp-111111111111.state"), false, "a recent temp is never reaped");
    assert.equal(existsSync(recentTemp), true);
    assert.equal(secureDeleteFile(recentTemp), true);
    assert.doesNotThrow(() => reapStaleCheckpointTempFiles({ env: { ...ENV, PI_AGENT_BROWSER_VAULT_DIR: join(TEST_ROOT, "no-such-vault") } }), "reap never throws on a missing snapshot dir");
}

// ---------------------------------------------------------------------------
// 3. compiler + pure gate decisions.
// ---------------------------------------------------------------------------
{
    const savePlan = normalizeCheckpointInput({ action: "save", label: " L ", url: "https://layar.example/login/page", session: "ultron1" });
    assert.equal(savePlan.error, undefined);
    assert.deepEqual(savePlan.value, { action: "save", label: "L", origin: "https://layar.example", session: "ultron1" }, "save normalizes url->origin and trims the label");

    const restorePlan = normalizeCheckpointInput({ action: "restore", confirm: true, force: false, id: SAVED_ID });
    assert.equal(restorePlan.error, undefined);
    assert.deepEqual(restorePlan.value, { action: "restore", confirm: true, force: false, id: SAVED_ID });
    const listPlan = normalizeCheckpointInput({ action: "list" });
    assert.deepEqual(listPlan.value, { action: "list" });

    assert.match(normalizeCheckpointInput({ action: "restore", id: "NOPE" }).error, /16-hex-character id/);
    assert.match(normalizeCheckpointInput({ action: "restore", id: SAVED_ID, confirm: "yes" }).error, /true or false/);
    assert.match(normalizeCheckpointInput({ action: "save", zap: 1 }).error, /does not support checkpoint\.zap/);
    assert.match(normalizeCheckpointInput({ action: "save", session: "-bad" }).error, /upstream session name/);
    assert.match(normalizeCheckpointInput({ action: "save", url: "ftp://x" }).error, /http\(s\) URL/);
    assert.match(normalizeCheckpointInput({ action: "fly" }).error, /save, restore, list/);
    assert.match(normalizeCheckpointInput("save").error, /must be an object/);

    const compiledSave = compileCheckpointRun({ action: "save", origin: "https://layar.example" });
    assert.deepEqual(compiledSave.args.slice(0, 2), ["state", "save"], "save compiles to upstream state save");
    assert.match(compiledSave.args[2], /auth-snapshots[/\\]tmp-[0-9a-f]{12}\.state$/, "save names a temp file inside the snapshot dir");
    const compiledSaveWithSession = compileCheckpointRun({ action: "save", session: "ultron1" });
    assert.deepEqual(compiledSaveWithSession.args.slice(0, 2), ["--session", "ultron1"]);
    const compiledRestore = compileCheckpointRun({ action: "restore", id: SAVED_ID });
    assert.deepEqual(compiledRestore.args, ["--session", checkpointSessionNameForId(SAVED_ID), "batch", "--bail"], "restore compiles to a fail-fast batch in the fresh session");
    assert.deepEqual(JSON.parse(compiledRestore.stdin), [["state", "load", compiledRestore.tempPath], ["snapshot"]], "restore batch is state load + health-check snapshot");
    assert.equal(compiledRestore.tempPath, JSON.parse(compiledRestore.stdin)[0][2], "load row uses the pre-named temp path");
    assert.deepEqual(compileCheckpointRun({ action: "list" }).args, [], "list compiles to no argv (host-side)");

    assert.equal(describeCheckpointPlan({ action: "restore", id: SAVED_ID }).requiresConfirmation, true);
    assert.doesNotThrow(() => describeCheckpointPlan(undefined));

    const baseGate = { plan: { action: "restore", id: SAVED_ID }, ttlDays: 30, ageDays: 40.2 };
    assert.equal(resolveCheckpointGateDecision({ ...baseGate, expired: true, targetSessionAlive: false })?.failureCategory, "confirmation-required", "expired restore is gated");
    assert.equal(resolveCheckpointGateDecision({ expired: true, plan: { action: "restore", id: SAVED_ID, force: true }, targetSessionAlive: false, ttlDays: 30, ageDays: 40.2 }), undefined, "force passes the TTL gate");
    const aliveGate = resolveCheckpointGateDecision({ plan: { action: "restore", id: SAVED_ID }, expired: false, targetSessionAlive: true, ttlDays: 30, ageDays: 1 });
    assert.equal(aliveGate?.failureCategory, "confirmation-required", "live target session is gated");
    assert.match(aliveGate.errorText, /confirm: true/);
    assert.equal(resolveCheckpointGateDecision({ plan: { action: "restore", id: SAVED_ID, confirm: true }, expired: false, targetSessionAlive: true, ttlDays: 30, ageDays: 1 }), undefined, "confirm passes the live-session gate");
    assert.equal(resolveCheckpointGateDecision({ plan: { action: "restore", id: SAVED_ID }, expired: false, targetSessionAlive: false, ttlDays: 30, ageDays: 1 }), undefined, "clean restore passes");
    assert.equal(resolveCheckpointGateDecision({ plan: { action: "save" }, expired: true, targetSessionAlive: true, ttlDays: 30 }), undefined, "save is never gated");
}

// ---------------------------------------------------------------------------
// 4. exactly-one-input-mode ladder (P15 shape).
// ---------------------------------------------------------------------------
{
    const opts = { getBatchPreflightValidationError: () => undefined };
    const list = resolveAgentBrowserInput({ ...opts, params: { checkpoint: { action: "list" } } });
    assert.equal(list.kind, "checkpoint");
    assert.equal(list.status, "valid");
    assert.deepEqual(list.toolArgs, []);
    assert.equal(JSON.stringify(list.redactedCompiledCheckpoint).includes("tempPath"), false, "redacted plan echo never carries the temp path");

    const save = resolveAgentBrowserInput({ ...opts, params: { checkpoint: { action: "save" } } });
    assert.equal(save.kind, "checkpoint");
    assert.equal(save.toolArgs[0], "state");
    const restore = resolveAgentBrowserInput({ ...opts, params: { checkpoint: { action: "restore", id: SAVED_ID } } });
    assert.equal(restore.kind, "checkpoint");
    assert.equal(restore.toolArgs[1], checkpointSessionNameForId(SAVED_ID));

    const bad = resolveAgentBrowserInput({ ...opts, params: { checkpoint: { action: "restore", id: "zz" } } });
    assert.equal(bad.kind, "invalid");
    assert.match(bad.validationError, /16-hex-character id/);
    const conflict = resolveAgentBrowserInput({ ...opts, params: { args: ["snapshot"], checkpoint: { action: "list" } } });
    assert.equal(conflict.status, "invalid");
    assert.match(conflict.validationError, /args and checkpoint/);
    const zero = resolveAgentBrowserInput({ ...opts, params: {} });
    assert.ok(zero.validationError.includes("checkpoint"), "supported-mode list names checkpoint");
    const argsRegression = resolveAgentBrowserInput({ ...opts, params: { args: ["get", "title"] } });
    assert.equal(argsRegression.kind, "args", "args mode is unaffected");
}

// ---------------------------------------------------------------------------
// 5. finalizer against mocked pipeline results (no browser).
// ---------------------------------------------------------------------------
const RESTORE_SESSION = checkpointSessionNameForId(SAVED_ID);
{
    clearVaultSecrets();
    // save: happy path — the upstream "process result" says saved and the temp file exists.
    // The prepare.js gate registers the temp path before the spawn; simulate that here so the
    // scrub assertions below exercise the same registry state a real run would have.
    const compiledSave = compileCheckpointRun({ action: "save", label: "mock", origin: "https://layar.example" });
    registerVaultSecret(compiledSave.tempPath, { source: "checkpoint-temp" });
    writeFileSync(compiledSave.tempPath, freshStateBytes(), { mode: 0o600 });
    const savePresentation = { content: [{ type: "text", text: `{"success":true}` }], summary: "upstream completed" };
    const saveEnvelope = { success: true, data: { path: compiledSave.tempPath, saved: true } };
    const savedRun = await finalizeCheckpointRun({
        compiledCheckpoint: compiledSave,
        presentation: savePresentation,
        presentationEnvelope: saveEnvelope,
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(savedRun.succeeded, true, "save finalize succeeds");
    assert.equal(savedRun.checkpoint.saved, true);
    assert.equal(savedRun.checkpoint.action, "save");
    assert.ok(CHECKPOINT_ID_PATTERN.test(savedRun.checkpoint.id));
    assert.equal(savedRun.checkpoint.stateBytes, Buffer.byteLength(PLAINTEXT_STATE));
    assert.equal(existsSync(compiledSave.tempPath), false, "temp state file deleted after save");
    assertNoLeak(JSON.stringify(savedRun.checkpoint), "save checkpoint details");
    assert.ok(savedRun.presentation.content[0].text.includes(savedRun.checkpoint.id), "save content leads with the opaque id");
    assertNoLeak(JSON.stringify(savedRun.presentation), "save presentation");
    // the ciphertext path was registered for the P12 scrub and the upstream path echo is scrubbed
    assert.ok(getVaultSecretValues().some((value) => value.endsWith(".ckpt")), "ciphertext path registered in the secret registry");
    assert.equal(scrubVaultSecrets(`echo ${compiledSave.tempPath}`), "echo [REDACTED]", "temp path registered before the spawn is scrubbed");
    assert.equal(scrubVaultSecretValues({ path: getVaultSecretValues().find((value) => value.endsWith(".ckpt")) }).path, "[REDACTED]", "ciphertext path scrubbed from any object echo");
    clearVaultSecrets();

    // save: upstream failed — nothing stored, temp deleted.
    const failedCompiled = compileCheckpointRun({ action: "save" });
    const failedRun = await finalizeCheckpointRun({ compiledCheckpoint: failedCompiled, presentation: { content: [], summary: "" }, presentationEnvelope: { success: false }, processSucceeded: false, succeeded: false });
    assert.equal(failedRun.succeeded, false);
    assert.equal(failedRun.checkpoint.saved, false);
    assert.equal(listCheckpoints({ env: ENV }).checkpoints.some((row) => row.label === undefined && row.origin === undefined && row.stateBytes === 0), false, "no phantom snapshot row");
    assert.equal(existsSync(failedCompiled.tempPath), false, "temp deleted on failure too");

    // save: upstream lied (success but no temp file).
    const liedCompiled = compileCheckpointRun({ action: "save" });
    const liedRun = await finalizeCheckpointRun({ compiledCheckpoint: liedCompiled, presentation: { content: [], summary: "" }, presentationEnvelope: { success: true }, processSucceeded: true, succeeded: true });
    assert.equal(liedRun.succeeded, false, "a missing state file is a failure, never a claim");
    assert.equal(liedRun.presentation.failureCategory, "checkpoint-error");

    // restore: happy path — load row + snapshot row both succeed -> "page rendered".
    const compiledRestore = compileCheckpointRun({ action: "restore", id: SAVED_ID });
    writeFileSync(compiledRestore.tempPath, Buffer.from("decrypted-state"), { mode: 0o600 });
    const restorePresentation = {
        batchSteps: [
            { command: ["state", "load", compiledRestore.tempPath], success: true, result: { loaded: true } },
            { command: ["snapshot"], success: true, result: { refs: { e1: { role: "link", name: "x" } } } },
        ],
        content: [{ type: "text", text: "batch steps" }],
        summary: "batch completed",
    };
    const restoredRun = await finalizeCheckpointRun({
        compiledCheckpoint: compiledRestore,
        presentation: restorePresentation,
        presentationEnvelope: { success: true, data: [] },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(restoredRun.succeeded, true, "healthy restore succeeds");
    assert.equal(restoredRun.checkpoint.restored, true);
    assert.equal(restoredRun.checkpoint.loginEvidence, "page rendered");
    assert.equal(restoredRun.checkpoint.reauthRequired, false);
    assert.equal(restoredRun.checkpoint.session, RESTORE_SESSION);
    assert.ok(restoredRun.checkpoint.session.startsWith(CHECKPOINT_SESSION_PREFIX));
    assert.ok(restoredRun.presentation.content[0].text.includes("does NOT prove"), "restore prose keeps the honesty caveat");
    assert.equal(restoredRun.presentation.content[0].text.includes("fresh session"), false, "restore prose no longer overclaims a fresh session");
    assert.match(restoredRun.presentation.content[0].text, new RegExp(`restored into checkpoint session ${RESTORE_SESSION}`), "restore prose claims only the checkpoint session");
    assert.ok(getVaultSecretValues().some((value) => value.endsWith(`${SAVED_ID}.ckpt`)), "restore path registers the ciphertext path too");
    assertNoLeak(JSON.stringify(restoredRun.checkpoint), "restore checkpoint details");
    assert.equal(existsSync(compiledRestore.tempPath), false, "decrypted temp deleted after restore");

    // honest prose: when the gate saw a prior stopped profile for this session name, say it was reused.
    const reusedRun = await finalizeCheckpointRun({
        compiledCheckpoint: { ...compileCheckpointRun({ action: "restore", id: SAVED_ID }), priorCheckpointSessionProfile: true },
        presentation: restorePresentation,
        presentationEnvelope: { success: true, data: [] },
        processSucceeded: true,
        succeeded: true,
    });
    assert.ok(reusedRun.presentation.content[0].text.includes("(session profile reused)"), "a prior stopped profile is reported as reused");

    // restore: snapshot row failed -> reauth required, never claimed healthy.
    const sickCompiled = compileCheckpointRun({ action: "restore", id: SAVED_ID });
    const sickRun = await finalizeCheckpointRun({
        compiledCheckpoint: sickCompiled,
        presentation: {
            batchSteps: [
                { command: ["state", "load", sickCompiled.tempPath], success: true, result: { loaded: true } },
                { command: ["snapshot"], success: false, error: "page failed" },
            ],
            content: [],
            summary: "",
        },
        presentationEnvelope: { success: true, data: [] },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(sickRun.succeeded, false, "failed health check fails the restore");
    assert.equal(sickRun.checkpoint.reauthRequired, true);
    assert.equal(sickRun.checkpoint.loginEvidence, undefined);
    assert.equal(sickRun.presentation.failureCategory, "checkpoint-reauth-required");
    assert.ok(sickRun.presentationEnvelope.success === false);

    // restore: load row failed -> nothing claimed.
    const deadCompiled = compileCheckpointRun({ action: "restore", id: SAVED_ID });
    const deadRun = await finalizeCheckpointRun({
        compiledCheckpoint: deadCompiled,
        presentation: {
            batchSteps: [{ command: ["state", "load", deadCompiled.tempPath], success: false, error: "load boom" }],
            content: [],
            summary: "",
        },
        presentationEnvelope: { success: false },
        processSucceeded: false,
        succeeded: false,
    });
    assert.equal(deadRun.succeeded, false);
    assert.equal(deadRun.checkpoint.restored, false);
    assert.equal(deadRun.presentation.failureCategory, "checkpoint-error");
    assert.ok(deadRun.presentation.content[0].text.includes("NOT restored"));

    // restore: expired metadata surfaces forced=true.
    const oldSave = saveCheckpoint({ env: ENV, stateBytes: freshStateBytes(), nowMs: Date.now() - 40 * 86_400_000 });
    const oldCompiled = compileCheckpointRun({ action: "restore", force: true, id: oldSave.id });
    const oldRun = await finalizeCheckpointRun({
        compiledCheckpoint: oldCompiled,
        presentation: {
            batchSteps: [
                { command: ["state", "load", oldCompiled.tempPath], success: true, result: { loaded: true } },
                { command: ["snapshot"], success: true, result: {} },
            ],
            content: [],
            summary: "",
        },
        presentationEnvelope: { success: true, data: [] },
        processSucceeded: true,
        succeeded: true,
    });
    assert.equal(oldRun.checkpoint.forced, true, "forced restore is visible in the details");
    assert.ok(oldRun.checkpoint.ageDays >= 39, "age reported honestly");

    clearVaultSecrets();
}

// ---------------------------------------------------------------------------
// 6. argv-grammar session-grammar riders.
// ---------------------------------------------------------------------------
{
    assert.equal(CHECKPOINT_SESSION_PREFIX, "piab-ckpt-");
    assert.equal(checkpointSessionNameForId("0123456789abcdef"), "piab-ckpt-01234567");
    assert.equal(isCheckpointSessionName("piab-ckpt-01234567"), true);
    assert.equal(isCheckpointSessionName("piab-ckpt-0123456"), false, "7 hex chars rejected");
    assert.equal(isCheckpointSessionName("piab-ckpt-ZZZZZZZZ"), false, "non-hex rejected");
    assert.equal(isCheckpointSessionName("ultron1"), false, "operator sessions never look like checkpoint sessions");
    assert.equal(isCheckpointSessionName(undefined), false);
}

rmSync(TEST_ROOT, { recursive: true, force: true });
console.log("wave3-g-checkpoint: all assertions passed (legacy vault roundtrip after refactor, checkpoint raw-crypto roundtrip + AAD domain split, content-addressed 0600 storage, metadata-only list, TTL + pure confirmation gates, P15 ladder, mocked save/restore finalization with id opacity + registry scrub, session-grammar riders)");
