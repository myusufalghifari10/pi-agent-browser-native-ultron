// local patch: `checkpoint` input mode validator, compiler and result analysis (FINAL-DESIGN.md §1
// pillar B reshape, §5 step 7 — origin auth-snapshots).
//
// What a checkpoint honestly is: the upstream CLI's browser storage-state (cookies incl. HttpOnly +
// per-origin localStorage), captured through `agent-browser state save`, encrypted at rest with the
// vault key, and restored ONLY into a fresh dedicated session. It is not a byte-identical fork and
// must never be described as one. Validation is strict before any store or browser work, modeled on
// vault-mode.js:
//   - `save` compiles to `state save <temp>` (optionally `--session <name>`), and the pipeline result
//     is finalized into an encrypted, content-addressed auth-snapshot file,
//   - `restore <id>` compiles to a fail-fast batch (`state load <temp>` + health-check `snapshot`)
//     with an explicit fresh session `piab-ckpt-<id8>`; a live target session or an expired snapshot
//     requires explicit caller affirmation (`confirm` / `force`),
//   - `list` is host-side and never spawns or decrypts anything.
//
// The normalize/compile half is pure (no fs, no browser). `finalizeCheckpointRun` is called from the
// output pipeline and performs the store round-trip through lib/vault/checkpoint-store.js. Decrypted
// storage-state never enters any result: results carry ids, byte counts and labels only.
import { readFile } from "node:fs/promises";
import { checkpointSessionNameForId } from "../argv-grammar.js";
import { isRecord } from "../parsing.js";
import {
    CHECKPOINT_FIDELITY,
    CHECKPOINT_ID_PATTERN,
    CHECKPOINT_TTL_DAYS_ENV,
    createCheckpointTempPath,
    describeCheckpointEnvelope,
    readCheckpoint,
    saveCheckpoint,
    secureDeleteFile,
} from "../vault/checkpoint-store.js";
import { registerVaultSecret } from "../vault/secret-registry.js";
import { normalizeVaultOrigin } from "../vault/store.js";

export const CHECKPOINT_ACTIONS = ["save", "restore", "list"];
const MAX_LABEL_CHARS = 200;
const MAX_SESSION_CHARS = 64;

function normalizeOptionalString(input, fieldName, label, { maxChars } = {}) {
    const value = input[fieldName];
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `${label} must be a non-empty string when provided.` };
    }
    const trimmed = value.trim();
    if (maxChars && trimmed.length > maxChars) {
        return { error: `${label} must be ${maxChars} characters or fewer.` };
    }
    return { value: trimmed };
}

function normalizeOptionalBoolean(input, fieldName, label) {
    const value = input[fieldName];
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "boolean") {
        return { error: `${label} must be true or false when provided.` };
    }
    return { value };
}

function onlyAllowedCheckpointFields(input, action, allowedFields) {
    const unexpected = Object.keys(input).find((fieldName) => !allowedFields.has(fieldName));
    return unexpected ? `checkpoint.${action} does not support checkpoint.${unexpected}.` : undefined;
}

// Same session-name rule as vault.mode (PATCHES.md P27): letters/digits/dot/dash/underscore.
function validateOptionalSession(input) {
    const session = normalizeOptionalString(input, "session", "checkpoint.session", { maxChars: MAX_SESSION_CHARS });
    if (session.error) {
        return { error: session.error };
    }
    if (session.value === undefined) {
        return {};
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session.value)) {
        return { error: "checkpoint.session must be an upstream session name: letters, digits, dot, dash or underscore, starting with a letter or digit." };
    }
    return { value: session.value };
}

function normalizeCheckpointSave(input) {
    const unexpected = onlyAllowedCheckpointFields(input, "save", new Set(["action", "label", "url", "session"]));
    if (unexpected) {
        return { error: unexpected };
    }
    const label = normalizeOptionalString(input, "label", "checkpoint.label", { maxChars: MAX_LABEL_CHARS });
    if (label.error) {
        return { error: label.error };
    }
    const value = { action: "save" };
    if (input.url !== undefined) {
        const origin = normalizeVaultOrigin(input.url);
        if (!origin) {
            return { error: `checkpoint.url must be an http(s) URL such as https://app.example.com, not ${JSON.stringify(input.url)}.` };
        }
        value.origin = origin;
    }
    const session = validateOptionalSession(input);
    if (session.error) {
        return { error: session.error };
    }
    if (label.value) {
        value.label = label.value;
    }
    if (session.value) {
        value.session = session.value;
    }
    return { value };
}

