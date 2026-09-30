// local patch: session-scoped diagnostics de-duplication buffer.
//
// Why: upstream 0.37.0 does not actually purge its console/error buffer on
// `console --clear` / `errors --clear` (verified live: a cleared page error
// reappears on the next read), so a "what happened since my last read" window
// cannot be derived from upstream state. Instead the wrapper fingerprints every
// diagnostic row it has already shown the model and can then ask for only the
// rows never observed before in this session.
//
// The state is plain JSON so it can be written into tool `details`.
//
// It is WRITTEN there and NOT read back. A reviewer lane checked for a restore path and found none:
// the sibling restore in index.js rebuilds sessionPageState, the artifact manifest, recording
// reservations and electron records from the transcript, and has no line for this buffer. So after a
// /reload or /resume the first read re-announces every already-seen row as new.
//
// This comment previously claimed the replay worked, which made the missing restore look like a
// detail rather than a behaviour. Building the restore is a real feature and is not done here;
// what is done is that the limitation is stated where a caller will meet it — the "N new" wording
// below no longer claims a comparison the wrapper cannot actually make.
import { isRecord } from "./parsing.js";

export const DIAGNOSTICS_BUFFER_STATE_VERSION = 1;
// Bounded so a long-running session cannot grow the persisted state without
// limit; newest fingerprints win and old ones are dropped first.
const DEFAULT_SEEN_CAP = 2000;
// Unknown stream names are accepted (callers may add streams), but the number of
// tracked streams stays bounded so a mis-named stream per call cannot leak.
const DEFAULT_MAX_STREAMS = 32;
// Fingerprints are bounded for persistence; longer keys are truncated and
// disambiguated with a hash so two long rows with a shared prefix stay distinct.
const FINGERPRINT_MAX_CHARS = 400;
const FINGERPRINT_HASH_CHARS = 8;
const FALLBACK_MAX_DEPTH = 3;
const FALLBACK_MAX_ARRAY_ITEMS = 12;
const FALLBACK_MAX_STRING_CHARS = 120;
const FALLBACK_MAX_OBJECT_KEYS = 24;

// Salient field names per stream, in a fixed order so the fingerprint never
// depends on object key order.
const FIELD_ALIASES = {
    type: ["type", "level"],
    text: ["text", "message"],
    location: ["location"],
    url: ["url"],
    method: ["method"],
    status: ["status"],
    requestId: ["requestId", "request_id", "id"],
    timestamp: ["timestamp", "ts", "time"],
};
const STREAM_FIELD_ORDER = {
    console: ["type", "text", "location", "timestamp"],
    errors: ["type", "text", "location", "timestamp"],
    network: ["method", "url", "status", "requestId"],
    requests: ["method", "url", "status", "requestId"],
};
// Unknown streams accept every salient field; a row then self-describes enough
// to stay stable without a stream-specific schema.
const UNKNOWN_STREAM_FIELD_ORDER = ["type", "text", "location", "url", "method", "status", "requestId", "timestamp"];

export function createDiagnosticsBufferState() {
    return { streams: {}, version: DIAGNOSTICS_BUFFER_STATE_VERSION };
}

export function fingerprintDiagnosticRow(stream, row) {
    const streamName = normalizeStreamName(stream);
    const key = isFingerprintableRecord(row) ? fingerprintRecord(streamName, row) : `${typeof row}:${stableFallback(row, 0)}`;
    const joined = `${streamName}\u0000${key}`;
    if (joined.length <= FINGERPRINT_MAX_CHARS)
        return joined;
    const headChars = FINGERPRINT_MAX_CHARS - FINGERPRINT_HASH_CHARS - 1;
    return `${joined.slice(0, headChars)}#${fnv1aHex(joined, FINGERPRINT_HASH_CHARS)}`;
}

