// local patch: credential-vault host orchestration (PATCHES.md P11).
//
// This is the wrapper-owned half of the vault: it talks to the local encrypted store, collects
// secrets through a masked prompt, and drives the actual page fill through the normal browser
// pipeline (so the fill inherits session handling, presentation, guards and redaction).
//
// Policy (ported from the design we studied, because it is the honest version of this feature):
//   - the model never receives a secret: not in text, not in `details`, not in nextActions
//   - an entry fills ONLY its own exact origin, verified here AND again inside the page
//   - the login identifier is not a secret, so the agent types it; only the password is vault-filled
//   - payment cards require an explicit human confirmation on every fill, and without a UI that
//     confirmation is impossible, so the fill is refused instead of assumed
//   - a code is entered into the page, never printed into the conversation
import { confirmVaultAction, promptVaultSecret, promptVaultText, VAULT_PROMPT_CANCELLED, VAULT_PROMPT_UNAVAILABLE } from "../../vault/intake.js";
import { buildVaultFillScript, describeVaultFillFailure, isVaultFillRole, parseVaultFillResult } from "../../vault/fill.js";
import { clearVaultSecrets, listVaultSecretAudit, registerVaultSecret } from "../../vault/secret-registry.js";
import { createVaultEntryId, describeVaultEntries, describeVaultEntry, findVaultEntries, getVaultStatus, mutateVaultEntries, normalizeVaultHandle, normalizeVaultOrigin, readVaultEntries, sanitizeVaultSecret } from "../../vault/store.js";

const PAYMENT_ROLES = ["card_number", "card_cvc", "card_exp", "card_name"];
const ADDRESS_ROLES = ["address_line1", "address_line2", "address_city", "address_state", "address_postal", "address_country"];
const DEFAULT_LOGIN_ROLES = ["password"];
const DEFAULT_LOGIN_FIELDS = [{ role: "password" }];
const UNLOCK_DEFAULT_MINUTES = 30;
const UNLOCK_MAX_MINUTES = 480;

let unlockSession = { expiresAtMs: 0, passphrase: undefined, minutes: 0 };

export function getVaultUnlockState() {
    if (!unlockSession.passphrase || unlockSession.expiresAtMs <= Date.now()) {
        return { unlocked: false, remainingMs: 0 };
    }
    return { unlocked: true, remainingMs: unlockSession.expiresAtMs - Date.now() };
}

export function clearVaultUnlockSession() {
    unlockSession = { expiresAtMs: 0, passphrase: undefined, minutes: 0 };
}

function getActivePassphrase() {
    const state = getVaultUnlockState();
    return state.unlocked ? unlockSession.passphrase : undefined;
}

export function setVaultUnlockSession(passphrase, minutes = UNLOCK_DEFAULT_MINUTES) {
    const bounded = Math.min(Math.max(1, Math.round(minutes)), UNLOCK_MAX_MINUTES);
    unlockSession = { expiresAtMs: Date.now() + bounded * 60_000, minutes: bounded, passphrase };
    return bounded;
}

function readOptions(env = process.env) {
    const passphrase = getActivePassphrase();
    return passphrase ? { env, passphrase } : { env };
}

function buildVaultResult({ action, details = {}, isError = false, lines = [], summary }) {
    const text = [...lines.filter(Boolean), summary].filter(Boolean).join("\n");
    return {
        content: [{ text: text.length > 0 ? text : `Vault ${action}: no output.`, type: "text" }],
        details: {
            categoryDetails: isError ? { failureCategory: "validation-error", resultCategory: "failure" } : { resultCategory: "success", successCategory: "completed" },
            vault: { action, ...details },
        },
        isError,
    };
}

function getVaultStoreError(read) {
    if (read.status === "empty") {
        return undefined;
    }
    if (read.status === "ok") {
        return undefined;
    }
    return read.error ?? `The credential vault is ${read.status}.`;
}

// local patch (PATCHES.md P27): route every page-touching vault call through one explicit session so a
// fill/totp can target a named profile browser instead of the implicit root session.
function withExplicitSession(dispatch, session) {
    if (typeof session !== "string" || session.length === 0) {
        return dispatch;
    }
    return (request = {}) => dispatch({ ...request, args: ["--session", session, ...(Array.isArray(request.args) ? request.args : [])] });
}

