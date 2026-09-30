// local patch: `vault` input mode validator and planner (PATCHES.md P11/P12).
//
// Why this exists: the credential vault is the one mode where a mistake either leaks a secret or types
// it into the wrong site. Validation is therefore strict and happens before any store or browser work:
// exact origins only, a bounded handle shape, an explicit allowlist of fields, secrets refused in any
// field that would end up in argv, and card fills flagged as needing human confirmation.
//
// This module is pure. It never reads the vault, never touches the filesystem, never asks the UI, and
// never returns a secret - not in `value`, not in `describeVaultPlan`, not in an error message.
import { isRecord } from "../parsing.js";
import { VAULT_FILL_ROLES } from "../vault/fill.js";
import { normalizeVaultHandle, normalizeVaultOrigin, sanitizeVaultSecret } from "../vault/store.js";
import { unwrapItemEnvelopeDeep } from "./shared.js";

export const VAULT_ACTIONS = ["status", "list", "save", "fill", "totp", "remove", "unlock"];
export const VAULT_SAVE_TYPES = ["login", "totp", "card", "address"];
// Non-secret values a caller may allow onto an argv row (typed as plain text by some other tool path).
export const VAULT_VISIBLE_VALUE_ROLES = ["username", "card_name", "address_line1", "address_line2", "address_city", "address_state", "address_postal", "address_country"];
// Roles whose value must only ever reach the page through the stdin-delivered fill script.
export const VAULT_SECRET_ROLES = ["password", "otp", "card_number", "card_exp", "card_cvc"];
// Filling any of these is a spend-shaped action, so it requires an explicit human confirmation.
export const VAULT_CONFIRMATION_ROLES = ["card_name", "card_number", "card_exp", "card_cvc"];
export const VAULT_UNLOCK_DEFAULT_MINUTES = 30;
export const VAULT_UNLOCK_MAX_MINUTES = 480;
export const VAULT_TOTP_MIN_DIGITS = 6;
export const VAULT_TOTP_MAX_DIGITS = 10;
export const VAULT_TOTP_MIN_PERIOD_SECONDS = 5;
export const VAULT_TOTP_MAX_PERIOD_SECONDS = 300;
const VAULT_CARD_FIELDS = ["number", "exp", "cvc", "holder"];
const VAULT_ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postal", "country"];
const MIN_CARD_DIGITS = 8;
const MAX_CARD_DIGITS = 24;
const MAX_LABEL_CHARS = 200;
const MAX_SELECTOR_CHARS = 500;
const MAX_SESSION_CHARS = 64;

// `fieldName` is the real property to read; `label` is only for the error text (for example the
// property "overwrite" is reported as "vault.overwrite"). Reading the label as the property silently
// dropped every optional value, so the two are kept separate on purpose.
function normalizeOptionalString(input, fieldName, label = fieldName, { maxChars } = {}) {
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

function normalizeOptionalBoolean(input, fieldName, label = fieldName, defaultValue) {
    const value = input[fieldName];
    if (value === undefined) {
        return { value: defaultValue };
    }
    if (typeof value !== "boolean") {
        return { error: `${label} must be true or false when provided.` };
    }
    return { value };
}

function normalizeOptionalInteger(input, fieldName, label = fieldName, { min, max } = {}) {
    const value = input[fieldName];
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        return { error: `${label} must be an integer between ${min} and ${max} when provided.` };
    }
    return { value };
}

function onlyAllowedVaultFields(input, action, allowedFields) {
    const unexpected = Object.keys(input).find((fieldName) => !allowedFields.has(fieldName));
    return unexpected ? `vault.${action} does not support vault.${unexpected}.` : undefined;
}

function validateRequiredHandle(input) {
    const handle = normalizeVaultHandle(input.handle);
    if (!handle) {
        return { error: "vault requires a handle such as \"github\": lowercase letters, digits, dot, dash or underscore, starting with a letter or digit, at most 64 characters." };
    }
    return { value: handle };
}

function validateOptionalHandle(input) {
    if (input.handle === undefined) {
        return {};
    }
    return validateRequiredHandle(input);
}

