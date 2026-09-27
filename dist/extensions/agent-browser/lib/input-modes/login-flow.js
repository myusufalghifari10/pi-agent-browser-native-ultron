// local patch: deterministic login preset (PATCHES.md P15).
//
// Why this exists: signing in is the most common reason an agent needs a browser, and the naive way to
// do it writes the password into an argv token (`fill @e2 "hunter2"`), which is visible in the process
// table and in the wrapper's own command echo. This compiler therefore builds one batch plan in which a
// credential is written by an in-page script delivered as a base64 `eval -b` row: the payload lives in
// the PIPED batch stdin, never in process arguments.
//
// What this module deliberately does NOT do: it never reads the vault, never mints a TOTP code, never
// redacts, and never decides whether a fill is allowed. The caller owns the vault, the exact-origin
// binding and the redaction registry; this module only decides the shape of the plan. Rows that carry a
// credential are marked `carriesSecret` so the caller can redact the echoed compiled plan.
import { isRecord } from "../parsing.js";

export const LOGIN_FLOW_MAX_TIMEOUT_MS = 120_000;
const LOGIN_FLOW_DEFAULT_TIMEOUT_MS = 30_000;
const LOGIN_FLOW_READINESS = "domcontentloaded";
const LOGIN_FLOW_FIELDS = new Set([
    "hasSecret",
    "handle",
    "loadStatePath",
    "origin",
    "otp",
    "otpSeed",
    "otpSelector",
    "password",
    "passwordSelector",
    "saveStatePath",
    "session",
    "settleAfterEachStep",
    "submit",
    "submitSelector",
    "timeoutMs",
    "totp",
    "url",
    "username",
    "usernameSelector",
    "waitForText",
    "waitForUrl",
]);
// `handle` and `otpSeed` are host-routing values: the host uses them to find/derive a credential before
// compiling, and they must survive normalization so the host's second pass sees them. `hasSecret` is a
// derived field this module emits, so accepting it keeps `normalizeLoginFlowInput` idempotent - the host
// deliberately re-normalizes the already-normalized input it receives from the input planner.

function getOptionalLoginString(input, field) {
    const value = input[field];
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `login.${field} must be a non-empty string when provided.` };
    }
    return { value: value.trim() };
}

function getOptionalLoginBoolean(input, field) {
    const value = input[field];
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "boolean") {
        return { error: `login.${field} must be a boolean when provided.` };
    }
    return { value };
}