async function resolvePageOrigin({ dispatch }) {
    const result = await dispatch({ args: ["get", "url"] });
    const data = result?.details?.data;
    const url = typeof data?.url === "string" ? data.url : (typeof data?.result === "string" ? data.result : undefined);
    if (!url) {
        return { error: "The wrapper could not read the current page URL, so it cannot verify the fill target origin." };
    }
    const origin = normalizeVaultOrigin(url);
    if (!origin) {
        return { error: `The current page URL "${url}" has no usable http(s) origin, so no credential can be filled here.` };
    }
    return { origin, url };
}

function entryFieldsForType(entry) {
    // Returns role NAMES (strings); callers wrap them into field objects.
    if (entry.type === "card") {
        return entry.card ? PAYMENT_ROLES.filter((role) => typeof entry.card[role === "card_name" ? "holder" : role === "card_exp" ? "exp" : role === "card_cvc" ? "cvc" : "number"] === "string") : [];
    }
    if (entry.type === "address") {
        return entry.address ? ADDRESS_ROLES.filter((role) => typeof entry.address[role.replace("address_", "")] === "string") : [];
    }
    return DEFAULT_LOGIN_ROLES;
}

function entryValueForRole(entry, role) {
    if (role === "password") {
        return sanitizeVaultSecret(entry.secret);
    }
    if (role === "otp") {
        return undefined;
    }
    if (PAYMENT_ROLES.includes(role)) {
        const key = role === "card_name" ? "holder" : role === "card_exp" ? "exp" : role === "card_cvc" ? "cvc" : "number";
        return sanitizeVaultSecret(entry.card?.[key]);
    }
    if (ADDRESS_ROLES.includes(role)) {
        return sanitizeVaultSecret(entry.address?.[role.replace("address_", "")]);
    }
    if (role === "username") {
        return sanitizeVaultSecret(entry.username);
    }
    return undefined;
}

function registerEntrySecrets(entry, values) {
    for (const value of values) {
        registerVaultSecret(value, { handle: entry.handle, origin: entry.origin, source: "vault-fill" });
    }
}

async function runPageFill({ dispatch, entry, fields, submit }) {
    const resolved = fields
        .map((field) => ({ role: field.role, selector: field.selector, value: entryValueForRole(entry, field.role) }))
        .filter((field) => typeof field.value === "string" && field.value.length > 0);
    if (resolved.length === 0) {
        return { error: `The vault entry "${entry.handle}" has no usable value for ${fields.map((field) => field.role).join(", ")}.`, reason: "empty-entry" };
    }
    registerEntrySecrets(entry, resolved.map((field) => field.value));
    const script = buildVaultFillScript({ fields: resolved, origin: entry.origin, submit: submit === true });
    const result = await dispatch({ args: ["eval", "--stdin"], stdin: script });
    const parsed = parseVaultFillResult(result?.details?.data);
    if (!parsed.ok) {
        return { error: describeVaultFillFailure(parsed) ?? "The page fill did not complete.", parsed, reason: parsed.reason ?? "fill-failed" };
    }
    return { parsed };
}

function formatVaultListText(entries) {
    if (entries.length === 0) {
        return "No saved credentials match. Save one with the `save` action (the user is prompted in a masked dialog).";
    }
    return entries
        .map((entry) => {
            const bits = [`${entry.handle}`, `type=${entry.type}`, `origin=${entry.origin}`];
            if (entry.username) {
                bits.push(`identifier=${entry.username}`);
            }
            if (entry.label) {
                bits.push(`label=${entry.label}`);
            }
            bits.push(entry.hasOtp ? "otp=yes" : "otp=no");
            bits.push(entry.hasSecret ? "secret=stored" : "secret=missing");
            return `- ${bits.join(" ")}`;
        })
        .join("\n");
}