// local patch (PATCHES.md P27): `fill`/`totp` may target one explicit upstream session, so a fill can
// reach a named profile browser (for example "ultron1") instead of the implicit root session.
function validateOptionalSession(input) {
    const session = normalizeOptionalString(input, "session", "vault.session", { maxChars: MAX_SESSION_CHARS });
    if (session.error) {
        return { error: session.error };
    }
    if (session.value === undefined) {
        return {};
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session.value)) {
        return { error: "vault.session must be an upstream session name: letters, digits, dot, dash or underscore, starting with a letter or digit." };
    }
    return { value: session.value };
}

function validateOrigin(input, { required }) {
    if (input.origin === undefined) {
        return required
            ? { error: "vault requires an exact page origin such as https://app.example.com (scheme and host, optionally a port)." }
            : {};
    }
    const origin = normalizeVaultOrigin(input.origin);
    if (!origin) {
        return { error: `vault.origin must be an exact http(s) origin such as https://app.example.com, not ${JSON.stringify(input.origin)}.` };
    }
    return { value: origin };
}

function validateVaultFillFields(input) {
    // Caller-supplied array parameter. vault.fill is how a caller types several fields at once, so
    // refusing its array here means the whole fill path is unreachable from a real tool call.
    const rawFields = unwrapItemEnvelopeDeep(input.fields);
    if (input.fields === undefined) {
        return {};
    }
    if (!Array.isArray(rawFields)) {
        return { error: "vault.fill fields must be an array of { role, selector? } objects." };
    }
    const fields = [];
    for (const [index, field] of rawFields.entries()) {
        if (!isRecord(field)) {
            return { error: `vault.fill fields[${index}] must be an object with a role.` };
        }
        const unexpected = Object.keys(field).find((key) => key !== "role" && key !== "selector");
        if (unexpected) {
            return { error: `vault.fill fields[${index}] does not support ${unexpected}.` };
        }
        if (typeof field.role !== "string" || !VAULT_FILL_ROLES.includes(field.role)) {
            return { error: `vault.fill fields[${index}].role must be one of: ${VAULT_FILL_ROLES.join(", ")}.` };
        }
        if (field.selector === undefined) {
            fields.push({ role: field.role });
            continue;
        }
        if (typeof field.selector !== "string" || field.selector.trim().length === 0) {
            return { error: `vault.fill fields[${index}].selector must be a non-empty string when provided.` };
        }
        const selector = field.selector.trim();
        if (selector.length > MAX_SELECTOR_CHARS) {
            return { error: `vault.fill fields[${index}].selector must be ${MAX_SELECTOR_CHARS} characters or fewer.` };
        }
        fields.push({ role: field.role, selector });
    }
    if (fields.length === 0) {
        return { error: "vault.fill fields must name at least one role when provided." };
    }
    return { value: fields };
}

function validateVaultVisibleFields(input) {
    if (input.visibleFields === undefined) {
        return {};
    }
    if (!Array.isArray(input.visibleFields)) {
        return { error: `vault.fill visibleFields must be an array of non-secret roles (${VAULT_VISIBLE_VALUE_ROLES.join(", ")}).` };
    }
    const visibleFields = [];
    for (const [index, role] of input.visibleFields.entries()) {
        if (typeof role !== "string" || !VAULT_FILL_ROLES.includes(role)) {
            return { error: `vault.fill visibleFields[${index}] must be one of: ${VAULT_FILL_ROLES.join(", ")}.` };
        }
        if (VAULT_SECRET_ROLES.includes(role)) {
            return { error: `vault.fill visibleFields must not include ${role}: a secret value is never typed through argv. Remove it and let the wrapper fill it through the page script instead.` };
        }
        if (!VAULT_VISIBLE_VALUE_ROLES.includes(role)) {
            return { error: `vault.fill visibleFields[${index}] must be one of: ${VAULT_VISIBLE_VALUE_ROLES.join(", ")}.` };
        }
        if (!visibleFields.includes(role)) {
            visibleFields.push(role);
        }
    }
    return { value: visibleFields };
}

