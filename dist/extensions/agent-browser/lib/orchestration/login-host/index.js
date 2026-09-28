// local patch: login preset host orchestration (PATCHES.md P22).
//
// Why this exists: the common authenticated flow (open a login page, type the identifier, fill the
// vault password, submit, wait for the destination, optionally save state) otherwise takes four tool
// calls and leaves the agent holding a password it must not have. Here the wrapper resolves the
// credential, compiles one fail-fast batch, and runs it through the ordinary browser pipeline so all
// existing guards, presentation and redaction still apply.
//
// The page script (not argv) carries the secret, and the origin is verified twice: once against the
// vault entry before compiling, and again inside the page by the fill script itself.
import { buildVaultFillScript, describeVaultFillFailure, parseVaultFillResult } from "../../vault/fill.js";
import { registerVaultSecret } from "../../vault/secret-registry.js";
import { findVaultEntries, normalizeVaultOrigin, readVaultEntries, sanitizeVaultSecret } from "../../vault/store.js";
import { compileAgentBrowserLoginFlow, describeLoginFlowPlan, normalizeLoginFlowInput } from "../../input-modes/login-flow.js";
import { getVaultUnlockState } from "../vault-host/index.js";

function buildLoginResult({ action, details = {}, isError = false, lines = [] }) {
    return {
        content: [{ text: lines.filter(Boolean).join("\n") || `login: ${action}`, type: "text" }],
        details: {
            categoryDetails: isError ? { failureCategory: "validation-error", resultCategory: "failure" } : { resultCategory: "success", successCategory: "completed" },
            login: { action, ...details },
        },
        isError,
    };
}

// local patch (PATCHES.md P27): route the flow's browser calls through one explicit session.
function withExplicitSession(dispatch, session) {
    if (typeof session !== "string" || session.length === 0) {
        return dispatch;
    }
    return (request = {}) => dispatch({ ...request, args: ["--session", session, ...(Array.isArray(request.args) ? request.args : [])] });
}

async function resolvePageOrigin(dispatch) {
    const result = await dispatch({ args: ["get", "url"] });
    const data = result?.details?.data;
    const url = typeof data?.url === "string" ? data.url : (typeof data?.result === "string" ? data.result : undefined);
    return url ? normalizeVaultOrigin(url) : undefined;
}

/**
 * The in-page fill script reports its own structured failure (`{ ok: false, reason: "field-not-found" }`),
 * but an `eval` row that merely RETURNS that object is still a successful batch step as far as the browser
 * pipeline is concerned, so nothing downstream ever inspects it. Without this the real cause was swallowed
 * twice over: a login whose password field was not on the page yet ran to the end and reported "Completed",
 * or - when a `waitForUrl`/`waitForText` was attached - failed much later on an unrelated timeout that said
 * nothing about the credential never being typed. Same class as a scripted click that only satisfies
 * uncommitted DOM state: the tool must not report success on an unverified interaction.
 *
 * Only a fill row carries `ok`/`reason`; any other eval payload is skipped, so a future non-fill eval in
 * this plan cannot be misread as a credential failure.
 */
function findFillScriptFailure(result) {
    const steps = Array.isArray(result?.details?.data) ? result.details.data : [];
    for (const step of steps) {
        if (step?.success === false) {
            continue;
        }
        const command = Array.isArray(step?.command) ? step.command : undefined;
        if (command?.[0] !== "eval") {
            continue;
        }
        const parsed = parseVaultFillResult(step?.result);
        if (parsed.ok || typeof parsed.reason !== "string") {
            continue;
        }
        return parsed;
    }
    return undefined;
}

