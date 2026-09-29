// local patch: `cdp` input mode validator + compiler (wave 14).
//
// The wrapper is a pass-through: every action is exactly one `spawn("agent-browser", argv)`, so the
// only thing it can do on a model's behalf is reject, validate or format. "Literally anything" is
// therefore only reachable through a channel that BYPASSES the CLI command surface — raw CDP. This
// module is the front door for that channel and does exactly two things: validate a `cdp` payload and
// compile it into a plain plan object.
//
// It is deliberately PURE: no fs, no net, no WebSocket, no clock, no dispatch. The endpoint lookup
// (`get cdp-url`) and the socket itself belong to the host handler; everything here is shape
// validation that can run offline and be pinned by a test.
//
// Why the bounds: a raw escape hatch is exactly the place where an unbounded model-supplied array
// turns into a hung socket or a 4 GB payload, so commands are capped, the total time budget is
// capped, and heavy payloads are pushed to files (artifact/artifactPath) rather than into the model's
// context. Validation failures are returned as `{ error }` — never thrown — so the caller can turn
// them into a normal validation-error result.
export const CDP_MAX_COMMANDS = 32;
export const CDP_MAX_SESSION_CHARS = 64;
export const CDP_MAX_TIMEOUT_MS = 120000;
export const CDP_DEFAULT_TIMEOUT_MS = 30000;
export const CDP_ALLOWED_FIELDS = new Set(["session", "commands", "artifactPath", "timeoutMs"]);
export const CDP_ALLOWED_COMMAND_FIELDS = new Set(["method", "params", "artifact"]);

// CDP methods are `Domain.command`; the dot is mandatory because it is the only thing distinguishing
// a method from an unknown option, and a bare word would silently be accepted by nothing.
const CDP_METHOD_PATTERN = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;

// An artifact lands at `<artifactPath>/<artifact>`, so the name must stay a single path segment:
// no separator, no NUL, no traversal. This is a trust boundary (the model supplies both strings).
const CDP_ARTIFACT_PATTERN = /^[A-Za-z0-9._-]+$/;

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateSession(value) {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: "cdp.session must be a non-empty string when provided." };
    }
    const trimmed = value.trim();
    if (trimmed.length > CDP_MAX_SESSION_CHARS) {
        return { error: `cdp.session must be ${CDP_MAX_SESSION_CHARS} characters or fewer.` };
    }
    if (/\s/.test(trimmed) || trimmed.includes("\u0000")) {
        return { error: "cdp.session must not contain whitespace or NUL bytes." };
    }
    return { value: trimmed };
}

function validateTimeoutMs(value) {
    if (value === undefined) {
        return { value: CDP_DEFAULT_TIMEOUT_MS };
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return { error: "cdp.timeoutMs must be a positive integer when provided." };
    }
    if (value > CDP_MAX_TIMEOUT_MS) {
        return { error: `cdp.timeoutMs must be ${CDP_MAX_TIMEOUT_MS} or less.` };
    }
    return { value };
}

function validateArtifact(value, label) {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `${label} must be a non-empty string when provided.` };
    }
    const trimmed = value.trim();
    if (!CDP_ARTIFACT_PATTERN.test(trimmed) || trimmed === "." || trimmed === "..") {
        return { error: `${label} must be a single file name (letters, digits, dot, dash or underscore; no path separators or "..").` };
    }
    return { value: trimmed };
}

function validateCommand(command, index) {
    if (!isPlainObject(command)) {
        return { error: `cdp.commands[${index}] must be an object with a method.` };
    }
    const unknownField = Object.keys(command).find((field) => !CDP_ALLOWED_COMMAND_FIELDS.has(field));
    if (unknownField) {
        return { error: `cdp.commands[${index}] does not support ${unknownField}; supported command fields are ${[...CDP_ALLOWED_COMMAND_FIELDS].join(", ")}.` };
    }
    const { method } = command;
    if (typeof method !== "string" || method.trim().length === 0) {
        return { error: `cdp.commands[${index}].method must be a non-empty string such as "Runtime.evaluate".` };
    }
    // No trimming: a method goes on the wire verbatim, so "Runtime.evaluate " must fail loudly rather
    // than be silently repaired into a different method than the caller believed it sent.
    if (/\s/.test(method) || method.includes("\u0000")) {
        return { error: `cdp.commands[${index}].method must not contain whitespace or NUL bytes.` };
    }
    if (!CDP_METHOD_PATTERN.test(method)) {
        return { error: `cdp.commands[${index}].method must be a CDP method of the form "Domain.command" (for example "Runtime.evaluate"), not ${JSON.stringify(method)}.` };
    }
    const value = { method };
    if (command.params !== undefined) {
        if (!isPlainObject(command.params)) {
            return { error: `cdp.commands[${index}].params must be an object when provided, not an array, null or scalar.` };
        }
        // Passed through untouched on purpose: numeric JSON values must stay numbers, and the CDP
        // protocol owns the shape of params.
        value.params = command.params;
    }
    const artifact = validateArtifact(command.artifact, `cdp.commands[${index}].artifact`);
    if (artifact.error) {
        return artifact;
    }
    if (artifact.value !== undefined) {
        value.artifact = artifact.value;
    }
    return { value };
}