/** Comparison-only normalization: scheme + host + port, lowercased. Not exported - the vault owns origins. */
function normalizeComparableOrigin(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
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

export function normalizeLoginFlowInput(input) {
    if (!isRecord(input)) {
        return { error: "login must be an object." };
    }
    const unsupportedField = Object.keys(input).find((field) => !LOGIN_FLOW_FIELDS.has(field));
    if (unsupportedField) {
        return { error: `login does not support ${unsupportedField}; supported fields are ${[...LOGIN_FLOW_FIELDS].sort().join(", ")}.` };
    }
    const url = getOptionalLoginString(input, "url");
    if (url.error) {
        return { error: url.error };
    }
    const origin = getOptionalLoginString(input, "origin");
    if (origin.error) {
        return { error: origin.error };
    }
    const loadStatePath = getOptionalLoginString(input, "loadStatePath");
    if (loadStatePath.error) {
        return { error: loadStatePath.error };
    }
    const saveStatePath = getOptionalLoginString(input, "saveStatePath");
    if (saveStatePath.error) {
        return { error: saveStatePath.error };
    }
    const username = getOptionalLoginString(input, "username");
    if (username.error) {
        return { error: username.error };
    }
    const usernameSelector = getOptionalLoginString(input, "usernameSelector");
    if (usernameSelector.error) {
        return { error: usernameSelector.error };
    }
    const submitSelector = getOptionalLoginString(input, "submitSelector");
    if (submitSelector.error) {
        return { error: submitSelector.error };
    }
    const passwordSelector = getOptionalLoginString(input, "passwordSelector");
    if (passwordSelector.error) {
        return { error: passwordSelector.error };
    }
    const otpSelector = getOptionalLoginString(input, "otpSelector");
    if (otpSelector.error) {
        return { error: otpSelector.error };
    }
    const waitForUrl = getOptionalLoginString(input, "waitForUrl");
    if (waitForUrl.error) {
        return { error: waitForUrl.error };
    }
    const waitForText = getOptionalLoginString(input, "waitForText");
    if (waitForText.error) {
        return { error: waitForText.error };
    }
    const handle = getOptionalLoginString(input, "handle");
    if (handle.error) {
        return { error: handle.error };
    }
    // local patch (PATCHES.md P27): the flow may target one explicit upstream session.
    const session = getOptionalLoginString(input, "session");
    if (session.error) {
        return { error: session.error };
    }
    const otpSeed = getOptionalLoginString(input, "otpSeed");
    if (otpSeed.error) {
        return { error: otpSeed.error };
    }
    const rawPassword = input.password;
    if (rawPassword !== undefined && (typeof rawPassword !== "string" || rawPassword.length === 0)) {
        return { error: "login.password must be a non-empty string when provided." };
    }
    const rawOtp = input.otp;
    if (rawOtp !== undefined && (typeof rawOtp !== "string" || rawOtp.trim().length === 0)) {
        return { error: "login.otp must be a non-empty string when provided." };
    }
    const totp = getOptionalLoginBoolean(input, "totp");
    if (totp.error) {
        return { error: totp.error };
    }
    const submit = getOptionalLoginBoolean(input, "submit");
    if (submit.error) {
        return { error: submit.error };
    }
    const settleAfterEachStep = getOptionalLoginBoolean(input, "settleAfterEachStep");
    if (settleAfterEachStep.error) {
        return { error: settleAfterEachStep.error };
    }
    const timeoutMs = input.timeoutMs;
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
        return { error: "login.timeoutMs must be a positive integer when provided." };
    }
    if (typeof timeoutMs === "number" && timeoutMs > LOGIN_FLOW_MAX_TIMEOUT_MS) {
        return { error: `login.timeoutMs must be ${LOGIN_FLOW_MAX_TIMEOUT_MS} or less.` };
    }
    if (typeof origin.value === "string" && !normalizeComparableOrigin(origin.value)) {
        return { error: `login.origin must be an http(s) origin such as https://example.com, not "${origin.value}".` };
    }
    if (!url.value && !loadStatePath.value) {
        return { error: "login requires a url or a loadStatePath so the flow has a page to work on." };
    }
    if ((typeof rawPassword === "string" || typeof rawOtp === "string") && !origin.value) {
        return { error: "login.password and login.otp require login.origin, so the wrapper can refuse to fill the credential on a different site." };
    }
    if (totp.value === true && typeof rawOtp !== "string") {
        return { error: "login.totp requires login.otp: mint the current code from the saved authenticator key first and pass it as login.otp (it travels over the piped batch stdin, never in process arguments)." };
    }
    if (typeof saveStatePath.value === "string" && saveStatePath.value === loadStatePath.value) {
        return { error: "login.saveStatePath must differ from login.loadStatePath." };
    }
    if (origin.value && url.value && url.value !== "about:blank") {
        const originValue = normalizeComparableOrigin(origin.value);
        const urlOrigin = normalizeComparableOrigin(url.value);
        if (urlOrigin && originValue !== urlOrigin) {
            return { error: `login.origin (${originValue}) does not match login.url (${urlOrigin}); a credential may only be filled on its own origin.` };
        }
    }
    const hasSecret = typeof rawPassword === "string" || typeof rawOtp === "string" || typeof otpSeed.value === "string";
    const wantsSubmit = submit.value === undefined ? hasSecret : submit.value;
    return {
        value: {
            handle: handle.value,
            hasSecret,
            loadStatePath: loadStatePath.value,
            origin: origin.value,
            otp: typeof rawOtp === "string" ? rawOtp : undefined,
            otpSeed: otpSeed.value,
            otpSelector: otpSelector.value,
            password: typeof rawPassword === "string" ? rawPassword : undefined,
            passwordSelector: passwordSelector.value,
            saveStatePath: saveStatePath.value,
            session: session.value,
            settleAfterEachStep: settleAfterEachStep.value !== false,
            submit: wantsSubmit,
            submitSelector: submitSelector.value,
            timeoutMs: typeof timeoutMs === "number" ? timeoutMs : LOGIN_FLOW_DEFAULT_TIMEOUT_MS,
            totp: totp.value === true,
            url: url.value,
            username: username.value,
            usernameSelector: usernameSelector.value,
            waitForText: waitForText.value,
            waitForUrl: waitForUrl.value,
        },
    };
}

function toBase64(source) {
    return Buffer.from(source, "utf8").toString("base64");
}

