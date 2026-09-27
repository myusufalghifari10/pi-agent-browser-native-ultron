// local patch: encrypted credential vault (PATCHES.md P11).
//
// Why this exists: the wrapper redacts secrets aggressively, which also means the agent cannot
// authenticate anywhere. Upstream `agent-browser auth save/login` stores profile credentials, but it
// has no room for TOTP seeds, cards, or addresses, and it gives the wrapper no place to enforce an
// exact-origin binding. This store is therefore wrapper-owned and deliberately narrow:
//
//   - one encrypted JSON file, AES-256-GCM, key from a 0600 key file (or an optional passphrase)
//   - entries are bound to an EXACT origin (scheme + host + port); nothing is domain-wide
//   - metadata (handle, origin, username, label) is visible; secrets are only ever read to be filled
//   - every read validates file permissions before touching bytes, and refuses instead of repairing
//
// It never logs, returns, or embeds a secret in an error message.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VAULT_VERSION = 1;
export const VAULT_DIR_ENV = "PI_AGENT_BROWSER_VAULT_DIR";
export const VAULT_PASSPHRASE_ENV = "PI_AGENT_BROWSER_VAULT_PASSPHRASE";
export const VAULT_ENTRY_TYPES = ["login", "totp", "card", "address"];
export const VAULT_FILE_NAME = "vault.json";
export const VAULT_KEY_FILE_NAME = "vault.key";
const VAULT_AAD_PREFIX = "piab-credential-vault";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;
const SECRET_MAX_CHARS = 4096;

export function getVaultDirectory(env = process.env) {
    const override = typeof env?.[VAULT_DIR_ENV] === "string" ? env[VAULT_DIR_ENV].trim() : "";
    if (override) {
        return override;
    }
    const home = typeof env?.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir();
    return join(home, ".pi", "agent", "pi-agent-browser-native");
}

export function getVaultPaths(env = process.env) {
    const directory = getVaultDirectory(env);
    return {
        directory,
        keyFile: join(directory, VAULT_KEY_FILE_NAME),
        vaultFile: join(directory, VAULT_FILE_NAME),
    };
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

// Group/other readable means the ciphertext (and possibly key material) is exposed to other local
// users, so we fail closed with guidance instead of silently continuing or repairing the mode.
export function getVaultStorageSecurityError({ env = process.env } = {}) {
    const paths = getVaultPaths(env);
    for (const [label, path, expected] of [["directory", paths.directory, 0o700], ["key file", paths.keyFile, 0o600], ["vault file", paths.vaultFile, 0o600]]) {
        if (!existsSync(path)) {
            continue;
        }
        if (isSymlink(path)) {
            return `The credential vault ${label} at ${path} is a symlink. Replace it with a regular file/directory owned by you and retry.`;
        }
        const mode = fileMode(path);
        if (mode === undefined) {
            return `The credential vault ${label} at ${path} could not be inspected. Check the path and retry.`;
        }
        if ((mode & 0o077) !== 0) {
            return `The credential vault ${label} at ${path} has mode ${mode.toString(8)} (expected ${expected.toString(8)}). Run: chmod ${expected.toString(8)} ${path}`;
        }
    }
    return undefined;
}

function readKeyMaterial({ env = process.env, passphrase } = {}) {
    const resolvedPassphrase = typeof passphrase === "string" && passphrase.length > 0
        ? passphrase
        : (typeof env?.[VAULT_PASSPHRASE_ENV] === "string" && env[VAULT_PASSPHRASE_ENV].length > 0 ? env[VAULT_PASSPHRASE_ENV] : undefined);
    if (resolvedPassphrase) {
        return { mode: "passphrase", passphrase: resolvedPassphrase };
    }
    const paths = getVaultPaths(env);
    if (!existsSync(paths.keyFile)) {
        return { mode: "keyfile", missing: true };
    }
    const raw = readFileSync(paths.keyFile, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(raw)) {
        return { mode: "keyfile", invalid: true };
    }
    return { mode: "keyfile", key: Buffer.from(raw, "hex") };
}

function deriveKey({ mode, passphrase, salt }) {
    if (mode === "passphrase") {
        return scryptSync(passphrase, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEM });
    }
    return undefined;
}

// local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7) — the credential vault keeps its
// historical 3-segment AAD byte-for-byte so existing vault.json files still decrypt; checkpoint
// envelopes are domain-separated so a checkpoint ciphertext can never be read as a vault payload
// (or vice versa) even though both use the same key.
function buildVaultAad(kdfMode) {
    return Buffer.from(`${VAULT_AAD_PREFIX}|${VAULT_VERSION}|${kdfMode}`);
}