export function partitionDiagnosticRows(state, stream, rows, options = {}) {
    const streamName = normalizeStreamName(stream);
    const cap = normalizeCap(options.cap, DEFAULT_SEEN_CAP);
    const maxStreams = normalizeCap(options.maxStreams, DEFAULT_MAX_STREAMS);
    const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const next = normalizeState(state);
    const existing = next.streams[streamName];
    // Membership is taken from the state that entered this call only: two
    // identical rows inside one input array are both new, so a repeated event in
    // a single read window is never silently dropped.
    const known = new Set(existing ? existing.seen : []);
    const rowList = Array.isArray(rows) ? rows : [];
    const newRows = [];
    const seenRows = [];
    const added = [];
    const addedKnown = new Set();
    for (const row of rowList) {
        const fingerprint = fingerprintDiagnosticRow(streamName, row);
        if (known.has(fingerprint)) {
            seenRows.push(row);
            continue;
        }
        newRows.push(row);
        if (!addedKnown.has(fingerprint)) {
            addedKnown.add(fingerprint);
            added.push(fingerprint);
        }
    }
    const combined = (existing ? existing.seen : []).concat(added);
    const evictedCount = Math.max(0, combined.length - cap);
    const trimmed = evictedCount > 0 ? combined.slice(evictedCount) : combined;
    const streams = {};
    for (const [name, entry] of Object.entries(next.streams))
        streams[name] = entry;
    // Always the newest entry for this stream, whether it existed before or not.
    streams[streamName] = { seen: trimmed, updatedAtMs: nowMs };
    evictOldestStreams(streams, streamName, maxStreams);
    return {
        newCount: newRows.length,
        newRows,
        // True when this call had to evict fingerprints to stay within `cap`,
        // including fingerprints added by this same call. The buffer is then no
        // longer a complete record of everything it has seen, so an old row can
        // legitimately surface as "new" again later.
        overflow: evictedCount > 0,
        seenCount: seenRows.length,
        seenRows,
        state: { streams, updatedAtMs: nowMs, version: DIAGNOSTICS_BUFFER_STATE_VERSION },
    };
}

export function countNewDiagnosticRows(state, stream, rows) {
    const streamName = normalizeStreamName(stream);
    const existing = normalizeState(state).streams[streamName];
    const rowList = Array.isArray(rows) ? rows : [];
    if (!existing || existing.seen.length === 0)
        return rowList.length;
    const known = new Set(existing.seen);
    let count = 0;
    for (const row of rowList) {
        if (!known.has(fingerprintDiagnosticRow(streamName, row)))
            count += 1;
    }
    return count;
}

export function describeDiagnosticsBuffer(state) {
    const normalized = normalizeState(state);
    const streams = {};
    for (const [name, entry] of Object.entries(normalized.streams))
        streams[name] = { seen: entry.seen.length };
    const description = { streams };
    if (typeof normalized.updatedAtMs === "number")
        description.updatedAtMs = normalized.updatedAtMs;
    return description;
}

export function resetDiagnosticsBufferStream(state, stream) {
    const streamName = normalizeStreamName(stream);
    const normalized = normalizeState(state);
    const streams = {};
    for (const [name, entry] of Object.entries(normalized.streams)) {
        if (name !== streamName)
            streams[name] = entry;
    }
    const reset = { streams, version: DIAGNOSTICS_BUFFER_STATE_VERSION };
    if (typeof normalized.updatedAtMs === "number")
        reset.updatedAtMs = normalized.updatedAtMs;
    return reset;
}