/**
 * A token in an `eval` row (index >= 1) is the script payload: either the raw source or the base64 blob
 * produced by `toBase64`. Every other token is a plain argv operand, where a credential must never appear.
 */
function isEvalPayloadToken(step, tokenIndex) {
    const tokens = Array.isArray(step?.args) ? step.args : [];
    return tokens[0] === "eval" && tokenIndex >= 1;
}

/** Decode a token as a base64 eval payload; returns undefined when it is not valid base64. */
function decodeEvalPayload(token) {
    if (typeof token !== "string" || token.length === 0 || token.length % 4 !== 0) {
        return undefined;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
        return undefined;
    }
    try {
        const decoded = Buffer.from(token, "base64").toString("utf8");
        return decoded.length > 0 ? decoded : undefined;
    }
    catch {
        return undefined;
    }
}

/**
 * Verify where each credential actually ended up instead of trusting the `carriesSecret` flags this
 * module sets itself. Returns the set of step indexes that carry a credential inside an eval payload, or
 * an error when a credential would land in a plain argv operand (which the process table would expose).
 */
function locateEmbeddedSecrets(steps, secrets) {
    const usable = secrets.filter((secret) => typeof secret === "string" && secret.length > 0);
    if (usable.length === 0) {
        return { indexes: new Set() };
    }
    const indexes = new Set();
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
        const step = steps[stepIndex];
        const tokens = Array.isArray(step?.args) ? step.args : [];
        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
            const token = tokens[tokenIndex];
            if (typeof token !== "string" || token.length === 0) {
                continue;
            }
            const decoded = isEvalPayloadToken(step, tokenIndex) ? decodeEvalPayload(token) : undefined;
            const matched = usable.some((secret) => token.includes(secret) || (decoded ? decoded.includes(secret) : false));
            if (!matched) {
                continue;
            }
            if (!isEvalPayloadToken(step, tokenIndex)) {
                return {
                    error: `Refusing to compile: a credential would be written into a plain argv token in row ${stepIndex + 1} (${step.action ?? "unknown"}). Credentials may only travel inside an eval payload delivered over the piped batch stdin.`,
                };
            }
            indexes.add(stepIndex);
        }
    }
    return { indexes };
}

function buildSecretRow(fillScriptFor, { fields, submit }) {
    const script = fillScriptFor({ fields, submit });
    if (typeof script !== "string" || script.trim().length === 0) {
        return { error: "the page-fill script builder returned no script, so no credential can be filled safely." };
    }
    // `eval -b <base64>` is upstream's documented path for arbitrary JavaScript. The payload travels in
    // the piped batch stdin, so it is absent from the process table and from the wrapper's argv echo.
    return { args: ["eval", "-b", toBase64(script)] };
}