function buildCheckpointAad(kdfMode) {
    return Buffer.from(`${VAULT_AAD_PREFIX}|checkpoint|${VAULT_VERSION}|${kdfMode}`);
}

function buildAad(domain, kdfMode) {
    return domain === "checkpoint" ? buildCheckpointAad(kdfMode) : buildVaultAad(kdfMode);
}

function encryptWithKey(key, plaintextBytes, aad) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);
    // final() must run before getAuthTag() — evaluation order matters here.
    const payload = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
    return {
        cipher: { alg: "aes-256-gcm", iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") },
        payload,
    };
}

function decryptWithKey(key, envelope, aad) {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.cipher.iv, "hex"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.cipher.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.payload, "base64")), decipher.final()]);
}

function ensureVaultDirectory(paths) {
    if (!existsSync(paths.directory)) {
        mkdirSync(paths.directory, { mode: 0o700, recursive: true });
        return;
    }
    const mode = fileMode(paths.directory);
    if (mode !== undefined && (mode & 0o700) !== 0o700) {
        mkdirSync(paths.directory, { mode: 0o700, recursive: true });
    }
}

function writeKeyFile(paths) {
    if (existsSync(paths.keyFile)) {
        return readKeyMaterial();
    }
    const key = randomBytes(KEY_BYTES);
    writeFileSync(paths.keyFile, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    return { mode: "keyfile", key };
}

/**
 * Read + decrypt the vault.
 * Returns a discriminated result; never throws for expected failure modes and never includes secrets.
 */
export function readVaultEntries({ env = process.env, passphrase } = {}) {
    const paths = getVaultPaths(env);
    if (!existsSync(paths.vaultFile)) {
        return { status: "empty", entries: [], path: paths.vaultFile };
    }
    const securityError = getVaultStorageSecurityError({ env });
    if (securityError) {
        return { status: "insecure", error: securityError, path: paths.vaultFile };
    }
    let envelope;
    try {
        envelope = JSON.parse(readFileSync(paths.vaultFile, "utf8"));
    }
    catch {
        return { status: "corrupt", error: `The credential vault at ${paths.vaultFile} is not valid JSON. Restore it from a backup or delete it to start over (that discards every saved login).`, path: paths.vaultFile };
    }
    if (!envelope || envelope.version !== VAULT_VERSION || typeof envelope.payload !== "string" || typeof envelope.cipher?.iv !== "string" || typeof envelope.cipher?.tag !== "string") {
        return { status: "corrupt", error: `The credential vault at ${paths.vaultFile} has an unsupported or incomplete format (expected version ${VAULT_VERSION}).`, path: paths.vaultFile };
    }
    const keyMaterial = readKeyMaterial({ env, passphrase });
    if (keyMaterial.missing) {
        return { status: "missing-key", error: `The vault key file ${paths.keyFile} is missing, so the saved credentials cannot be decrypted. Restore it, or delete ${paths.vaultFile} to start over.`, path: paths.vaultFile };
    }
    if (keyMaterial.invalid) {
        return { status: "missing-key", error: `The vault key file ${paths.keyFile} does not contain a 64-character hex key. Restore it, or delete ${paths.vaultFile} to start over.`, path: paths.vaultFile };
    }
    const kdfMode = envelope.kdf?.mode === "passphrase" ? "passphrase" : "keyfile";
    const salt = typeof envelope.kdf?.salt === "string" ? Buffer.from(envelope.kdf.salt, "hex") : undefined;
    const key = kdfMode === "passphrase"
        ? deriveKey({ mode: "passphrase", passphrase: keyMaterial.passphrase, salt })
        : keyMaterial.key;
    if (!key) {
        return { status: "locked", error: `The credential vault at ${paths.vaultFile} needs a passphrase. Set ${VAULT_PASSPHRASE_ENV} for this process and retry.`, path: paths.vaultFile };
    }
    try {
        const plaintext = decryptWithKey(key, envelope, buildVaultAad(kdfMode)).toString("utf8");
        const parsed = JSON.parse(plaintext);
        const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter(isVaultEntryShape) : [];
        return { status: "ok", entries, path: paths.vaultFile, keyMode: kdfMode, updatedAtMs: envelope.updatedAtMs };
    }
    catch {
        return { status: "locked", error: `The credential vault at ${paths.vaultFile} could not be decrypted: the key or passphrase does not match. Fix the key, or delete the file to start over (that discards every saved login).`, path: paths.vaultFile };
    }
}

export function writeVaultEntries(entries, { env = process.env, passphrase } = {}) {
    const paths = getVaultPaths(env);
    ensureVaultDirectory(paths);
    const keyMaterial = readKeyMaterial({ env, passphrase });
    if (keyMaterial.mode === "passphrase" && !keyMaterial.passphrase) {
        return { status: "locked", error: `Writing the vault needs a passphrase. Set ${VAULT_PASSPHRASE_ENV} for this process and retry.` };
    }
    let key;
    let kdf;
    if (keyMaterial.mode === "passphrase") {
        const salt = randomBytes(16);
        key = deriveKey({ mode: "passphrase", passphrase: keyMaterial.passphrase, salt });
        kdf = { mode: "passphrase", salt: salt.toString("hex"), n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
    }
    else if (keyMaterial.key) {
        key = keyMaterial.key;
        kdf = { mode: "keyfile" };
    }
    else {
        const created = writeKeyFile(paths);
        if (!created.key) {
            return { status: "error", error: `Could not create the vault key file at ${paths.keyFile}.` };
        }
        key = created.key;
        kdf = { mode: "keyfile" };
    }
    const plaintext = Buffer.from(JSON.stringify({ entries: entries.filter(isVaultEntryShape) }), "utf8");
    const encrypted = encryptWithKey(key, plaintext, buildVaultAad(kdf.mode));
    const envelope = {
        cipher: encrypted.cipher,
        kdf,
        payload: encrypted.payload.toString("base64"),
        updatedAtMs: Date.now(),
        version: VAULT_VERSION,
    };
    const temporary = `${paths.vaultFile}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temporary, paths.vaultFile);
    }
    catch (error) {
        try {
            if (existsSync(temporary)) {
                unlinkSync(temporary);
            }
        }
        catch { /* best effort */ }
        return { status: "error", error: `Could not write the credential vault at ${paths.vaultFile}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { status: "ok", path: paths.vaultFile, count: entries.length };
}

/**
 * Read-modify-write helper. `mutator(entries)` returns the next entries array, or a string to abort
 * with that message.
 */
export function mutateVaultEntries(mutator, options = {}) {
    const read = readVaultEntries(options);
    if (read.status !== "ok" && read.status !== "empty") {
        return { status: read.status, error: read.error };
    }
    const next = mutator([...read.entries]);
    if (typeof next === "string") {
        return { status: "rejected", error: next };
    }
    const written = writeVaultEntries(next, options);
    if (written.status !== "ok") {
        return written;
    }
    return { status: "ok", entries: next, path: written.path };
}

export function isVaultEntryShape(entry) {
    return Boolean(entry)
        && typeof entry === "object"
        && typeof entry.id === "string"
        && entry.id.length > 0
        && typeof entry.handle === "string"
        && entry.handle.length > 0
        && VAULT_ENTRY_TYPES.includes(entry.type)
        && typeof entry.origin === "string"
        && entry.origin.length > 0;
}

export function createVaultEntryId() {
    return `vault-${randomBytes(8).toString("hex")}`;
}

/** Exact origin only: scheme + host + port, lowercased, no path/query/fragment. */
export function normalizeVaultOrigin(value) {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === "about:blank") {
        return "about:blank";
    }
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return undefined;
        }
        return `${url.protocol}//${url.host}`.toLowerCase();
    }
    catch {
        return undefined;
    }
}