function normalizeCheckpointRestore(input) {
    const unexpected = onlyAllowedCheckpointFields(input, "restore", new Set(["action", "confirm", "force", "id"]));
    if (unexpected) {
        return { error: unexpected };
    }
    if (typeof input.id !== "string" || !CHECKPOINT_ID_PATTERN.test(input.id)) {
        return { error: "checkpoint.restore requires the 16-hex-character id returned by checkpoint save (use checkpoint list to see saved ids)." };
    }
    const confirm = normalizeOptionalBoolean(input, "confirm", "checkpoint.confirm");
    if (confirm.error) {
        return { error: confirm.error };
    }
    const force = normalizeOptionalBoolean(input, "force", "checkpoint.force");
    if (force.error) {
        return { error: force.error };
    }
    const value = { action: "restore", id: input.id };
    if (confirm.value !== undefined) {
        value.confirm = confirm.value;
    }
    if (force.value !== undefined) {
        value.force = force.value;
    }
    return { value };
}

function normalizeCheckpointList(input) {
    const unexpected = onlyAllowedCheckpointFields(input, "list", new Set(["action"]));
    if (unexpected) {
        return { error: unexpected };
    }
    return { value: { action: "list" } };
}

export function normalizeCheckpointInput(input) {
    if (Array.isArray(input) || !isRecord(input)) {
        return { error: `checkpoint must be an object with an action of ${CHECKPOINT_ACTIONS.join(", ")}.` };
    }
    const { action } = input;
    if (typeof action !== "string" || !CHECKPOINT_ACTIONS.includes(action)) {
        return { error: `checkpoint.action must be one of: ${CHECKPOINT_ACTIONS.join(", ")}.` };
    }
    switch (action) {
        case "save":
            return normalizeCheckpointSave(input);
        case "restore":
            return normalizeCheckpointRestore(input);
        case "list":
            return normalizeCheckpointList(input);
        default:
            return { error: `checkpoint.action must be one of: ${CHECKPOINT_ACTIONS.join(", ")}.` };
    }
}

/**
 * Compile a validated plan into the pipeline argv. The temp state file is pre-named here (path
 * derivation only, no fs access) so the same path travels through argv and the finalizer.
 */
export function compileCheckpointRun(plan) {
    if (plan.action === "list") {
        return { args: [], plan, stdin: undefined, tempPath: undefined };
    }
    const tempPath = createCheckpointTempPath();
    if (plan.action === "save") {
        return {
            args: plan.session ? ["--session", plan.session, "state", "save", tempPath] : ["state", "save", tempPath],
            plan,
            stdin: undefined,
            tempPath,
        };
    }
    // Restore lands in a dedicated fresh session whose name is derived from the id. `get url` sits
    // between the load and the snapshot because the wrapper's page-target validator refuses
    // page-content inspection directly after a state-load transition (wave4 live-sweep W-V1); the
    // pre-spawn gate additionally injects the `open <origin>` row after decryption (see
    // buildRestoreBatchRows) so the snapshot health-checks a real page of the restored origin.
    return {
        args: ["--session", checkpointSessionNameForId(plan.id), "batch", "--bail"],
        plan,
        stdin: JSON.stringify([["state", "load", tempPath], ["get", "url"], ["snapshot"]]),
        tempPath,
    };
}

export function describeCheckpointPlan(value) {
    if (!isRecord(value) || typeof value.action !== "string") {
        return { action: "unknown", requiresConfirmation: false, summary: "Unrecognized checkpoint plan." };
    }
    switch (value.action) {
        case "save":
            return {
                action: "save",
                requiresConfirmation: false,
                summary: `Capture the current session's browser storage-state (cookies + origins${value.session ? `, session ${value.session}` : ""}) into an encrypted auth-snapshot${value.label ? ` labeled "${value.label}"` : ""}${value.origin ? ` for ${value.origin}` : ""}.`,
            };
        case "restore":
            return {
                action: "restore",
                requiresConfirmation: true,
                summary: `Decrypt auth-snapshot ${value.id} into the fresh session ${checkpointSessionNameForId(value.id)}, then run a post-restore snapshot health check${value.force ? ", forcing past the TTL" : ""}${value.confirm ? ", confirming any live session is replaced" : ""}.`,
            };
        case "list":
            return {
                action: "list",
                requiresConfirmation: false,
                summary: "List saved auth-snapshots as metadata only (ids, labels, ages); decrypted content is never shown.",
            };
        default:
            return { action: "unknown", requiresConfirmation: false, summary: "Unrecognized checkpoint plan." };
    }
}

/**
 * Pure confirmation/TTL gate for restore. Returns undefined when the restore may proceed, else the
 * failure text and its category. Expiry and a live target session both demand explicit affirmation.
 */
