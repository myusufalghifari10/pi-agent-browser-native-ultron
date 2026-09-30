import { isRecord } from "../parsing.js";
import { SOURCE_LOOKUP_DEFAULT_MAX_WORKSPACE_FILES, SOURCE_LOOKUP_MAX_WORKSPACE_FILES } from "./types.js";
export function getSelectValues(input, context) {
    const rawValue = input.value;
    const rawValues = input.values;
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
// It is defined ONCE here because five separate call sites hit it, and they were each being fixed
// individually: batch stdin (retired), job.steps, debug.expectedText, cdp.commands, and the
// electron string-array fields. Each of those looked like an unrelated bug and was not.
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