export function sanitizeVaultSecret(value) {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    if (value.length > SECRET_MAX_CHARS) {
        return undefined;
    }
    // Strip a trailing newline from piped input, keep interior whitespace intact.
    return value.replace(/\r?\n$/, "");
}

export function normalizeVaultHandle(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed)) {
        return undefined;
    }
    return trimmed;
}

export function findVaultEntries(entries, { handle, origin, type } = {}) {
    return entries.filter((entry) => {
        if (handle && entry.handle !== handle) {
            return false;
        }
        if (origin && entry.origin !== origin) {
            return false;
        }
        if (type && entry.type !== type) {
            return false;
        }
        return true;
    });
}

/** Metadata projection for model-visible output: never includes a secret. */
export function describeVaultEntry(entry) {
    return {
        hasOtp: typeof entry.otpSeed === "string" && entry.otpSeed.length > 0,
        hasSecret: typeof entry.secret === "string" && entry.secret.length > 0,
        handle: entry.handle,
        id: entry.id,
        label: entry.label,
        lastUsedAtMs: entry.lastUsedAtMs,
        origin: entry.origin,
        type: entry.type,
        updatedAtMs: entry.updatedAtMs,
        username: entry.username,
    };
}

export function describeVaultEntries(entries) {
    return entries.map(describeVaultEntry).sort((left, right) => `${left.origin}${left.handle}`.localeCompare(`${right.origin}${right.handle}`));
}