export function compileAgentBrowserLoginFlow(value, { fillScriptFor } = {}) {
    // The repo's shared `isRecord` accepts arrays (`typeof value === "object"`), so an array would
    // otherwise compile into a degenerate plan instead of being rejected as bad input.
    if (!isRecord(value) || Array.isArray(value)) {
        return { error: "login flow input must be normalized before compiling." };
    }
    const hasPassword = typeof value.password === "string" && value.password.length > 0;
    const hasOtp = typeof value.otp === "string" && value.otp.length > 0;
    if ((hasPassword || hasOtp) && typeof fillScriptFor !== "function") {
        return { error: "a login flow that fills a password or code needs the caller's page-fill script builder, so the credential never reaches an argv token." };
    }
    // A caller-supplied submit selector is an explicit choice, so the page script must not also press
    // its own submit control; otherwise the script submits and no extra click row is needed.
    const useScriptSubmit = hasPassword && value.submit !== false && typeof value.submitSelector !== "string";
    const steps = [];
    // local patch fix (P22): an `eval` row is a page transition as far as the wrapper's page-target
    // validation is concerned, so later content rows in the same batch need a live target. One `get url`
    // row after the credential scripts restores the verified target inside the same fail-fast batch;
    // without it the whole plan was refused with "The active page became unverified after a ...
    // script ... transition" and nothing ran at all.
    let scriptTransitioned = false;
    const pushStep = (action, args, options = {}) => {
        steps.push({
            action,
            args,
            carriesSecret: options.carriesSecret === true,
            generatedFrom: options.generatedFrom,
        });
    };
    if (value.loadStatePath) {
        pushStep("state", ["state", "load", value.loadStatePath], { generatedFrom: "loadStatePath" });
    }
    if (value.url) {
        pushStep("open", ["open", value.url], { generatedFrom: "url" });
    }
    pushStep("wait", ["wait", "--load", LOGIN_FLOW_READINESS], { generatedFrom: "loginFlow.readiness" });
    if (value.username) {
        if (value.usernameSelector) {
            pushStep("fill", ["fill", value.usernameSelector, value.username], { generatedFrom: "username" });
        }
        else {
            const row = buildSecretRow(fillScriptFor, {
                fields: [{ role: "username", value: value.username }],
                submit: false,
            });
            if (row.error) {
                return { error: row.error };
            }
            // The identifier is not a secret, so this row is not marked `carriesSecret`.
            pushStep("eval", row.args, { generatedFrom: "username" });
            scriptTransitioned = true;
        }
    }
    if (hasPassword) {
        const row = buildSecretRow(fillScriptFor, {
            fields: [{ role: "password", selector: value.passwordSelector, value: value.password }],
            submit: useScriptSubmit,
        });
        if (row.error) {
            return { error: row.error };
        }
        pushStep("eval", row.args, { carriesSecret: true, generatedFrom: "password" });
        scriptTransitioned = true;
    }
    if (hasOtp) {
        const row = buildSecretRow(fillScriptFor, {
            fields: [{ role: "otp", selector: value.otpSelector, value: value.otp }],
            submit: false,
        });
        if (row.error) {
            return { error: row.error };
        }
        pushStep("eval", row.args, { carriesSecret: true, generatedFrom: value.totp ? "totp" : "otp" });
        scriptTransitioned = true;
    }
    if (scriptTransitioned) {
        pushStep("get", ["get", "url"], { generatedFrom: "credential-reverify" });
    }
    const submitsViaSelector = value.submit === true && typeof value.submitSelector === "string" && (hasPassword || hasOtp);
    if (submitsViaSelector) {
        pushStep("click", ["click", value.submitSelector], { generatedFrom: "submit.selector" });
    }
    const submitted = useScriptSubmit || submitsViaSelector;
    if (submitted && value.settleAfterEachStep !== false) {
        // The destination document must be parsed before any assertion runs, otherwise a wait for the
        // new URL can pass while the page is still the old one.
        pushStep("wait", ["wait", "--load", LOGIN_FLOW_READINESS], { generatedFrom: "loginFlow.settleAfterEachStep" });
    }
    if (value.waitForUrl) {
        pushStep("wait", ["wait", "--url", value.waitForUrl], { generatedFrom: "waitForUrl" });
    }
    if (value.waitForText) {
        pushStep("wait", ["wait", "--text", value.waitForText], { generatedFrom: "waitForText" });
    }
    if (value.saveStatePath) {
        pushStep("state", ["state", "save", value.saveStatePath], { generatedFrom: "saveStatePath" });
    }
    // Content-verify the plan instead of trusting the flags above: `secretsEmbedded` must describe where
    // the credentials really are, and a credential outside an eval payload is a hard compile failure.
    const located = locateEmbeddedSecrets(steps, [value.password, value.otp]);
    if (located.error) {
        return { error: located.error };
    }
    for (let index = 0; index < steps.length; index += 1) {
        if (located.indexes.has(index)) {
            steps[index].carriesSecret = true;
        }
    }
    return {
        compiled: {
            args: ["batch", "--bail"],
            secretsEmbedded: located.indexes.size > 0,
            stdin: JSON.stringify(steps.map((step) => step.args)),
            steps,
        },
    };
}

export function describeLoginFlowPlan(compiled) {
    const steps = Array.isArray(compiled?.steps) ? compiled.steps : [];
    const secretRows = steps.filter((step) => step?.carriesSecret === true).length;
    const rows = steps.length;
    if (rows === 0) {
        return { rows: 0, secretRows: 0, summary: "Login flow plan is empty; nothing would run." };
    }
    const shape = steps.map((step) => step.action).join(" → ");
    return {
        rows,
        secretRows,
        // local patch: the singular form previously reused the plural verb ("1 row carry a credential").
        summary: `Login flow: ${rows} ${rows === 1 ? "row" : "rows"} (${shape}); ${secretRows === 1 ? "1 row carries" : `${secretRows} rows carry`} a credential inside the piped batch stdin (base64 eval payload), never in process arguments.`,
    };
}