async function handleStatus() {
    const status = getVaultStatus();
    const lines = [
        `Vault directory: ${status.directory}`,
        `Vault file: ${status.vaultFile}${status.exists ? "" : " (not created yet)"}`,
        `Key mode: ${status.keyMode}`,
        `Entries: ${status.entryCount}`,
        `Store status: ${status.status}`,
    ];
    if (status.securityError) {
        lines.push(status.securityError);
    }
    if (status.statusError) {
        lines.push(status.statusError);
    }
    const unlock = getVaultUnlockState();
    lines.push(unlock.unlocked ? `Unlocked for another ${Math.ceil(unlock.remainingMs / 60_000)} minute(s).` : "Locked or key-file mode.");
    return buildVaultResult({
        action: "status",
        details: {
            directory: status.directory,
            entryCount: status.entryCount,
            keyMode: status.keyMode,
            securityError: status.securityError,
            status: status.status,
            statusError: status.statusError,
            unlocked: unlock.unlocked,
            vaultFile: status.vaultFile,
        },
        isError: status.status === "insecure" || status.status === "corrupt",
        lines,
    });
}

async function handleList({ compiled }) {
    const read = readVaultEntries(readOptions(compiled.env));
    const error = getVaultStoreError(read);
    if (error) {
        return buildVaultResult({ action: "list", details: { reason: read.status, status: read.status }, isError: true, lines: [error] });
    }
    const entries = describeVaultEntries(findVaultEntries(read.entries, { origin: compiled.origin, type: compiled.type }));
    return buildVaultResult({
        action: "list",
        details: { entries, origin: compiled.origin, type: compiled.type },
        lines: [formatVaultListText(entries)],
    });
}