function validateVaultCard(card) {
    if (!isRecord(card)) {
        return { error: "vault.save card must be an object with number, exp and cvc." };
    }
    const unexpected = Object.keys(card).find((key) => !VAULT_CARD_FIELDS.includes(key));
    if (unexpected) {
        return { error: `vault.save card does not support card.${unexpected}.` };
    }
    for (const key of ["number", "exp", "cvc"]) {
        if (typeof card[key] !== "string" || card[key].trim().length === 0) {
            return { error: `vault.save card.${key} must be a non-empty string.` };
        }
    }
    const digits = card.number.replace(/[\s-]/g, "");
    if (!/^\d+$/.test(digits) || digits.length < MIN_CARD_DIGITS || digits.length > MAX_CARD_DIGITS) {
        return { error: `vault.save card.number must contain ${MIN_CARD_DIGITS}-${MAX_CARD_DIGITS} digits (spaces and dashes are allowed).` };
    }
    const exp = card.exp.trim();
    if (!/^(?:0[1-9]|1[0-2])\/\d{2}(?:\d{2})?$/.test(exp) && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(exp)) {
        return { error: "vault.save card.exp must look like MM/YY, MM/YYYY or YYYY-MM." };
    }
    const cvc = card.cvc.trim();
    if (!/^\d{3,4}$/.test(cvc)) {
        return { error: "vault.save card.cvc must be 3 or 4 digits." };
    }
    const normalized = { cvc, exp, number: digits };
    if (card.holder !== undefined) {
        if (typeof card.holder !== "string" || card.holder.trim().length === 0) {
            return { error: "vault.save card.holder must be a non-empty string when provided." };
        }
        normalized.holder = card.holder.trim();
    }
    return { value: normalized };
}

function validateVaultAddress(address) {
    if (!isRecord(address)) {
        return { error: "vault.save address must be an object with at least line1, postal and country." };
    }
    const unexpected = Object.keys(address).find((key) => !VAULT_ADDRESS_FIELDS.includes(key));
    if (unexpected) {
        return { error: `vault.save address does not support address.${unexpected}.` };
    }
    for (const key of ["line1", "postal", "country"]) {
        if (typeof address[key] !== "string" || address[key].trim().length === 0) {
            return { error: `vault.save address.${key} must be a non-empty string (line1, postal and country are required).` };
        }
    }
    const normalized = {};
    for (const key of VAULT_ADDRESS_FIELDS) {
        if (address[key] === undefined) {
            continue;
        }
        if (typeof address[key] !== "string" || address[key].trim().length === 0) {
            return { error: `vault.save address.${key} must be a non-empty string when provided.` };
        }
        normalized[key] = address[key].trim();
    }
    return { value: normalized };
}

function normalizeVaultStatus(input) {
    const unexpected = onlyAllowedVaultFields(input, "status", new Set(["action"]));
    if (unexpected) {
        return { error: unexpected };
    }
    return { value: { action: "status" } };
}

function normalizeVaultList(input) {
    const unexpected = onlyAllowedVaultFields(input, "list", new Set(["action", "origin", "type", "includeSecrets"]));
    if (unexpected) {
        return { error: unexpected };
    }
    const origin = validateOrigin(input, { required: false });
    if (origin.error) {
        return { error: origin.error };
    }
    if (input.type !== undefined && (typeof input.type !== "string" || !VAULT_SAVE_TYPES.includes(input.type))) {
        return { error: `vault.list type must be one of: ${VAULT_SAVE_TYPES.join(", ")}.` };
    }
    if (input.includeSecrets !== undefined) {
        if (typeof input.includeSecrets !== "boolean") {
            return { error: "vault.list includeSecrets must be false when provided." };
        }
        if (input.includeSecrets) {
            return { error: "vault.list never returns secret values; drop includeSecrets or set it to false. Use vault.fill to use a secret without seeing it." };
        }
    }
    const value = { action: "list" };
    if (origin.value) {
        value.origin = origin.value;
    }
    if (input.type !== undefined) {
        value.type = input.type;
    }
    if (input.includeSecrets === false) {
        value.includeSecrets = false;
    }
    return { value };
}

