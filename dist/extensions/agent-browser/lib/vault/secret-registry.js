// local patch: session-scoped exact-secret registry (PATCHES.md P12).
//
// Why this exists: upstream `agent-browser auth save --password-stdin` (and our vault) can put a real
// secret into a live browser session. The wrapper's field-name redaction would miss that value if it
// came back through page text, a console message, or a spill, because the value is not labelled.
// Registering the exact value lets every presentation path scrub it by identity.
//
// The registry is memory-only and process-scoped. It never returns values to callers that build
// model-visible output, and its audit surface exposes lengths, never the secret.
const registered = new Map();
const MIN_SECRET_LENGTH = 4;

export function registerVaultSecret(value, metadata = {}) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
        return false;
    }
    registered.set(value, {
        handle: typeof metadata.handle === "string" ? metadata.handle : undefined,
        origin: typeof metadata.origin === "string" ? metadata.origin : undefined,
        registeredAtMs: Date.now(),
        source: typeof metadata.source === "string" ? metadata.source : "vault",
    });
    return true;
}

export function unregisterVaultSecret(value) {
    return registered.delete(value);
}

export function clearVaultSecrets() {
    const count = registered.size;
    registered.clear();
    return count;
}

export function getVaultSecretCount() {
    return registered.size;
}

/** Values only, for scrubbing. Never render this array. */
export function getVaultSecretValues() {
    return [...registered.keys()];
}

/** Metadata projection: safe for `details`. */
export function listVaultSecretAudit() {
    return [...registered.entries()].map(([value, metadata]) => ({
        handle: metadata.handle,
        length: value.length,
        origin: metadata.origin,
        registeredAtMs: metadata.registeredAtMs,
        source: metadata.source,
    }));
}

export function scrubVaultSecrets(text) {
    if (typeof text !== "string" || text.length === 0 || registered.size === 0) {
        return text;
    }
    let output = text;
    for (const value of registered.keys()) {
        if (output.includes(value)) {
            output = output.split(value).join("[REDACTED]");
        }
    }
    return output;
}

export function scrubVaultSecretValues(value, depth = 0) {
    if (depth > 12) {
        return value;
    }
    if (typeof value === "string") {
        return scrubVaultSecrets(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => scrubVaultSecretValues(item, depth + 1));
    }
    if (value && typeof value === "object") {
        const output = {};
        for (const [key, item] of Object.entries(value)) {
            output[key] = scrubVaultSecretValues(item, depth + 1);
        }
        return output;
    }
    return value;
}