function validateCommands(commands) {
    if (commands === undefined) {
        return { error: `cdp requires a commands array with 1-${CDP_MAX_COMMANDS} CDP methods, for example [{ "method": "Runtime.evaluate", "params": { "expression": "document.title", "returnByValue": true } }].` };
    }
    if (!Array.isArray(commands)) {
        return { error: "cdp.commands must be an array of { method, params?, artifact? } objects." };
    }
    if (commands.length === 0) {
        return { error: "cdp.commands must contain at least one command; an empty array would open a CDP connection to do nothing." };
    }
    if (commands.length > CDP_MAX_COMMANDS) {
        return { error: `cdp.commands must contain ${CDP_MAX_COMMANDS} commands or fewer (got ${commands.length}); split the work across calls.` };
    }
    const normalized = [];
    for (const [index, command] of commands.entries()) {
        const result = validateCommand(command, index);
        if (result.error) {
            return result;
        }
        normalized.push(result.value);
    }
    return { value: normalized };
}

/**
 * Validate a `cdp` payload. Returns `{ value }` on success and `{ error }` on any violation — never
 * throws. `sessionMode` is the caller's top-level agent_browser field, not part of the `cdp` object,
 * so it is passed in as context: naming a session AND asking for a fresh launch is a contradiction
 * (`--session` would win and `fresh` would be silently ignored).
 */
export function normalizeCdpInput(input, { sessionMode } = {}) {
    if (!isPlainObject(input)) {
        return { error: "cdp must be an object with a commands array." };
    }
    const unknownField = Object.keys(input).find((field) => !CDP_ALLOWED_FIELDS.has(field));
    if (unknownField) {
        if (unknownField === "sessionMode") {
            return { error: "cdp does not support sessionMode; use the top-level agent_browser sessionMode field instead." };
        }
        return { error: `cdp does not support ${unknownField}; supported fields are ${[...CDP_ALLOWED_FIELDS].join(", ")}.` };
    }
    const session = validateSession(input.session);
    if (session.error) {
        return session;
    }
    if (session.value !== undefined && sessionMode === "fresh") {
        return { error: "cdp.session cannot be combined with sessionMode \"fresh\": --session names the session and fresh would be ignored. Drop cdp.session to use a fresh managed session, or keep the session and drop sessionMode." };
    }
    const commands = validateCommands(input.commands);
    if (commands.error) {
        return commands;
    }
    const artifactPath = validateArtifact(input.artifactPath, "cdp.artifactPath");
    if (artifactPath.error) {
        return artifactPath;
    }
    const timeoutMs = validateTimeoutMs(input.timeoutMs);
    if (timeoutMs.error) {
        return timeoutMs;
    }
    const value = { commands: commands.value, timeoutMs: timeoutMs.value };
    if (session.value !== undefined) {
        value.session = session.value;
    }
    if (artifactPath.value !== undefined) {
        value.artifactPath = artifactPath.value;
    }
    return { value };
}

/**
 * Compile a normalized plan into the frozen host shape. Pure mapping: no I/O, no dispatch, no
 * validation (that already happened in normalizeCdpInput). Optional keys are omitted rather than
 * set to undefined so the host can test them by presence.
 */
export function compileAgentBrowserCdp(input) {
    const plan = isPlainObject(input) ? input : {};
    const compiled = { kind: "cdp", commands: plan.commands ?? [], timeoutMs: plan.timeoutMs ?? CDP_DEFAULT_TIMEOUT_MS };
    if (plan.session !== undefined) {
        compiled.session = plan.session;
    }
    if (plan.artifactPath !== undefined) {
        compiled.artifactPath = plan.artifactPath;
    }
    return compiled;
}