function normalizeVaultSave(input) {
    const unexpected = onlyAllowedVaultFields(input, "save", new Set(["action", "handle", "type", "origin", "username", "label", "secret", "otpSeed", "card", "address", "overwrite"]));
    if (unexpected) {
        return { error: unexpected };
    }
    const handle = validateRequiredHandle(input);
    if (handle.error) {
        return { error: handle.error };
    }
    if (typeof input.type !== "string" || !VAULT_SAVE_TYPES.includes(input.type)) {
        return { error: `vault.save type must be one of: ${VAULT_SAVE_TYPES.join(", ")}.` };
    }
    const origin = validateOrigin(input, { required: true });
    if (origin.error) {
        return { error: origin.error };
    }
    const username = normalizeOptionalString(input, "username", "vault.username", { maxChars: 320 });
    if (username.error) {
        return { error: username.error };
    }
    const label = normalizeOptionalString(input, "label", "vault.label", { maxChars: MAX_LABEL_CHARS });
    if (label.error) {
        return { error: label.error };
    }
    const overwrite = normalizeOptionalBoolean(input, "overwrite", "vault.overwrite", false);
    if (overwrite.error) {
        return { error: overwrite.error };
    }
    const value = { action: "save", handle: handle.value, origin: origin.value, overwrite: overwrite.value, type: input.type };
    if (input.secret !== undefined) {
        if (typeof input.secret !== "string") {
            return { error: "vault.save secret must be a string when provided." };
        }
        const secret = sanitizeVaultSecret(input.secret);
        if (secret === undefined) {
            return { error: "vault.save secret must be a non-empty string of at most 4096 characters." };
        }
        value.secret = secret;
    }
    if (input.otpSeed !== undefined) {
        if (typeof input.otpSeed !== "string" || input.otpSeed.trim().length === 0) {
            return { error: "vault.save otpSeed must be a non-empty string (a base32 authenticator secret or an otpauth:// URI)." };
        }
        value.otpSeed = input.otpSeed.trim();
    }
    if (input.card !== undefined) {
        const card = validateVaultCard(input.card);
        if (card.error) {
            return { error: card.error };
        }
        value.card = card.value;
    }
    if (input.address !== undefined) {
        const address = validateVaultAddress(input.address);
        if (address.error) {
            return { error: address.error };
        }
        value.address = address.value;
    }
    // local patch fix: non-secret fields must be copied onto the plan BEFORE the type-specific checks below,
    // because the login check reads `value.username`. It used to be assigned at the end of this function, so
    // saving a login without passing `secret` (the documented masked-prompt flow) always failed with
    // "needs at least a username or a secret" even when a username WAS given (PATCHES.md P25).
    if (label.value) {
        value.label = label.value;
    }
    if (username.value) {
        value.username = username.value;
    }
    if (input.type === "totp" && !value.otpSeed) {
        return { error: "vault.save with type \"totp\" requires otpSeed." };
    }
    if (input.type === "card" && !value.card) {
        return { error: "vault.save with type \"card\" requires a card object with number, exp and cvc." };
    }
    if (input.type === "address" && !value.address) {
        return { error: "vault.save with type \"address\" requires an address object with line1, postal and country." };
    }
    if (input.type === "login" && !value.secret && !value.otpSeed && !value.username) {
        return { error: "vault.save with type \"login\" needs at least a username or a secret." };
    }
    if (value.card && value.secret) {
        return { error: "vault.save cannot combine a card with a login secret; save two separate entries instead." };
    }
    if (value.address && value.secret) {
        return { error: "vault.save cannot combine an address with a login secret; save two separate entries instead." };
    }
    return { value };
}