function normalizeState(state) {
    // Tolerates a missing, older, or hand-edited state: anything unreadable is
    // treated as empty rather than throwing, so a bad transcript row cannot break
    // a diagnostics call.
    const streams = {};
    if (isRecord(state) && isRecord(state.streams)) {
        for (const [name, rawEntry] of Object.entries(state.streams)) {
            const rawSeen = Array.isArray(rawEntry) ? rawEntry : isRecord(rawEntry) && Array.isArray(rawEntry.seen) ? rawEntry.seen : [];
            const seen = rawSeen.filter((item) => typeof item === "string" && item.length > 0);
            const entry = { seen };
            if (isRecord(rawEntry) && typeof rawEntry.updatedAtMs === "number")
                entry.updatedAtMs = rawEntry.updatedAtMs;
            streams[name] = entry;
        }
    }
    const normalized = { streams, version: DIAGNOSTICS_BUFFER_STATE_VERSION };
    if (isRecord(state) && typeof state.updatedAtMs === "number")
        normalized.updatedAtMs = state.updatedAtMs;
    return normalized;
}

function normalizeStreamName(stream) {
    return typeof stream === "string" && stream.trim().length > 0 ? stream.trim() : "unknown";
}

function normalizeCap(value, fallback) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return fallback;
    const floored = Math.floor(value);
    if (floored < 1)
        return 1;
    return Math.min(floored, 100_000);
}

function isFingerprintableRecord(row) {
    return isRecord(row) && !Array.isArray(row);
}

function fingerprintRecord(streamName, row) {
    const order = STREAM_FIELD_ORDER[streamName] ?? UNKNOWN_STREAM_FIELD_ORDER;
    const parts = [];
    for (const field of order) {
        const value = pickField(row, FIELD_ALIASES[field] ?? [field]);
        if (value === undefined)
            continue;
        parts.push(`${field}=${value}`);
    }
    // Rows without any salient field still need a stable identity, so fall back
    // to a key-sorted serialization of primitives.
    return parts.length > 0 ? parts.join("|") : stableFallback(row, 0);
}

function pickField(row, names) {
    for (const name of names) {
        if (!Object.prototype.hasOwnProperty.call(row, name))
            continue;
        const value = row[name];
        if (value === undefined || value === null)
            continue;
        // Nested structures are not part of a row's identity here; falling
        // through to the fallback serializer keeps the fingerprint stable.
        if (typeof value === "object")
            continue;
        if (typeof value === "string" && value.length === 0)
            continue;
        return value;
    }
    return undefined;
}

function stableFallback(value, depth) {
    if (value === null || value === undefined)
        return "null";
    const type = typeof value;
    if (type === "string") {
        const bounded = value.length > FALLBACK_MAX_STRING_CHARS ? value.slice(0, FALLBACK_MAX_STRING_CHARS) : value;
        return JSON.stringify(bounded);
    }
    if (type === "number" || type === "boolean" || type === "bigint")
        return String(value);
    if (type === "function" || type === "symbol")
        return type;
    if (depth >= FALLBACK_MAX_DEPTH)
        return Array.isArray(value) ? "[array]" : "[object]";
    if (Array.isArray(value)) {
        const items = value.slice(0, FALLBACK_MAX_ARRAY_ITEMS).map((item) => stableFallback(item, depth + 1));
        if (value.length > FALLBACK_MAX_ARRAY_ITEMS)
            items.push("...");
        return `[${items.join(",")}]`;
    }
    const keys = Object.keys(value).sort().slice(0, FALLBACK_MAX_OBJECT_KEYS);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableFallback(value[key], depth + 1)}`).join(",")}}`;
}

// FNV-1a keeps the module dependency-free while making truncated fingerprints
// distinct; it is a collision aid, not a security primitive.
function fnv1aHex(input, chars) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0").slice(0, chars);
}

function evictOldestStreams(streams, keepStreamName, maxStreams) {
    const names = Object.keys(streams);
    if (names.length <= maxStreams)
        return;
    const removable = names
        .filter((name) => name !== keepStreamName)
        .sort((left, right) => (streams[left].updatedAtMs ?? 0) - (streams[right].updatedAtMs ?? 0));
    for (const name of removable) {
        if (Object.keys(streams).length <= maxStreams)
            return;
        delete streams[name];
    }
}
