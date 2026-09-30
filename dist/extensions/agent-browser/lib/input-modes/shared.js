import { isRecord } from "../parsing.js";
import { SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES, SOURCE_LOOKUP_MAX_WORKSPACE_FILES } from "./types.js";
export function getSelectValues(input, context) {
    const rawValue = input.value;
    // select accepts either `value` (one string) or `values` (an array); both are caller-supplied
    // array parameters and both were refused by the host. Confirmed live: a job step carrying
    // values: ["a","b"] came back as "job.steps must be a non-empty array" for a correct payload.
    const rawValues = unwrapItemEnvelope(input.values);
    if (rawValue !== undefined && rawValues !== undefined) {
        return { error: `${context}.value and ${context}.values cannot both be provided for select.` };
    }
    if (rawValues !== undefined) {
        if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.some((value) => typeof value !== "string" || value.trim().length === 0)) {
            return { error: `${context}.values must be a non-empty array of non-empty strings for select.` };
        }
        return { values: rawValues };
    }
    if (typeof rawValue === "string" && rawValue.trim().length > 0) {
        return { values: [rawValue] };
    }
    return { error: `${context}.value or ${context}.values is required for select.` };
}
export function getBatchResultItems(data) {
    return Array.isArray(data) ? data.filter(isRecord) : [];
}
export function getCommandNameFromBatchItem(item) {
    const command = item.command;
    return Array.isArray(command) && typeof command[0] === "string" ? command[0] : undefined;
}
export function validateLookupMaxWorkspaceFiles(value, fieldName) {
    if (value === undefined)
        return { value: SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES };
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return { error: `${fieldName} must be a positive integer when provided.` };
    }
    if (value > SOURCE_LOOKUP_MAX_WORKSPACE_FILES) {
        return { error: `${fieldName} must be ${SOURCE_LOOKUP_MAX_WORKSPACE_FILES} or less.` };
    }
    return { value };
}

// The host's array-parameter envelope. Upstream: this Pi build serialises every tool parameter to a
// string (earendil-works/pi#4226) and its runner wraps a NESTED array parameter in an object whose
// only key is `item` (hermes-agent#104803), so a caller-supplied array arrives as {item: [...]}.
//
// It is defined ONCE here because this host defect shows up at every caller-supplied array
// parameter, and each site was initially being fixed on its own and read as an unrelated bug:
// batch stdin (retired as a caller command), job.steps, debug.expectedText, cdp.commands,
// qa.expectedText, select `values`, the electron string-array fields, and vault.fill.fields.
//
// An earlier version of this comment claimed electron was part of the fix while electron.js never
// imported the helper, and a test repeated the claim while only checking three files. Both were
// wrong and both were found by a review lane rather than by reading the code. tests-v2/
// wave23-host-array-envelope.mjs now checks every site listed above and asserts that each one
// imports the helper rather than re-declaring it.
//
// Unwrapping is positional on purpose and never recursive. A blanket deep strip would corrupt
// cdp.commands[].params, which is free-form JSON handed straight to the browser, where a
// legitimate CDP parameter really can be named `item`. So each call site unwraps the positions its
// own schema declares as arrays, and nothing descends into pass-through payloads.
export function isItemEnvelope(value) {
    return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && "item" in value;
}

/** Unwrap the envelope one level. Returns the value unchanged when it is not an envelope. */
export function unwrapItemEnvelope(value) {
    return isItemEnvelope(value) ? value.item : value;
}

// The host has been seen wrapping the SAME array twice, which a single-level strip does not survive.
// Confirmed live: a payload shaped {item:{item:[...]}} — which is what a caller re-wrapping an
// already-wrapped payload produces — was refused with the outer error while the plain form of the
// same job worked. Bounded, because this is a loop over attacker-shaped input; the cap only limits
// wasted work, since an over-deep value simply stops being stripped.
//
// Still only ever applied POSITIONALLY, never to a whole payload: cdp.commands[].params is
// free-form JSON handed to the browser where a single-key {item: ...} is DATA, and unwrapping it
// would silently rewrite the caller's CDP request.
const MAX_ITEM_ENVELOPE_DEPTH = 8;
export function unwrapItemEnvelopeDeep(value) {
    let current = value;
    for (let depth = 0; depth < MAX_ITEM_ENVELOPE_DEPTH; depth += 1) {
        if (!isItemEnvelope(current))
            return current;
        current = current.item;
    }
    return current;
}