async function handleSave({ compiled, ctx, dispatch, fillAfterSave = true }) {
    const read = readVaultEntries(readOptions());
    const error = getVaultStoreError(read);
    if (error) {
        return buildVaultResult({ action: "save", details: { reason: read.status, status: read.status }, isError: true, lines: [error] });
    }
    const existing = findVaultEntries(read.entries, { handle: compiled.handle })[0];
    if (existing && compiled.overwrite !== true) {
        return buildVaultResult({
            action: "save",
            details: { handle: compiled.handle, reason: "handle-exists" },
            isError: true,
            lines: [`A vault entry named "${compiled.handle}" already exists for ${existing.origin}. Pass overwrite: true to replace it.`],
        });
    }
    let origin = compiled.origin;
    if (!origin) {
        const page = await resolvePageOrigin({ dispatch });
        if (page.error) {
            return buildVaultResult({ action: "save", details: { reason: "origin-unknown" }, isError: true, lines: [page.error] });
        }
        origin = page.origin;
    }    let secret = sanitizeVaultSecret(compiled.secret);
    let username = compiled.username;
    let otpSeed = sanitizeVaultSecret(compiled.otpSeed);
    const needsSecret = compiled.type === "login" || compiled.type === "card";
    if (needsSecret && !secret && compiled.type === "login") {
        const prompted = await promptVaultSecret(ctx, {
            confirm: true,
            hint: "Encrypted on this machine and bound to this origin. The model never sees it.",
            message: `Save the password for ${origin}. It is filled into pages on that origin only.`,
            title: `Save login for ${compiled.handle}`,
        });
        if (prompted.status === VAULT_PROMPT_CANCELLED) {
            return buildVaultResult({ action: "save", details: { handle: compiled.handle, reason: "save_declined" }, lines: ["Saving was declined, so nothing was written. The user can retry, or add the entry later from an interactive session."] });
        }
        if (prompted.status !== "ok") {
            return buildVaultResult({ action: "save", details: { handle: compiled.handle, reason: prompted.status }, isError: true, lines: [prompted.error] });
        }
        secret = prompted.value;
    }
    if (!username && compiled.type === "login") {
        const prompted = await promptVaultText(ctx, { placeholder: "you@example.com", title: `Identifier for ${origin} (stored as visible metadata)` });
        if (prompted.status === "ok") {
            username = prompted.value;
        }
    }
    if (compiled.type === "totp" && !otpSeed) {
        const prompted = await promptVaultSecret(ctx, { hint: "Paste the setup key or otpauth:// link. It is encrypted locally.", message: "Paste the authenticator setup key (base32 or otpauth:// URI).", title: `2FA key for ${compiled.handle}` });
        if (prompted.status !== "ok") {
            return buildVaultResult({ action: "save", details: { handle: compiled.handle, reason: prompted.status ?? "save_declined" }, isError: prompted.status !== VAULT_PROMPT_CANCELLED, lines: [prompted.error ?? "Saving the 2FA key was declined."] });
        }
        otpSeed = prompted.value;
    }
    const timestamp = Date.now();
    const entry = {
        address: compiled.address,
        card: compiled.card,
        createdAtMs: existing?.createdAtMs ?? timestamp,
        handle: compiled.handle,
        id: existing?.id ?? createVaultEntryId(),
        label: compiled.label,
        lastUsedAtMs: existing?.lastUsedAtMs,
        origin,
        otpSeed,
        secret,
        type: compiled.type,
        updatedAtMs: timestamp,
        username,
    };
    const mutation = mutateVaultEntries((entries) => {
        const index = entries.findIndex((candidate) => candidate.handle === entry.handle);
        if (index >= 0) {
            if (compiled.overwrite !== true) {
                return `A vault entry named "${entry.handle}" already exists.`;
            }
            entries[index] = entry;
            return entries;
        }
        entries.push(entry);
        return entries;
    }, readOptions());
    if (mutation.status !== "ok") {
        return buildVaultResult({ action: "save", details: { handle: entry.handle, reason: mutation.status }, isError: true, lines: [mutation.error ?? `The vault could not be written (${mutation.status}).`] });
    }
    const described = describeVaultEntry(entry);
    const lines = [
        `Saved vault entry ${described.handle} (${described.type}) for ${described.origin}.`,
        described.username ? `Identifier: ${described.username} - type it into the identifier field yourself; it is not secret.` : "No identifier stored; type the username yourself.",
        "The password is stored encrypted and is only ever filled into that exact origin.",
    ];
    let fill = {};
    const fillable = compiled.type === "login" ? secret : undefined;
    if (fillAfterSave && fillable) {
        const attempted = await runPageFill({ dispatch, entry, fields: compiled.fields ?? DEFAULT_LOGIN_FIELDS, submit: compiled.submit === true });
        if (attempted.error) {
            lines.push(`The page was not filled: ${attempted.error}`);
            fill = { fillError: attempted.error, fillReason: attempted.reason };
        }
        else {
            lines.push(`Filled ${attempted.parsed.filledCount} field(s) on ${attempted.parsed.origin} without exposing the value.`);
            fill = { fill: describeVaultFillDetails(attempted.parsed) };
        }
    }
    return buildVaultResult({ action: "save", details: { entry: described, ...fill }, lines });
}

function describeVaultFillDetails(parsed) {
    return {
        fields: parsed.fields,
        filledCount: parsed.filledCount,
        origin: parsed.origin,
        submitAttempted: parsed.submitAttempted,
    };
}

