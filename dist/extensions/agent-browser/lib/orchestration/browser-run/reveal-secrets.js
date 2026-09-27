// local patch: explicit, bounded secret reveal for diagnostics (PATCHES.md P13).
//
// Why this exists: the wrapper redacts `authorization`/`cookie`/`apikey` everywhere, which is correct
// by default but makes auth debugging impossible - the one job a browser tool is genuinely needed for.
// The fix is an explicit, per-call, narrowly scoped opt-in rather than a global switch:
//   - only header names the caller literally lists (lowercase, max 8) are revealed
//   - only for network-read commands (`network requests`, `network request <id>`)
//   - the result carries a loud warning, and spills are suppressed so the revealed value cannot be
//     written to disk by the wrapper
export const REVEAL_SECRETS_MAX_FIELDS = 8;
export const REVEAL_SECRETS_HEADER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizeRevealSecrets(input) {
    if (input === undefined || input === null) {
        return {};
    }
    if (typeof input !== "object" || Array.isArray(input)) {
        return { error: "revealSecrets must be an object such as { headers: [\"authorization\"] }." };
    }
    const rawHeaders = input.headers === undefined ? [] : input.headers;
    if (!Array.isArray(rawHeaders)) {
        return { error: "revealSecrets.headers must be an array of header names." };
    }
    if (rawHeaders.length === 0) {
        return { error: "revealSecrets.headers must name at least one header, for example [\"authorization\"]." };
    }
    if (rawHeaders.length > REVEAL_SECRETS_MAX_FIELDS) {
        return { error: `revealSecrets.headers accepts at most ${REVEAL_SECRETS_MAX_FIELDS} names.` };
    }
    const headers = [];
    for (const header of rawHeaders) {
        if (typeof header !== "string") {
            return { error: "revealSecrets.headers entries must be strings." };
        }
        const normalized = header.trim().toLowerCase();
        if (!REVEAL_SECRETS_HEADER_PATTERN.test(normalized) || !/^[a-z]/.test(normalized)) {
            return { error: `revealSecrets header "${header}" is not a header name.` };
        }
        if (!headers.includes(normalized)) {
            headers.push(normalized);
        }
    }
    let urlFilter;
    if (input.urlFilter !== undefined) {
        if (typeof input.urlFilter !== "string" || !input.urlFilter.trim()) {
            return { error: "revealSecrets.urlFilter must be a non-empty string when provided." };
        }
        if (input.urlFilter.length > 200) {
            return { error: "revealSecrets.urlFilter must be 200 characters or fewer." };
        }
        urlFilter = input.urlFilter.trim();
    }
    return { value: { headers, urlFilter } };
}

/**
 * Scope guard: revealing is only meaningful for network reads, so anything else is refused before the
 * process starts rather than silently ignored.
 */
export function getRevealSecretsScopeError(commandTokens, reveal) {
    if (!reveal) {
        return undefined;
    }
    const [command, subcommand] = Array.isArray(commandTokens) ? commandTokens : [];
    if (command !== "network" || (subcommand !== "requests" && subcommand !== "request")) {
        return `revealSecrets only applies to \`network requests\` and \`network request <id>\`. Use it on those reads, or drop the field - other commands stay redacted.`;
    }
    if (subcommand === "requests" && !reveal.urlFilter) {
        return `revealSecrets on \`network requests\` also requires urlFilter, so revealed headers are limited to the rows you asked about. Example: { "revealSecrets": { "headers": ["authorization"], "urlFilter": "/api/" } }.`;
    }
    return undefined;
}

export function describeRevealSecrets(reveal, { applied = false, matchedRows = 0, spillSuppressed = false } = {}) {
    return {
        applied,
        headerNames: reveal?.headers ?? [],
        matchedRows,
        spillSuppressed,
        urlFilter: reveal?.urlFilter,
    };
}

export function buildRevealSecretsWarning(reveal, { matchedRows = 0 } = {}) {
    const names = (reveal?.headers ?? []).join(", ");
    const scope = reveal?.urlFilter ? ` rows matching ${reveal.urlFilter}` : " the requested row";
    return `Secrets revealed by explicit request: ${names} on ${matchedRows}${scope}. This value normally stays redacted; do not share or export this transcript, and re-read without revealSecrets when you are done. No spill file was written for this call.`;
}