export function getVaultStatus({ env = process.env } = {}) {
    const paths = getVaultPaths(env);
    const read = readVaultEntries({ env });
    const securityError = getVaultStorageSecurityError({ env });
    return {
        directory: paths.directory,
        entryCount: read.status === "ok" ? read.entries.length : 0,
        exists: existsSync(paths.vaultFile),
        keyMode: read.keyMode ?? (existsSync(paths.keyFile) ? "keyfile" : "unset"),
        securityError,
        status: read.status,
        statusError: read.error,
        vaultFile: paths.vaultFile,
    };
}

// local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7). Raw-byte encrypt/decrypt with the
// SAME key material and envelope format as the credential vault, so consumers that store bytes other
// than vault entries (the checkpoint store) reuse this module's crypto instead of re-implementing it.
// `domain` selects the AAD: the default keeps the legacy credential binding; "checkpoint" is
// domain-separated. Returns a discriminated result and never throws for expected failure modes.
export function encryptVaultBytes(plaintextBytes, { env = process.env, passphrase, domain = "credential" } = {}) {
    if (!Buffer.isBuffer(plaintextBytes)) {
        return { status: "error", error: "encryptVaultBytes needs the plaintext as a Buffer." };
    }
    const paths = getVaultPaths(env);
    ensureVaultDirectory(paths);
    const keyMaterial = readKeyMaterial({ env, passphrase });
    if (keyMaterial.mode === "passphrase" && !keyMaterial.passphrase) {
        return { status: "locked", error: `Writing the vault needs a passphrase. Set ${VAULT_PASSPHRASE_ENV} for this process and retry.` };
    }
    let key;
    let kdf;
    if (keyMaterial.mode === "passphrase") {
        const salt = randomBytes(16);
        key = deriveKey({ mode: "passphrase", passphrase: keyMaterial.passphrase, salt });
        kdf = { mode: "passphrase", salt: salt.toString("hex"), n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
    }
    else if (keyMaterial.key) {
        key = keyMaterial.key;
        kdf = { mode: "keyfile" };
    }
    else {
        const created = writeKeyFile(paths);
        if (!created.key) {
            return { status: "error", error: `Could not create the vault key file at ${paths.keyFile}.` };
        }
        key = created.key;
        kdf = { mode: "keyfile" };
    }
    const encrypted = encryptWithKey(key, plaintextBytes, buildAad(domain, kdf.mode));
    return { status: "ok", envelope: { cipher: encrypted.cipher, kdf, payload: encrypted.payload.toString("base64") }, kdfMode: kdf.mode };
}

export function decryptVaultBytes(envelope, { env = process.env, passphrase, domain = "credential" } = {}) {
    if (!envelope || typeof envelope !== "object" || typeof envelope.payload !== "string" || typeof envelope.cipher?.iv !== "string" || typeof envelope.cipher?.tag !== "string") {
        return { status: "invalid-envelope", error: "The encrypted payload has an unsupported or incomplete format." };
    }
    const paths = getVaultPaths(env);
    const keyMaterial = readKeyMaterial({ env, passphrase });
    if (keyMaterial.missing) {
        return { status: "missing-key", error: `The vault key file ${paths.keyFile} is missing, so the encrypted payload cannot be decrypted.` };
    }
    if (keyMaterial.invalid) {
        return { status: "missing-key", error: `The vault key file ${paths.keyFile} does not contain a 64-character hex key.` };
    }
    const kdfMode = envelope.kdf?.mode === "passphrase" ? "passphrase" : "keyfile";
    const salt = typeof envelope.kdf?.salt === "string" ? Buffer.from(envelope.kdf.salt, "hex") : undefined;
    const key = kdfMode === "passphrase"
        ? deriveKey({ mode: "passphrase", passphrase: keyMaterial.passphrase, salt })
        : keyMaterial.key;
    if (!key) {
        return { status: "locked", error: `The encrypted payload needs a passphrase. Set ${VAULT_PASSPHRASE_ENV} for this process and retry.` };
    }
    try {
        return { status: "ok", bytes: decryptWithKey(key, envelope, buildAad(domain, kdfMode)) };
    }
    catch {
        return { status: "locked", error: "The encrypted payload could not be decrypted: the key or passphrase does not match." };
    }
}