async function handleFill({ compiled, ctx, dispatch }) {
    const read = readVaultEntries(readOptions());
    const error = getVaultStoreError(read);
    if (error) {
        if (read.status === "locked" || read.status === "missing-key") {
            return buildVaultResult({
                action: "fill",
                details: { reason: "vault_locked", status: read.status },
                isError: true,
                lines: [error, "Run the `unlock` action to enter the vault passphrase for this session."],
            });
        }
        return buildVaultResult({ action: "fill", details: { reason: read.status, status: read.status }, isError: true, lines: [error] });
    }
    const page = await resolvePageOrigin({ dispatch });
    if (page.error) {
        return buildVaultResult({ action: "fill", details: { reason: "origin-unknown" }, isError: true, lines: [page.error] });
    }
    const matches = findVaultEntries(read.entries, { handle: compiled.handle, origin: compiled.handle ? undefined : page.origin });
    const usable = matches.filter((entry) => entry.type === "login" || entry.type === "card" || entry.type === "address");
    if (usable.length === 0) {
        if (compiled.promptIfMissing !== false) {
            return buildVaultResult({
                action: "fill",
                details: { origin: page.origin, reason: "missing_entry", requiresSave: true },
                lines: [
                    `No saved credential for ${page.origin}.`,
                    `The wrapper can save one now: call vault { action: "save", handle: "<name>", type: "login", origin: "${page.origin}" } and the user is prompted in a masked dialog. Do not ask for the password in chat.`,
                ],
            });
        }
        return buildVaultResult({ action: "fill", details: { origin: page.origin, reason: "missing_entry" }, isError: true, lines: [`No saved credential for ${page.origin}.`] });
    }
    const entry = usable[0];
    if (entry.origin !== page.origin) {
        return buildVaultResult({
            action: "fill",
            details: { entry: describeVaultEntry(entry), origin: page.origin, reason: "origin-mismatch" },
            isError: true,
            lines: [`Refused to fill: the entry ${entry.handle} is bound to ${entry.origin}, but the page is ${page.origin}. Nothing was written.`],
        });
    }
    const requestedRoles = Array.isArray(compiled.fields) && compiled.fields.length > 0
        ? compiled.fields.map((field) => (typeof field === "string" ? { role: field } : field))
        : entryFieldsForType(entry).map((role) => ({ role }));
    const roles = requestedRoles.filter((field) => isVaultFillRole(field.role));
    if (roles.length === 0) {
        return buildVaultResult({ action: "fill", details: { reason: "no-fillable-fields" }, isError: true, lines: ["None of the requested roles can be filled from this entry."] });
    }
    const paymentRequested = roles.some((field) => PAYMENT_ROLES.includes(field.role));
    if (paymentRequested) {
        const confirmation = await confirmVaultAction(ctx, {
            message: `Fill saved payment details for ${page.origin}? The card number and CVC will be written into the page.`,
            title: "Confirm card fill",
        });
        if (!confirmation.confirmed) {
            return buildVaultResult({
                action: "fill",
                details: { origin: page.origin, reason: "payment_declined", status: confirmation.status },
                isError: confirmation.status === VAULT_PROMPT_UNAVAILABLE,
                lines: [confirmation.status === VAULT_PROMPT_UNAVAILABLE
                    ? "Refused: filling a payment card requires an interactive confirmation, and no UI is available in this session. Never retry a declined card fill automatically."
                    : "The card fill was declined, so nothing was written. Do not retry automatically."],
            });
        }
    }
    const attempted = await runPageFill({ dispatch, entry, fields: roles, submit: compiled.submit === true });
    if (attempted.error) {
        return buildVaultResult({
            action: "fill",
            details: { entry: describeVaultEntry(entry), origin: page.origin, reason: attempted.reason, status: "failed" },
            isError: true,
            lines: [attempted.error],
        });
    }
    const details = describeVaultFillDetails(attempted.parsed);
    const visibleFields = Array.isArray(compiled.visibleFields) ? compiled.visibleFields : [];
    const lines = [`Filled ${details.filledCount} field(s) for ${entry.handle} on ${details.origin}. Values were written by the page script and are not shown here.`];
    if (visibleFields.length > 0) {
        lines.push(`Non-secret fields you may also type yourself: ${visibleFields.join(", ")}.`);
    }
    if (paymentRequested) {
        lines.push("This was a payment fill: verify the order total in the page before submitting.");
    }
    return buildVaultResult({ action: "fill", details: { entry: describeVaultEntry(entry), ...details, secretsRegistered: listVaultSecretAudit().length }, lines });
}

