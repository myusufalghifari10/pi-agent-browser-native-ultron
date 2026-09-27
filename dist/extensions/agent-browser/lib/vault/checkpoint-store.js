// local patch: origin auth-snapshot store (FINAL-DESIGN.md §1 pillar B reshape, §5 step 7).
//
// Why this exists and what it honestly is: browser state cannot be forked byte-identically (IndexedDB
// and service-worker-held auth are not capturable), so a checkpoint is ONLY the upstream CLI's
// storage-state (cookies incl. HttpOnly + per-origin localStorage), captured through
// `agent-browser state save`, encrypted at rest with the SAME vault key/AES-256-GCM machinery
// (imported from vault/store.js — crypto is never re-implemented here), and written as one
// content-addressed ciphertext file per snapshot. Consumers must label the fidelity as
// "cookies + origins only" and run a post-restore health check; nothing here may claim a full fork.
//
// Layout: <vault dir>/auth-snapshots/<sha256(ciphertext)[0:16]>.ckpt, mode 0600, dir 0700.
// The file is a JSON envelope: { version, cipher, kdf, payload, metadata } — metadata (label, origin,
// url, createdAtMs, byte counts, fidelity) is plaintext so `list` never needs to decrypt; the
// storage-state bytes only ever exist decrypted in memory or in a 0600 temp file that the caller
// deletes. Every result is a discriminated union and never embeds storage-state content.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { decryptVaultBytes, encryptVaultBytes, getVaultDirectory } from "./store.js";

export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_DIR_NAME = "auth-snapshots";
export const CHECKPOINT_FILE_SUFFIX = ".ckpt";
export const CHECKPOINT_TTL_DAYS_ENV = "PI_AGENT_BROWSER_CHECKPOINT_TTL_DAYS";
export const CHECKPOINT_DEFAULT_TTL_DAYS = 30;
export const CHECKPOINT_ID_PATTERN = /^[0-9a-f]{16}$/;
export const CHECKPOINT_FIDELITY = "cookies+origins (upstream storage-state; not a byte-identical fork)";
const DAY_MS = 86_400_000;

export function getCheckpointDirectory(env = process.env) {
    return join(getVaultDirectory(env), CHECKPOINT_DIR_NAME);
}

export function getCheckpointTtlDays(env = process.env) {
    const raw = typeof env?.[CHECKPOINT_TTL_DAYS_ENV] === "string" ? env[CHECKPOINT_TTL_DAYS_ENV].trim() : "";
    if (raw && /^\d+$/.test(raw)) {
        const parsed = Number(raw);
        if (Number.isSafeInteger(parsed) && parsed > 0) {
            return parsed;
        }
    }
    return CHECKPOINT_DEFAULT_TTL_DAYS;
}

function fileMode(path) {
    try {
        return lstatSync(path).mode & 0o777;
    }
    catch {
        return undefined;
    }
}

function isSymlink(path) {
    try {
        return lstatSync(path).isSymbolicLink();
    }
    catch {
        return false;
    }
}

/** Mirror the vault's fail-closed posture: refuse, never repair. */
export function getCheckpointStorageSecurityError(env = process.env) {
    const directory = getCheckpointDirectory(env);
    if (!existsSync(directory)) {
        return undefined;
    }
    if (isSymlink(directory)) {
        return `The auth-snapshot directory at ${directory} is a symlink. Replace it with a regular directory owned by you and retry.`;
    }
    const mode = fileMode(directory);
    if (mode === undefined) {
        return `The auth-snapshot directory at ${directory} could not be inspected. Check the path and retry.`;
    }
    if ((mode & 0o077) !== 0) {
        return `The auth-snapshot directory at ${directory} has mode ${mode.toString(8)} (expected 700). Run: chmod 700 ${directory}`;
    }
    return undefined;
}

function ensureCheckpointDirectory(env = process.env) {
    const directory = getCheckpointDirectory(env);
    if (!existsSync(directory)) {
        mkdirSync(directory, { mode: 0o700, recursive: true });
        return undefined;
    }
    const securityError = getCheckpointStorageSecurityError(env);
    if (securityError) {
        return securityError;
    }
    return undefined;
}