export async function handleLoginHostInput({ compiled, dispatch }) {
    const normalized = normalizeLoginFlowInput(compiled);
    if (normalized.error || !normalized.value) {
        return buildLoginResult({ action: "plan", details: { reason: "invalid-input" }, isError: true, lines: [normalized.error ?? "Invalid login input."] });
    }
    const input = normalized.value;
    // local patch (PATCHES.md P27): every page call in this flow targets the requested session.
    const run = withExplicitSession(dispatch, input.session);
    let origin = input.origin ? normalizeVaultOrigin(input.origin) : undefined;
    if (input.origin && !origin) {
        return buildLoginResult({ action: "plan", details: { reason: "invalid-origin" }, isError: true, lines: [`The login origin "${input.origin}" is not a usable http(s) origin.`] });
    }
    const url = input.url ?? input.loadStatePath;
    if (!origin && url) {
        origin = normalizeVaultOrigin(url);
    }
    if (!origin) {
        origin = await resolvePageOrigin(run);
    }
    let entry = undefined;
    let secret = sanitizeVaultSecret(input.password);
    let otpSeed = sanitizeVaultSecret(input.otpSeed);
    const wantsSecret = Boolean(input.password || input.totp || input.handle);
    if (wantsSecret && !secret) {
        const unlock = getVaultUnlockState();
        const read = readVaultEntries(unlock.unlocked ? { passphrase: unlock.passphrase } : {});
        if (read.status === "ok") {
            const matches = input.handle
                ? findVaultEntries(read.entries, { handle: input.handle })
                : findVaultEntries(read.entries, { origin, type: "login" });
            entry = matches[0];
            if (entry) {
                secret = sanitizeVaultSecret(entry.secret);
                otpSeed = sanitizeVaultSecret(entry.otpSeed);
            }
        }
        if (!secret) {
            return buildLoginResult({
                action: "plan",
                details: { origin, reason: read.status === "ok" ? "missing_entry" : read.status, requiresSave: true },
                isError: true,
                lines: [
                    `No vault login is available for ${origin ?? "the target page"} (${input.handle ? `handle ${input.handle}` : "no matching handle"}; store status ${read.status}).`,
                    `Save it first: vault { action: "save", handle: "<name>", type: "login", origin: "${origin ?? "https://example.com"}" } - the user is prompted in a masked dialog and the password never enters the conversation.`,
                ],
            });
        }
    }
    if (entry && origin && entry.origin !== origin) {
        return buildLoginResult({
            action: "plan",
            details: { entry: { handle: entry.handle, origin: entry.origin }, origin, reason: "origin-mismatch" },
            isError: true,
            lines: [`Refused: vault entry ${entry.handle} is bound to ${entry.origin}, not ${origin}. Nothing was typed or opened.`],
        });
    }
    if (secret && origin) {
        registerVaultSecret(secret, { handle: entry?.handle ?? input.handle, origin, source: "login-flow" });
    }
    const compiledFlow = compileAgentBrowserLoginFlow({ ...input, origin, otpSeed, password: secret, username: input.username ?? entry?.username }, {
        fillScriptFor: ({ fields, submit }) => buildVaultFillScript({ fields, origin, submit }),
    });
    if (compiledFlow.error || !compiledFlow.compiled) {
        return buildLoginResult({ action: "plan", details: { reason: "compile-failed" }, isError: true, lines: [compiledFlow.error ?? "The login flow could not be compiled."] });
    }
    const plan = describeLoginFlowPlan(compiledFlow.compiled);
    const result = await run({ args: compiledFlow.compiled.args, stdin: compiledFlow.compiled.stdin, timeoutMs: input.timeoutMs });
    const fillFailure = findFillScriptFailure(result);
    const failed = fillFailure !== undefined || result?.isError === true || result?.details?.resultCategory === "failure";
    const lines = [`Login flow: ${plan.summary} (${plan.rows} row(s), ${plan.secretRows} carrying a secret through the page script).`];
    if (fillFailure) {
        lines.push(describeVaultFillFailure(fillFailure) ?? `The page fill script reported "${fillFailure.reason}" and stopped before writing the rest.`);
        // The reason, not `filledCount`, decides the advice: `filledCount` counts the fields of the SAME
        // row that did get written, so a multi-field row (username+password+otp) can report a non-zero
        // count while the credential that matters was never entered. Only `submit-control-not-found`
        // means "everything was written, the form just never went through".
        if (fillFailure.reason === "submit-control-not-found") {
            lines.push("All fields were written, but the form was not submitted, so no credentials were transmitted. Submit it explicitly (click the enabled control, or `press Enter` in the field), then verify the destination page with a fresh snapshot.");
        }
        else {
            const field = fillFailure.failedRole ? `the "${fillFailure.failedRole}" field` : "the target field";
            lines.push(`The credential was NOT written to ${field}, so nothing was signed in. Snapshot the login page to confirm the form has rendered, then retry - pass explicit usernameSelector/passwordSelector when the field is not the conventional one.`);
        }
    }
    else {
        lines.push(failed
            ? "The browser run reported a failure; inspect the failing batch step before retrying."
            : `Completed${origin ? ` on ${origin}` : ""}. Verify the destination page with a fresh snapshot before continuing.`);
    }
    if (entry) {
        lines.push("The password and any 2FA code were written by the page script; they are not shown here and any later echo of them is redacted.");
    }
    return buildLoginResult({
        action: "run",
        details: {
            batchSteps: Array.isArray(result?.details?.batchSteps) ? result.details.batchSteps.length : undefined,
            // Secret-free by construction: parseVaultFillResult only ever exposes counts, roles and reasons.
            fill: fillFailure ? { failedRole: fillFailure.failedRole, filledCount: fillFailure.filledCount, reason: fillFailure.reason } : undefined,
            entry: entry ? { handle: entry.handle, origin: entry.origin } : undefined,
            origin,
            plan,
            reason: fillFailure ? fillFailure.reason : (failed ? (result?.details?.failureCategory ?? "upstream-failure") : undefined),
            secretsRegistered: Boolean(secret || otpSeed),
        },
        isError: failed,
        lines,
    });
}