export function resolveCheckpointGateDecision({ ageDays, expired, plan, targetSessionAlive, ttlDays }) {
    if (plan.action !== "restore") {
        return undefined;
    }
    if (expired && plan.force !== true) {
        return {
            errorText: `Checkpoint ${plan.id} is expired (age ${ageDays ?? "unknown"} days > TTL ${ttlDays} days; override with ${CHECKPOINT_TTL_DAYS_ENV}). Stale cookies may be revoked or worse, a stolen snapshot: save a fresh checkpoint from a logged-in session, or retry with force: true to restore the stale snapshot anyway.`,
            failureCategory: "confirmation-required",
        };
    }
    if (targetSessionAlive && plan.confirm !== true) {
        return {
            errorText: `Session ${checkpointSessionNameForId(plan.id)} already has a live browser, so restoring would replace its state. Retry with confirm: true if that is intended.`,
            failureCategory: "confirmation-required",
        };
    }
    return undefined;
}

function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function withPrependedText(presentation, text, summary) {
    const existing = Array.isArray(presentation?.content) ? presentation.content : [];
    const content = existing[0]?.type === "text" ? [{ type: "text", text }, ...existing] : [{ type: "text", text }, ...existing];
    return { ...presentation, content, summary: summary ?? presentation?.summary };
}

/**
 * Finalize a finished checkpoint pipeline run: store the captured state (save), grade the health
 * check (restore), and always delete the decrypted temp file. Returns the (possibly failed) result
 * inputs plus the secret-free `checkpoint` details object. This runs BEFORE the final result is
 * assembled so the secret-registry scrub (P12) covers anything the upstream payload echoed.
 */
export async function finalizeCheckpointRun({ compiledCheckpoint, presentation, presentationEnvelope, processSucceeded, succeeded }) {
    try {
        if (compiledCheckpoint.plan.action === "save") {
            return await finalizeCheckpointSave({ compiledCheckpoint, presentation, presentationEnvelope, processSucceeded, succeeded });
        }
        if (compiledCheckpoint.plan.action === "restore") {
            return finalizeCheckpointRestore({ compiledCheckpoint, presentation, presentationEnvelope, processSucceeded, succeeded });
        }
        return { checkpoint: undefined, presentation, presentationEnvelope, succeeded };
    }
    catch (error) {
        secureDeleteFile(compiledCheckpoint.tempPath);
        const message = error instanceof Error ? error.message : String(error);
        const text = `Checkpoint finalization failed: ${message}. No claim is made about the snapshot or the session.`;
        return {
            checkpoint: { action: compiledCheckpoint.plan.action, error: "finalize-failed" },
            presentation: { ...withPrependedText(presentation, text), resultCategory: "failure", failureCategory: "checkpoint-error" },
            presentationEnvelope: { ...presentationEnvelope, success: false, error: text },
            succeeded: false,
        };
    }
}

async function finalizeCheckpointSave({ compiledCheckpoint, presentation, presentationEnvelope, processSucceeded, succeeded }) {
    const { plan, tempPath } = compiledCheckpoint;
    if (!processSucceeded || !succeeded) {
        secureDeleteFile(tempPath);
        return { checkpoint: { action: "save", saved: false }, presentation, presentationEnvelope, succeeded: false };
    }
    let stateBytes;
    try {
        stateBytes = await readFile(tempPath);
    }
    catch {
        secureDeleteFile(tempPath);
        const text = "Checkpoint save failed: upstream reported success but wrote no state file, so no snapshot was captured. Nothing is claimed as saved.";
        return {
            checkpoint: { action: "save", saved: false },
            presentation: { ...withPrependedText(presentation, text), resultCategory: "failure", failureCategory: "checkpoint-error" },
            presentationEnvelope: { ...presentationEnvelope, success: false, error: text },
            succeeded: false,
        };
    }
    const stored = saveCheckpoint({ env: process.env, label: plan.label, origin: plan.origin, stateBytes });
    secureDeleteFile(tempPath);
    if (stored.status !== "ok") {
        const text = `Checkpoint save failed: ${stored.error}`;
        return {
            checkpoint: { action: "save", saved: false },
            presentation: { ...withPrependedText(presentation, text), resultCategory: "failure", failureCategory: "checkpoint-error" },
            presentationEnvelope: { ...presentationEnvelope, success: false, error: text },
            succeeded: false,
        };
    }
    // The ciphertext path is a bearer capability: register it so any accidental echo is scrubbed by
    // the exact-value pass (P12). It is deliberately absent from the text and details below.
    registerVaultSecret(stored.path, { source: "checkpoint-path" });
    const described = { action: "save", ciphertextBytes: stored.ciphertextBytes, createdAtMs: stored.createdAtMs, fidelity: CHECKPOINT_FIDELITY, id: stored.id, saved: true, stateBytes: stored.stateBytes };
    if (plan.label) {
        described.label = plan.label;
    }
    if (plan.origin) {
        described.origin = plan.origin;
    }
    const text = [
        `Checkpoint saved: ${stored.id}`,
        plan.label ? `Label: ${plan.label}` : undefined,
        plan.origin ? `Origin: ${plan.origin}` : undefined,
        `Created ${new Date(stored.createdAtMs).toISOString()} — storage-state ${stored.stateBytes} bytes, ciphertext ${stored.ciphertextBytes} bytes.`,
        `Fidelity: ${CHECKPOINT_FIDELITY}.`,
    ].filter((line) => line !== undefined).join("\n");
    return { checkpoint: described, presentation: withPrependedText(presentation, text, `Checkpoint ${stored.id} saved`), presentationEnvelope, succeeded: true };
}