async function handleTotp({ compiled, ctx, dispatch }) {
    const read = readVaultEntries(readOptions());
    const error = getVaultStoreError(read);
    if (error) {
        return buildVaultResult({ action: "totp", details: { reason: read.status, status: read.status }, isError: true, lines: [error] });
    }
    const entry = compiled.handle ? findVaultEntries(read.entries, { handle: compiled.handle })[0] : undefined;
    if (compiled.handle && !entry) {
        return buildVaultResult({ action: "totp", details: { handle: compiled.handle, reason: "missing_entry" }, isError: true, lines: [`No vault entry named "${compiled.handle}".`] });
    }
    const [{ generateTotp, parseOtpauthUri }] = await Promise.all([import("../../vault/totp.js")]);
    let code = compiled.code;
    let seed = sanitizeVaultSecret(compiled.otpSeed) ?? sanitizeVaultSecret(entry?.otpSeed);
    if (seed?.startsWith("otpauth://")) {
        seed = parseOtpauthUri(seed)?.secret ?? seed;
    }
    if (!code && seed) {
        try {
            const generated = generateTotp(seed, { digits: compiled.digits, period: compiled.period });
            code = generated.code;
        }
        catch (generationError) {
            return buildVaultResult({ action: "totp", details: { reason: "invalid_seed" }, isError: true, lines: [`The stored 2FA key could not be used: ${generationError instanceof Error ? generationError.message : String(generationError)}.`] });
        }
    }
    if (!code) {
        const prompted = await promptVaultSecret(ctx, {
            expectedLength: undefined,
            hint: "It is entered into the page and never shown to the model.",
            message: "Enter the verification code sent to your phone, email or authenticator app.",
            title: "Verification code",
        });
        if (prompted.status !== "ok") {
            return buildVaultResult({
                action: "totp",
                details: { reason: prompted.status === VAULT_PROMPT_UNAVAILABLE ? "prompt_unavailable" : "code_declined" },
                isError: prompted.status === VAULT_PROMPT_UNAVAILABLE,
                lines: [prompted.error ?? "The code entry was cancelled. The code never enters the conversation; ask the user to retry when they can."],
            });
        }
        code = prompted.value;
    }
    if (!entry) {
        // No stored entry: still safe to type a one-time code into the page, but nothing is persisted.
        const synthetic = { address: undefined, card: undefined, handle: compiled.handle ?? "one-time-code", hp: undefined, origin: compiled.origin ?? (await resolvePageOrigin({ dispatch })).origin, secret: undefined, type: "totp" };
        if (!synthetic.origin) {
            return buildVaultResult({ action: "totp", details: { reason: "origin-unknown" }, isError: true, lines: ["The current page origin could not be read, so the code was not entered."] });
        }
        registerVaultSecret(code, { handle: synthetic.handle, origin: synthetic.origin, source: "vault-otp" });
        const script = buildVaultFillScript({ fields: [{ role: "otp", selector: compiled.selector, value: code }], origin: synthetic.origin, submit: compiled.submit === true });
        const result = await dispatch({ args: ["eval", "--stdin"], stdin: script });
        const parsed = parseVaultFillResult(result?.details?.data);
        if (!parsed.ok) {
            return buildVaultResult({ action: "totp", details: { reason: parsed.reason ?? "fill-failed" }, isError: true, lines: [describeVaultFillFailure(parsed) ?? "The code was not entered."] });
        }
        return buildVaultResult({ action: "totp", details: { fields: parsed.fields, filledCount: parsed.filledCount, origin: parsed.origin, source: "user-supplied" }, lines: [`Entered the verification code on ${parsed.origin} without exposing it.`] });
    }
    registerVaultSecret(code, { handle: entry.handle, origin: entry.origin, source: "vault-otp" });
    const script = buildVaultFillScript({ fields: [{ role: "otp", selector: compiled.selector, value: code }], origin: entry.origin, submit: compiled.submit === true });
    const result = await dispatch({ args: ["eval", "--stdin"], stdin: script });
    const parsed = parseVaultFillResult(result?.details?.data);
    if (!parsed.ok) {
        const noField = parsed.reason === "field-not-found";
        return buildVaultResult({
            action: "totp",
            details: { handle: entry.handle, reason: noField ? "no_code_field" : parsed.reason ?? "fill-failed" },
            isError: true,
            lines: [noField
                ? "No one-time-code field is present. If the site is waiting for a passkey or an app approval, complete it on your device and then retry the page action."
                : (describeVaultFillFailure(parsed) ?? "The code was not entered.")],
        });
    }
    return buildVaultResult({ action: "totp", details: { fields: parsed.fields, filledCount: parsed.filledCount, handle: entry.handle, origin: parsed.origin, source: seed ? "authenticator" : "user-supplied" }, lines: [`Entered the verification code for ${entry.handle} on ${parsed.origin} without exposing it.`] });
}