function normalizeVaultFill(input) {
    const unexpected = onlyAllowedVaultFields(input, "fill", new Set(["action", "origin", "handle", "fields", "submit", "promptIfMissing", "visibleFields", "session"]));
    if (unexpected) {
        return { error: unexpected };
    }
    // local patch fix (P11): a handle-only fill is safe because the entry carries the origin and the page is
    // still verified against it, so `origin` is only mandatory when no handle was given.
    const origin = validateOrigin(input, { required: input.handle === undefined });
    if (origin.error) {
        return { error: origin.error };
    }
    const handle = validateOptionalHandle(input);
    if (handle.error) {
        return { error: handle.error };
    }
    const fields = validateVaultFillFields(input);
    if (fields.error) {
        return { error: fields.error };
    }
    const visibleFields = validateVaultVisibleFields(input);
    if (visibleFields.error) {
        return { error: visibleFields.error };
    }
    const submit = normalizeOptionalBoolean(input, "submit", "vault.submit", false);
    if (submit.error) {
        return { error: submit.error };
    }
    const promptIfMissing = normalizeOptionalBoolean(input, "promptIfMissing", "vault.promptIfMissing", true);
    if (promptIfMissing.error) {
        return { error: promptIfMissing.error };
    }
    const session = validateOptionalSession(input);
    if (session.error) {
        return { error: session.error };
    }
    const value = { action: "fill", origin: origin.value, promptIfMissing: promptIfMissing.value, submit: submit.value };
    if (session.value) {
        value.session = session.value;
    }
    if (handle.value) {
        value.handle = handle.value;
    }
    if (fields.value) {
        value.fields = fields.value;
    }
    if (visibleFields.value) {
        value.visibleFields = visibleFields.value;
    }
    return { value };
}

function normalizeVaultTotp(input) {
    const unexpected = onlyAllowedVaultFields(input, "totp", new Set(["action", "handle", "otpSeed", "digits", "period", "session"]));
    if (unexpected) {
        return { error: unexpected };
    }
    const handle = validateOptionalHandle(input);
    if (handle.error) {
        return { error: handle.error };
    }
    let otpSeed;
    if (input.otpSeed !== undefined) {
        if (typeof input.otpSeed !== "string" || input.otpSeed.trim().length === 0) {
            return { error: "vault.totp otpSeed must be a non-empty string (a base32 authenticator secret or an otpauth:// URI)." };
        }
        otpSeed = input.otpSeed.trim();
    }
    if (!handle.value && !otpSeed) {
        return { error: "vault.totp requires either a saved handle or an explicit otpSeed." };
    }
    const digits = normalizeOptionalInteger(input, "digits", "vault.totp digits", { min: VAULT_TOTP_MIN_DIGITS, max: VAULT_TOTP_MAX_DIGITS });
    if (digits.error) {
        return { error: digits.error };
    }
    const period = normalizeOptionalInteger(input, "period", "vault.totp period", { min: VAULT_TOTP_MIN_PERIOD_SECONDS, max: VAULT_TOTP_MAX_PERIOD_SECONDS });
    if (period.error) {
        return { error: period.error };
    }
    const session = validateOptionalSession(input);
    if (session.error) {
        return { error: session.error };
    }
    const value = { action: "totp" };
    if (session.value) {
        value.session = session.value;
    }
    if (handle.value) {
        value.handle = handle.value;
    }
    if (otpSeed) {
        value.otpSeed = otpSeed;
    }
    if (digits.value !== undefined) {
        value.digits = digits.value;
    }
    if (period.value !== undefined) {
        value.period = period.value;
    }
    return { value };
}

function normalizeVaultRemove(input) {
    const unexpected = onlyAllowedVaultFields(input, "remove", new Set(["action", "handle"]));
    if (unexpected) {
        return { error: unexpected };
    }
    const handle = validateRequiredHandle(input);
    if (handle.error) {
        return { error: handle.error };
    }
    return { value: { action: "remove", handle: handle.value } };
}

function normalizeVaultUnlock(input) {
    const unexpected = onlyAllowedVaultFields(input, "unlock", new Set(["action", "minutes"]));
    if (unexpected) {
        return { error: unexpected };
    }
    const minutes = normalizeOptionalInteger(input, "minutes", "vault.unlock minutes", { min: 1, max: VAULT_UNLOCK_MAX_MINUTES });
    if (minutes.error) {
        return { error: minutes.error };
    }
    return { value: { action: "unlock", minutes: minutes.value ?? VAULT_UNLOCK_DEFAULT_MINUTES } };
}