function finalizeCheckpointRestore({ compiledCheckpoint, presentation, presentationEnvelope, processSucceeded, succeeded }) {
    const { plan, tempPath } = compiledCheckpoint;
    const sessionName = checkpointSessionNameForId(plan.id);
    secureDeleteFile(tempPath);
    const rows = Array.isArray(presentation?.batchSteps) ? presentation.batchSteps : [];
    const loadRow = rows.find((row) => isStringArray(row?.command) && row.command[0] === "state" && row.command[1] === "load");
    const snapshotRow = rows.find((row) => isStringArray(row?.command) && row.command[0] === "snapshot");
    const read = readCheckpoint(plan.id, { env: process.env });
    if (read.status === "ok") {
        // Mirror the save path: the ciphertext file is a bearer capability, so register it for the
        // P12 exact-value scrub before any restore result text is assembled.
        registerVaultSecret(read.path, { source: "checkpoint-path" });
    }
    const metadata = read.status === "ok" ? describeCheckpointEnvelope(read.envelope) : {};
    if (!processSucceeded || !succeeded || !loadRow || loadRow.success === false) {
        const text = `Checkpoint ${plan.id} was NOT restored: the state load did not succeed. Session ${sessionName} must not be treated as logged in; fix the cause or re-save the snapshot from a logged-in session.`;
        return {
            checkpoint: { action: "restore", id: plan.id, restored: false, session: sessionName, ...metadata },
            presentation: { ...withPrependedText(presentation, text), resultCategory: "failure", failureCategory: "checkpoint-error" },
            presentationEnvelope: { ...presentationEnvelope, success: false, error: text },
            succeeded: false,
        };
    }
    const snapshotPayload = isRecord(snapshotRow?.result) ? snapshotRow.result : isRecord(snapshotRow?.data) ? snapshotRow.data : undefined;
    const pageRendered = snapshotRow !== undefined && snapshotRow.success !== false && snapshotPayload !== undefined;
    const checkpoint = {
        action: "restore",
        id: plan.id,
        loginEvidence: pageRendered ? "page rendered" : undefined,
        reauthRequired: !pageRendered,
        restored: true,
        session: sessionName,
        ...metadata,
    };
    if (plan.force === true) {
        checkpoint.forced = true;
    }
    if (!pageRendered) {
        const text = `Checkpoint ${plan.id} loaded into ${sessionName}, but the post-restore snapshot failed, so there is no evidence the session works. Treat the login as NOT verified — reauth required.`;
        return {
            checkpoint,
            presentation: { ...withPrependedText(presentation, text), resultCategory: "failure", failureCategory: "checkpoint-reauth-required" },
            presentationEnvelope: { ...presentationEnvelope, success: false, error: text },
            succeeded: false,
        };
    }
    // Honest prose: repeat restores land in an existing session profile, so claim only "checkpoint
    // session" and add "(session profile reused)" when the pre-spawn gate observed a prior stopped
    // profile for this name (compiled.priorCheckpointSessionProfile, set by the gate in prepare.js).
    const reused = compiledCheckpoint.priorCheckpointSessionProfile === true;
    const text = [
        `Checkpoint ${plan.id} restored into checkpoint session ${sessionName}${reused ? " (session profile reused)" : ""}.`,
        "Login evidence: page rendered (the post-restore snapshot succeeded in that session).",
        `This proves the storage-state loaded and a page renders — it does NOT prove the origin login is still valid${plan.origin ? ` (${plan.origin})` : ""}; open the origin and verify before consequential work.`,
    ].join("\n");
    return { checkpoint, presentation: withPrependedText(presentation, text, `Checkpoint ${plan.id} restored into ${sessionName}; login evidence: page rendered`), presentationEnvelope, succeeded: true };
}
