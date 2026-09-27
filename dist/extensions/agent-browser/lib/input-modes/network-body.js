// local patch: bounded on-demand request/response bodies (PATCHES.md P15).
//
// Why this exists: `network requests` lists rows without bodies, and the only upstream way to see a
// body today is a full HAR capture, which is heavy and leaks a lot of context. Upstream
// `network request <requestId>` does return full detail when the installed build records bodies, so
// the wrapper adds a narrow path to it: take an id (or a filter to find one), read one payload, and
// report honestly when no body was recorded at all.
//
// This module is pure: it validates input, compiles the upstream call, and analyzes the payload. It
// performs no I/O and never invents content - an absent body stays absent.
import { isRecord } from "../parsing.js";
export const NETWORK_BODY_DEFAULT_MAX_CHARS = 4000;
export const NETWORK_BODY_MAX_CHARS = 40000;
export const NETWORK_BODY_DIRECTIONS = ["response", "request", "both"];
const NETWORK_BODY_MAX_BODIES = 10;
const NETWORK_BODY_MAX_CANDIDATES = 10;
const MAX_CONTAINER_DEPTH = 6;
const CONTAINER_KEYS = ["requests", "items", "entries", "result", "rows", "data"];
// Explicit request/response keys keep the direction label honest. A bare `body` is genuinely
// ambiguous in upstream payloads, so it is labelled "unknown" instead of being guessed.
const REQUEST_BODY_KEYS = ["requestBody", "requestData", "postData"];
const RESPONSE_BODY_KEYS = ["responseBody", "responseData", "responseText"];
const AMBIGUOUS_BODY_KEYS = ["body"];
export function normalizeNetworkBodyInput(input) {
    if (!isRecord(input)) {
        return { error: "networkBody must be an object with requestId or urlFilter." };
    }
    const rawRequestId = input.requestId;
    if (rawRequestId !== undefined && (typeof rawRequestId !== "string" || rawRequestId.trim().length === 0)) {
        return { error: "networkBody.requestId must be a non-empty string when provided." };
    }
    const rawUrlFilter = input.urlFilter;
    if (rawUrlFilter !== undefined && (typeof rawUrlFilter !== "string" || rawUrlFilter.trim().length === 0)) {
        return { error: "networkBody.urlFilter must be a non-empty string when provided." };
    }
    if (rawUrlFilter !== undefined && rawUrlFilter.length > 200) {
        return { error: "networkBody.urlFilter must be 200 characters or fewer." };
    }
    const requestId = typeof rawRequestId === "string" ? rawRequestId.trim() : undefined;
    const urlFilter = typeof rawUrlFilter === "string" ? rawUrlFilter.trim() : undefined;
    if (requestId === undefined && urlFilter === undefined) {
        return { error: "networkBody requires requestId (from a `network requests` row) or urlFilter to find one." };
    }
    let direction = "both";
    if (input.direction !== undefined) {
        if (typeof input.direction !== "string" || !NETWORK_BODY_DIRECTIONS.includes(input.direction.trim().toLowerCase())) {
            return { error: `networkBody.direction must be one of ${NETWORK_BODY_DIRECTIONS.join(", ")}.` };
        }
        direction = input.direction.trim().toLowerCase();
    }
    const rawMaxChars = input.maxChars;
    if (rawMaxChars !== undefined && (typeof rawMaxChars !== "number" || !Number.isInteger(rawMaxChars) || rawMaxChars <= 0)) {
        return { error: "networkBody.maxChars must be a positive integer when provided." };
    }
    let maxChars = typeof rawMaxChars === "number" ? rawMaxChars : NETWORK_BODY_DEFAULT_MAX_CHARS;
    let clampedFrom;
    if (maxChars > NETWORK_BODY_MAX_CHARS) {
        clampedFrom = maxChars;
        maxChars = NETWORK_BODY_MAX_CHARS;
    }
    return { value: { clampedFrom, direction, maxChars, requestId, urlFilter } };
}
export function compileNetworkBodyRequest({ requestId, urlFilter } = {}) {
    if (typeof requestId === "string" && requestId.trim().length > 0) {
        const id = requestId.trim();
        return {
            args: ["network", "request", id],
            note: `Reading full detail for request ${id}. Bodies only appear when the installed agent-browser build recorded them; when they are missing, start a HAR capture with content instead.`,
        };
    }
    if (typeof urlFilter === "string" && urlFilter.trim().length > 0) {
        return {
            args: ["network", "requests", "--filter", urlFilter.trim()],
            note: "Request lists usually omit bodies: read the requestId from a matching row, then call networkBody again with that id.",
        };
    }
    return {
        args: [],
        error: "networkBody needs requestId or urlFilter to know which request to read.",
        note: undefined,
    };
}
function looksLikeBatchStep(value) {
    // Batch results wrap each row as { command, success, result }: the useful payload is inside
    // `result`, so a batch-shaped input must be descended into instead of treated as one row.
    return isRecord(value) && Array.isArray(value.command);
}
function expandRowItem(value, depth) {
    if (depth > MAX_CONTAINER_DEPTH || !isRecord(value)) {
        return [];
    }
    if (looksLikeBatchStep(value)) {
        const inner = value.result;
        if (isRecord(inner)) {
            return collectNetworkRows(inner, depth + 1);
        }
        if (Array.isArray(inner)) {
            return inner.filter(isRecord);
        }
    }
    return [value];
}
function collectNetworkRows(payload, depth = 0) {
    if (depth > MAX_CONTAINER_DEPTH) {
        return [];
    }
    if (Array.isArray(payload)) {
        const rows = [];
        for (const item of payload) {
            rows.push(...expandRowItem(item, depth));
        }
        return rows;
    }
    if (!isRecord(payload)) {
        return [];
    }
    const rows = [];
    let sawContainer = false;
    for (const key of CONTAINER_KEYS) {
        const value = payload[key];
        if (Array.isArray(value)) {
            sawContainer = true;
            for (const item of value) {
                rows.push(...expandRowItem(item, depth));
            }
        }
        else if (isRecord(value)) {
            sawContainer = true;
            rows.push(...collectNetworkRows(value, depth + 1));
        }
    }
    if (!sawContainer) {
        rows.push(payload);
    }
    return rows;
}
function readBoundedText(value) {
    if (typeof value === "string") {
        return { text: value };
    }
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return { text: String(value) };
    }
    if (Array.isArray(value)) {
        try {
            return { text: JSON.stringify(value) };
        }
        catch {
            return undefined;
        }
    }
    if (isRecord(value)) {
        // Playwright-style payloads wrap content as { text } or { buffer/base64 }.
        if (typeof value.text === "string") {
            return { text: value.text };
        }
        if (typeof value.base64 === "string") {
            return { encoding: "base64", text: "" };
        }
        try {
            return { text: JSON.stringify(value) };
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function readBodyCandidate(row, keys) {
    for (const key of keys) {
        const direct = row[key];
        if (direct !== undefined) {
            const read = readBoundedText(direct);
            if (read) {
                return read;
            }
        }
        // Also accept a nested wrapper such as { request: { body } } / { response: { body } }.
        const nested = isRecord(row.request) && row.request[key] !== undefined
            ? readBoundedText(row.request[key])
            : undefined;
        if (nested) {
            return nested;
        }
        const nestedResponse = isRecord(row.response) && row.response[key] !== undefined
            ? readBoundedText(row.response[key])
            : undefined;
        if (nestedResponse) {
            return nestedResponse;
        }
    }
    return undefined;
}
function readRowUrl(row) {
    for (const key of ["url", "requestUrl", "href"]) {
        if (typeof row[key] === "string" && row[key].trim().length > 0) {
            return row[key].trim();
        }
    }
    if (isRecord(row.request) && typeof row.request.url === "string" && row.request.url.trim().length > 0) {
        return row.request.url.trim();
    }
    return undefined;
}
function readRowRequestId(row) {
    for (const key of ["requestId", "id", "request_id"]) {
        if (typeof row[key] === "string" && row[key].trim().length > 0) {
            return row[key].trim();
        }
    }
    return undefined;
}
function readRowContentType(row) {
    for (const key of ["contentType", "responseContentType", "mimeType"]) {
        if (typeof row[key] === "string" && row[key].trim().length > 0) {
            return row[key].trim();
        }
    }
    if (isRecord(row.response) && typeof row.response.contentType === "string" && row.response.contentType.trim().length > 0) {
        return row.response.contentType.trim();
    }
    return undefined;
}
function normalizeDirection(value) {
    return NETWORK_BODY_DIRECTIONS.includes(value) ? value : "unknown";
}
function isDirectionRequested(direction, requested) {
    if (requested === "both") {
        return true;
    }
    // An unlabelled body is only meaningful when the caller did not narrow the direction.
    return direction === requested;
}
function truncateText(text, maxChars) {
    if (text.length <= maxChars) {
        return { chars: text.length, text, truncated: false };
    }
    return { chars: text.length, text: text.slice(0, maxChars), truncated: true };
}
/**
 * Analyze an upstream `network request` / `network requests` payload. Never invents content: a row
 * without a recorded body is reported through `missingReason` plus (for lists) the ids to fetch.
 */
export function extractNetworkBodies(payload, options = {}) {
    const maxChars = typeof options.maxChars === "number" && options.maxChars > 0
        ? Math.min(options.maxChars, NETWORK_BODY_MAX_CHARS)
        : NETWORK_BODY_DEFAULT_MAX_CHARS;
    const requestedDirection = NETWORK_BODY_DIRECTIONS.includes(options.direction) ? options.direction : "both";
    const rows = collectNetworkRows(payload);
    const bodies = [];
    const candidates = [];
    for (const row of rows) {
        const requestId = readRowRequestId(row);
        const url = readRowUrl(row);
        if (requestId && url && candidates.length < NETWORK_BODY_MAX_CANDIDATES) {
            candidates.push({ requestId, url });
        }
        if (bodies.length >= NETWORK_BODY_MAX_BODIES) {
            continue;
        }
        const found = [
            { direction: "request", keys: REQUEST_BODY_KEYS },
            { direction: "response", keys: RESPONSE_BODY_KEYS },
            { direction: "unknown", keys: AMBIGUOUS_BODY_KEYS },
        ];
        for (const group of found) {
            if (!isDirectionRequested(group.direction, requestedDirection)) {
                continue;
            }
            const read = readBodyCandidate(row, group.keys);
            if (!read) {
                continue;
            }
            const truncated = truncateText(read.text, maxChars);
            bodies.push({
                chars: truncated.chars,
                contentType: readRowContentType(row),
                direction: normalizeDirection(group.direction),
                encoding: read.encoding,
                requestId,
                text: truncated.text,
                truncated: truncated.truncated,
                url,
            });
            break;
        }
    }
    if (bodies.length > 0) {
        return { bodies };
    }
    if (candidates.length > 0) {
        return { bodies: [], candidates, missingReason: "body-not-in-list" };
    }
    return { bodies: [], missingReason: "no-body-available" };
}
export function describeNetworkBodyResult(result) {
    const bodies = Array.isArray(result?.bodies) ? result.bodies : [];
    if (bodies.length > 0) {
        const truncatedCount = bodies.filter((body) => body?.truncated === true).length;
        const unknownCount = bodies.filter((body) => body?.direction === "unknown").length;
        const base64Count = bodies.filter((body) => body?.encoding === "base64").length;
        const parts = [`Read ${bodies.length} body payload(s)`];
        if (truncatedCount > 0) {
            parts.push(`${truncatedCount} truncated at the requested limit`);
        }
        const notes = [];
        if (unknownCount > 0) {
            notes.push(`${unknownCount} body(s) were not labelled as request or response by the installed build`);
        }
        if (base64Count > 0) {
            notes.push(`${base64Count} body(s) were base64 only, so no text is shown`);
        }
        const suffix = notes.length > 0 ? ` Note: ${notes.join("; ")}.` : "";
        return `${parts.join("; ")}. This is the payload the browser recorded, not proof of how the application handled it.${suffix}`;
    }
    if (result?.missingReason === "body-not-in-list") {
        const count = Array.isArray(result?.candidates) ? result.candidates.length : 0;
        return `No bodies are included in a request list. ${count} candidate row(s) are listed: read one requestId and call networkBody again with it to fetch that request's detail.`;
    }
    return "No request or response body is present for this row. The installed build may not record bodies (or the body was empty), so nothing is inferred here. A HAR capture started before the request is the fallback.";
}