async function handleRemove({ compiled }) {
    const read = readVaultEntries(readOptions());
    const error = getVaultStoreError(read);
    if (error) {
        return buildVaultResult({ action: "remove", details: { reason: read.status, status: read.status }, isError: true, lines: [error] });
    }
    const existing = findVaultEntries(read.entries, { handle: compiled.handle })[0];
    if (!existing) {
        return buildVaultResult({ action: "remove", details: { handle: compiled.handle, reason: "missing_entry" }, isError: true, lines: [`No vault entry named "${compiled.handle}".`] });
    }
    const mutation = mutateVaultEntries((entries) => entries.filter((entry) => entry.handle !== compiled.handle), readOptions());
    if (mutation.status !== "ok") {
        return buildVaultResult({ action: "remove", details: { handle: compiled.handle, reason: mutation.status }, isError: true, lines: [mutation.error ?? "The vault could not be written."] });
    }
    return buildVaultResult({ action: "remove", details: { handle: compiled.handle, removed: true }, lines: [`Removed vault entry ${compiled.handle}.`] });
}

async function handleUnlock({ ctx, compiled }) {
    const passphrase = getActivePassphrase();
    if (passphrase) {
        const state = getVaultUnlockState();
        return buildVaultResult({ action: "unlock", details: { remainingMs: state.remainingMs, status: "already_unlocked" }, lines: [`The vault is already unlocked for another ${Math.ceil(state.remainingMs / 60_000)} minute(s).`] });
    }
    const prompted = await promptVaultSecret(ctx, {
        hint: "Only the derived key is kept in memory, and only for this session.",
        message: "Enter the vault passphrase to unlock saved credentials for this session.",
        title: "Unlock credential vault",
    });
    if (prompted.status === VAULT_PROMPT_UNAVAILABLE) {
        return buildVaultResult({ action: "unlock", details: { reason: "unlock_unavailable" }, isError: true, lines: [prompted.error] });
    }
    if (prompted.status === VAULT_PROMPT_CANCELLED) {
        return buildVaultResult({ action: "unlock", details: { reason: "unlock_cancelled" }, lines: ["Unlock was cancelled."] });
    }
    const verified = readVaultEntries({ env: process.env, passphrase: prompted.value });
    if (verified.status === "locked" || verified.status === "corrupt") {
        return buildVaultResult({ action: "unlock", details: { reason: "unlock_failed" }, isError: true, lines: ["That passphrase did not decrypt the vault, so it was not cached."] });
    }
    const minutes = setVaultUnlockSession(prompted.value, compiled.minutes ?? UNLOCK_DEFAULT_MINUTES);
    clearVaultSecrets();
    return buildVaultResult({ action: "unlock", details: { minutes, status: "unlocked" }, lines: [`Vault unlocked for ${minutes} minute(s). It re-locks automatically, and the wrapped process never writes the passphrase anywhere.`] });
}

/**
 * Entry point. `dispatch` runs one browser call through the normal tool executor:
 * `dispatch({ args, stdin }) => toolResult`.
 */
export async function handleVaultHostInput({ compiled, ctx, dispatch: rawDispatch }) {
    // local patch (PATCHES.md P27): one explicit session for every browser call this action makes.
    const dispatch = withExplicitSession(rawDispatch, compiled.session);
    switch (compiled.action) {
        case "status":
            return await handleStatus();
        case "list":
            return await handleList({ compiled });
        case "save":
            return await handleSave({ compiled, ctx, dispatch });
        case "fill":
            return await handleFill({ compiled, ctx, dispatch });
        case "totp":
            return await handleTotp({ compiled, ctx, dispatch });
        case "remove":
            return await handleRemove({ compiled });
        case "unlock":
            return await handleUnlock({ compiled, ctx });
        default:
            return buildVaultResult({ action: compiled.action ?? "unknown", details: { reason: "unknown-action" }, isError: true, lines: [`Unknown vault action "${compiled.action}".`] });
    }
}