export function normalizeVaultInput(input) {
    // `isRecord` accepts arrays, so reject them explicitly: an array here is always a mistake and the
    // generic action message would hide it.
    if (Array.isArray(input)) {
        return { error: `vault must be an object with an action of ${VAULT_ACTIONS.join(", ")}.` };
    }
    if (!isRecord(input)) {
        return { error: `vault must be an object with an action of ${VAULT_ACTIONS.join(", ")}.` };
    }
    const { action } = input;
    if (typeof action !== "string" || !VAULT_ACTIONS.includes(action)) {
        return { error: `vault.action must be one of: ${VAULT_ACTIONS.join(", ")}.` };
    }
    switch (action) {
        case "status":
            return normalizeVaultStatus(input);
        case "list":
            return normalizeVaultList(input);
        case "save":
            return normalizeVaultSave(input);
        case "fill":
            return normalizeVaultFill(input);
        case "totp":
            return normalizeVaultTotp(input);
        case "remove":
            return normalizeVaultRemove(input);
        case "unlock":
            return normalizeVaultUnlock(input);
        default:
            return { error: `vault.action must be one of: ${VAULT_ACTIONS.join(", ")}.` };
    }
}

function describeVaultActionSummary(value) {
    switch (value.action) {
        case "status":
            return "Report the credential vault location, key mode and saved entry counts.";
        case "list": {
            const scope = [value.type ? `${value.type} entries` : "saved entries"];
            if (value.origin) {
                scope.push(`for ${value.origin}`);
            }
            return `List ${scope.join(" ")} as metadata only (never a secret value).`;
        }
        case "save": {
            const parts = [`Save a ${value.type} entry "${value.handle}" bound to ${value.origin}`];
            if (value.secret) {
                parts.push("with a secret stored encrypted");
            }
            if (value.otpSeed) {
                parts.push("with an authenticator seed for automatic 2FA codes");
            }
            if (value.card) {
                parts.push("with card details that require confirmation on every fill");
            }
            if (value.username) {
                parts.push(`for identifier ${value.username}`);
            }
            parts.push(value.overwrite ? "overwriting any existing entry with that handle" : "without overwriting an existing handle");
            return `${parts.join(", ")}.`;
        }
        case "fill": {
            const roles = (value.fields ?? []).map((field) => field.role);
            const target = roles.length > 0 ? roles.join(", ") : "the saved entry's secret fields";
            return `Fill ${target} on ${value.origin}${value.handle ? ` from "${value.handle}"` : ""}${value.submit ? " and submit the form" : " without submitting"}.`;
        }
        case "totp":
            return value.handle
                ? `Generate the current one-time code for "${value.handle}" without revealing the seed.`
                : "Generate the current one-time code for the provided seed without revealing it.";
        case "remove":
            return `Remove the saved entry "${value.handle}".`;
        case "unlock":
            return `Unlock the external password manager for ${value.minutes} minutes so its logins become fillable.`;
        default:
            return "Credential vault action.";
    }
}

/**
 * Plan projection for `details` and for the caller's own gating. `context.entryType` (the type resolved
 * from the vault) and `context.hasStoredSecret` let the caller sharpen the two booleans without this
 * module ever touching the store. Neither the plan nor the summary contains a secret value.
 */
export function describeVaultPlan(value, context = {}) {
    if (!isRecord(value) || typeof value.action !== "string") {
        return { action: "unknown", requiresConfirmation: false, requiresPrompt: false, summary: "Unrecognized vault plan." };
    }
    const roles = (value.fields ?? []).map((field) => field.role);
    const entryType = typeof context.entryType === "string" ? context.entryType : undefined;
    const touchesCard = entryType === "card" || roles.some((role) => VAULT_CONFIRMATION_ROLES.includes(role));
    const touchesSecret = roles.some((role) => VAULT_SECRET_ROLES.includes(role));
    const requiresPrompt = value.action === "save"
        || value.action === "unlock"
        || (value.action === "fill" && value.promptIfMissing === true && (touchesSecret || value.handle === undefined || context.hasStoredSecret === false));
    return {
        action: value.action,
        requiresConfirmation: value.action === "fill" && touchesCard,
        requiresPrompt,
        summary: describeVaultActionSummary(value),
    };
}