/** Pure path derivation (no fs access) so the compiler can name the temp file before any I/O. */
export function createCheckpointTempPath(env = process.env, randomness) {
    const suffix = typeof randomness === "string" && /^[0-9a-f]{12}$/.test(randomness) ? randomness : randomBytes(6).toString("hex");
    return join(getCheckpointDirectory(env), `tmp-${suffix}.state`);
}

export function checkpointFilePath(id, env = process.env) {
    return join(getCheckpointDirectory(env), `${id}${CHECKPOINT_FILE_SUFFIX}`);
}

/**
 * Encrypt + persist one snapshot. `stateBytes` are the raw upstream storage-state bytes read from the
 * temp file by the caller. The returned object never contains the storage-state content.
 */
export function saveCheckpoint({ stateBytes, label, origin, url, env = process.env, nowMs }) {
    if (!Buffer.isBuffer(stateBytes) || stateBytes.length === 0) {
        return { status: "error", error: "Checkpoint save needs the upstream storage-state bytes as a non-empty Buffer." };
    }
    const securityError = ensureCheckpointDirectory(env) ?? getCheckpointStorageSecurityError(env);
    if (securityError) {
        return { status: "insecure", error: securityError };
    }
    const metadata = {
        createdAtMs: Number.isSafeInteger(nowMs) ? nowMs : Date.now(),
        fidelity: CHECKPOINT_FIDELITY,
        stateBytes: stateBytes.length,
    };
    if (typeof label === "string" && label.length > 0) {
        metadata.label = label;
    }
    if (typeof origin === "string" && origin.length > 0) {
        metadata.origin = origin;
    }
    if (typeof url === "string" && url.length > 0) {
        metadata.url = url;
    }
    const encrypted = encryptVaultBytes(stateBytes, { env, domain: "checkpoint" });
    if (encrypted.status !== "ok") {
        return { status: encrypted.status, error: encrypted.error };
    }
    const envelope = { cipher: encrypted.envelope.cipher, kdf: encrypted.envelope.kdf, metadata, payload: encrypted.envelope.payload, version: CHECKPOINT_VERSION };
    const ciphertextBytes = Buffer.from(JSON.stringify(envelope), "utf8");
    const id = createHash("sha256").update(ciphertextBytes).digest("hex").slice(0, 16);
    const path = checkpointFilePath(id, env);
    if (existsSync(path)) {
        // Content-addressed: an existing file with this name must be byte-identical; anything else is
        // treated as corruption rather than overwritten.
        if (!ciphertextBytes.equals(readFileSync(path))) {
            return { status: "error", error: `Auth-snapshot ${id} already exists with different content; refusing to overwrite.` };
        }
        return { status: "ok", ciphertextBytes: ciphertextBytes.length, createdAtMs: metadata.createdAtMs, existed: true, id, path, stateBytes: stateBytes.length };
    }
    try {
        writeFileSync(path, ciphertextBytes, { mode: 0o600, flag: "wx" });
    }
    catch (error) {
        return { status: "error", error: `Could not write the auth-snapshot file: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { status: "ok", ciphertextBytes: ciphertextBytes.length, createdAtMs: metadata.createdAtMs, id, path, stateBytes: stateBytes.length };
}

/** Read + validate one envelope (metadata only — nothing is decrypted here). */
export function readCheckpoint(id, { env = process.env } = {}) {
    if (typeof id !== "string" || !CHECKPOINT_ID_PATTERN.test(id)) {
        return { status: "invalid-id", error: "A checkpoint id is 16 lowercase hex characters." };
    }
    const securityError = getCheckpointStorageSecurityError(env);
    if (securityError) {
        return { status: "insecure", error: securityError };
    }
    const path = checkpointFilePath(id, env);
    if (!existsSync(path)) {
        return { status: "missing", error: `No auth-snapshot exists with id ${id}. Use checkpoint list to see saved ids.` };
    }
    if (isSymlink(path)) {
        // Path-free like every other model-visible message: the id names the file, the path never does.
        return { status: "insecure", error: `The auth-snapshot file for ${id} is a symlink. Remove it and save the snapshot again.` };
    }
    const mode = fileMode(path);
    if (mode !== undefined && (mode & 0o077) !== 0) {
        return { status: "insecure", error: `The auth-snapshot file for ${id} has mode ${mode.toString(8)} (expected 600). Fix it with: chmod 600 ${id}${CHECKPOINT_FILE_SUFFIX} in your checkpoint storage directory.` };
    }
    let envelope;
    try {
        envelope = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return { status: "corrupt", error: `The auth-snapshot file for ${id} is not valid JSON. Delete it with host file tools and save a fresh snapshot.` };
    }
    if (!envelope || typeof envelope !== "object" || envelope.version !== CHECKPOINT_VERSION || typeof envelope.payload !== "string" || typeof envelope.cipher?.iv !== "string" || typeof envelope.cipher?.tag !== "string" || typeof envelope.metadata?.createdAtMs !== "number") {
        return { status: "corrupt", error: `The auth-snapshot file for ${id} has an unsupported or incomplete format (expected version ${CHECKPOINT_VERSION}).` };
    }
    return { status: "ok", ciphertextBytes: Buffer.byteLength(readFileSync(path)), envelope, path };
}

/** Metadata projection: safe for model-visible output; never includes decrypted content or paths. */
export function describeCheckpointEnvelope(envelope, { nowMs = Date.now() } = {}) {
    const metadata = envelope?.metadata ?? {};
    const createdAtMs = typeof metadata.createdAtMs === "number" ? metadata.createdAtMs : undefined;
    return {
        createdAtMs,
        fidelity: typeof metadata.fidelity === "string" ? metadata.fidelity : CHECKPOINT_FIDELITY,
        label: typeof metadata.label === "string" ? metadata.label : undefined,
        origin: typeof metadata.origin === "string" ? metadata.origin : undefined,
        stateBytes: typeof metadata.stateBytes === "number" ? metadata.stateBytes : undefined,
        url: typeof metadata.url === "string" ? metadata.url : undefined,
        ageDays: createdAtMs === undefined ? undefined : Math.max(0, Math.round(((nowMs - createdAtMs) / DAY_MS) * 10) / 10),
    };
}

export function isCheckpointExpired(envelope, { env = process.env, nowMs = Date.now() } = {}) {
    const createdAtMs = envelope?.metadata?.createdAtMs;
    if (typeof createdAtMs !== "number") {
        return true;
    }
    return nowMs - createdAtMs > getCheckpointTtlDays(env) * DAY_MS;
}

/** Decrypt to memory. The caller writes the bytes to a 0600 temp file and deletes it after the load. */
export function decryptCheckpoint(id, { env = process.env } = {}) {
    const read = readCheckpoint(id, { env });
    if (read.status !== "ok") {
        return { status: read.status, error: read.error };
    }
    const decrypted = decryptVaultBytes(read.envelope, { env, domain: "checkpoint" });
    if (decrypted.status !== "ok") {
        return { status: decrypted.status, error: decrypted.error };
    }
    return { status: "ok", bytes: decrypted.bytes, metadata: read.envelope.metadata };
}

/**
 * wave4 (live-sweep W-V1): pure row injection for restore batches. Upstream `state load` restores
 * storage but opens no page, so the compiled [state load, snapshot] batch hit the wrapper's own
 * post-transition guard ("active page became unverified after a state-load transition") and every
 * restore failed. Insert the navigation to the saved origin/url between the load and the
 * health-check snapshot so the snapshot verifies a real page of the restored origin.
 */
export function buildRestoreBatchRows(rows, restoreTarget) {
    if (!Array.isArray(rows) || typeof restoreTarget !== "string" || restoreTarget.length === 0)
        return undefined;
    const loadIndex = rows.findIndex((row) => Array.isArray(row) && row[0] === "state" && row[1] === "load");
    if (loadIndex === -1)
        return undefined;
    return [...rows.slice(0, loadIndex + 1), ["open", restoreTarget], ...rows.slice(loadIndex + 1)];
}

/** List saved snapshots as metadata only. Corrupt/unreadable files are counted, never decrypted. */
export function listCheckpoints({ env = process.env, nowMs = Date.now() } = {}) {
    const securityError = getCheckpointStorageSecurityError(env);
    if (securityError) {
        return { status: "insecure", error: securityError };
    }
    const directory = getCheckpointDirectory(env);
    if (!existsSync(directory)) {
        return { status: "ok", checkpoints: [], unreadable: 0 };
    }
    const checkpoints = [];
    let unreadable = 0;
    for (const entry of readdirSync(directory)) {
        if (!entry.endsWith(CHECKPOINT_FILE_SUFFIX)) {
            continue;
        }
        const read = readCheckpoint(entry.slice(0, -CHECKPOINT_FILE_SUFFIX.length), { env });
        if (read.status !== "ok") {
            unreadable += 1;
            continue;
        }
        checkpoints.push({ ciphertextBytes: read.ciphertextBytes, id: entry.slice(0, -CHECKPOINT_FILE_SUFFIX.length), ...describeCheckpointEnvelope(read.envelope, { nowMs }) });
    }
    checkpoints.sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0));
    return { status: "ok", checkpoints, unreadable };
}

/**
 * Best-effort secure delete: overwrite the file bytes with random data before unlinking. True
 * secure erasure is not guaranteeable on journaled filesystems, so this is hygiene, not a guarantee —
 * the durable protection is that the file only ever held plaintext inside a 0700 directory.
 */
export function secureDeleteFile(path) {
    try {
        if (!existsSync(path)) {
            return true;
        }
        const length = lstatSync(path).size;
        const fd = openSync(path, "r+");
        try {
            if (length > 0) {
                writeSync(fd, Buffer.alloc(length), 0, length, 0);
            }
        }
        finally {
            closeSync(fd);
        }
        unlinkSync(path);
        return true;
    }
    catch {
        try {
            unlinkSync(path);
        }
        catch {
            // Best effort only; the temp file lives in the 0700 auth-snapshots directory.
        }
        return false;
    }
}

/**
 * Write decrypted storage-state bytes to the pre-named 0600 temp file ahead of `state load`.
 * `wx` refuses to overwrite, so a colliding temp name can never silently reuse stale bytes.
 */
export function writeCheckpointTempFile(path, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        return "Refusing to write an empty storage-state temp file.";
    }
    try {
        mkdirSync(getCheckpointDirectory(), { mode: 0o700, recursive: true });
        writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
        return undefined;
    }
    catch (error) {
        // Path-free on purpose: this text reaches model-visible results and the raw fs error message
        // embeds the absolute temp path. A stable errno-style category keeps it debuggable instead.
        const rawCode = error instanceof Error && typeof error.code === "string" ? error.code : "";
        const category = /^[A-Za-z0-9_-]{1,32}$/.test(rawCode) ? rawCode.toLowerCase() : "unknown";
        return `failed to write checkpoint temp file: ${category}`;
    }
}

/**
 * Best-effort reap of stale `tmp-*.state` temp files left behind by crashed restores: anything
 * older than one hour is secure-deleted. Every failure is swallowed — reaping must never throw or
 * block the checkpoint gate, and recent temps (a live restore's file is seconds old) are untouched.
 */
export function reapStaleCheckpointTempFiles({ env = process.env, maxAgeMs = 3_600_000, nowMs = Date.now() } = {}) {
    const reaped = [];
    try {
        const directory = getCheckpointDirectory(env);
        if (!existsSync(directory)) {
            return reaped;
        }
        for (const entry of readdirSync(directory)) {
            if (!entry.startsWith("tmp-") || !entry.endsWith(".state")) {
                continue;
            }
            try {
                const stats = lstatSync(join(directory, entry));
                if (stats.isFile() && nowMs - stats.mtimeMs > maxAgeMs && secureDeleteFile(join(directory, entry))) {
                    reaped.push(entry);
                }
            }
            catch {
                // Best effort per file.
            }
        }
    }
    catch {
        // Best effort overall: an uninspectable snapshot directory must never block a restore.
    }
    return reaped;
}
