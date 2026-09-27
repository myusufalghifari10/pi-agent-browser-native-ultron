// local patch: `settle` input mode — wait until the page is actually quiet.
//
// Why: upstream only gives coarse readiness (`wait --load`) or caller-authored
// `wait --fn` predicates. Agents that just want "the page finished doing stuff"
// had to guess a sleep. This mode compiles one bounded in-page probe that polls
// resource entries plus DOM mutations and resolves with counts only — never page
// content — so the model gets trustworthy "quiet" evidence at a bounded cost.
import { isRecord } from "../parsing.js";
export const SETTLE_DEFAULT_QUIET_MS = 500;
export const SETTLE_DEFAULT_TIMEOUT_MS = 10_000;
export const SETTLE_MAX_TIMEOUT_MS = 60_000;
export const SETTLE_MAX_QUIET_MS = 10_000;
export const SETTLE_POLL_INTERVAL_MS = 100;
export const SETTLE_MAX_SUMMARY_CHARS = 240;

function readPositiveIntegerOption(value, { fieldName, max, fallback }) {
    if (value === undefined)
        return { value: fallback };
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return { error: `${fieldName} must be a positive integer when provided.` };
    }
    if (value > max) {
        return { error: `${fieldName} must be ${max} or less.` };
    }
    return { value };
}

function readBooleanOption(value, { fieldName, fallback }) {
    if (value === undefined)
        return { value: fallback };
    if (typeof value !== "boolean") {
        return { error: `${fieldName} must be a boolean when provided.` };
    }
    return { value };
}

// Only validated numbers and booleans are interpolated into the generated source,
// so caller text can never inject script into the page probe.
function buildSettleProbeSource({ quietMs, timeoutMs, requireNetworkIdle, requireDomStable, }) {
    return `(async () => {
    const quietMs = ${quietMs};
    const timeoutMs = ${timeoutMs};
    const pollMs = ${SETTLE_POLL_INTERVAL_MS};
    const requireNetworkIdle = ${requireNetworkIdle};
    const requireDomStable = ${requireDomStable};
    const now = () => Date.now();
    const startedAt = now();
    let resourceCount = 0;
    let mutationCount = 0;
    let lastResourceAt = startedAt;
    let lastMutationAt = startedAt;
    let resourceObserver = null;
    let mutationObserver = null;
    const resourceCountNow = () => {
        try {
            const entries = performance.getEntriesByType("resource");
            return Array.isArray(entries) ? entries.length : 0;
        }
        catch {
            return 0;
        }
    };
    const disconnect = () => {
        try {
            resourceObserver?.disconnect();
        }
        catch { }
        try {
            mutationObserver?.disconnect();
        }
        catch { }
    };
    try {
        resourceCount = resourceCountNow();
        if (typeof PerformanceObserver === "function") {
            resourceObserver = new PerformanceObserver((list) => {
                try {
                    resourceCount += Array.isArray(list.getEntries()) ? list.getEntries().length : 0;
                }
                catch { }
                lastResourceAt = now();
            });
            resourceObserver.observe({ entryTypes: ["resource"] });
        }
    }
    catch {
        resourceObserver = null;
    }
    try {
        if (typeof MutationObserver === "function" && document.documentElement) {
            mutationObserver = new MutationObserver(() => {
                mutationCount += 1;
                lastMutationAt = now();
            });
            mutationObserver.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
        }
    }
    catch {
        mutationObserver = null;
    }
    const currentReason = () => {
        const readyState = String(document.readyState || "unknown");
        if (readyState !== "complete")
            return "not-ready";
        if (requireNetworkIdle && now() - lastResourceAt < quietMs)
            return "network-busy";
        if (requireDomStable && now() - lastMutationAt < quietMs)
            return "dom-busy";
        return "quiet";
    };
    let reason = currentReason();
    while (reason !== "quiet" && now() - startedAt < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        reason = currentReason();
    }
    const waitedMs = now() - startedAt;
    const timedOut = reason !== "quiet" && waitedMs >= timeoutMs;
    disconnect();
    return {
        settled: reason === "quiet",
        reason: reason === "quiet" ? "quiet" : timedOut ? "timeout" : reason,
        waitedMs,
        readyState: String(document.readyState || "unknown"),
        pendingResources: resourceCount,
        mutations: mutationCount,
        url: String(location.href || "about:blank"),
    };
})()`;
}

export function compileAgentBrowserSettle(input) {
    if (input !== undefined && !isRecord(input)) {
        return { error: "settle must be an object." };
    }
    const record = isRecord(input) ? input : {};
    const quietMsResult = readPositiveIntegerOption(record.quietMs, {
        fallback: SETTLE_DEFAULT_QUIET_MS,
        fieldName: "settle.quietMs",
        max: SETTLE_MAX_QUIET_MS,
    });
    if (quietMsResult.error)
        return { error: quietMsResult.error };
    const timeoutMsResult = readPositiveIntegerOption(record.timeoutMs, {
        fallback: SETTLE_DEFAULT_TIMEOUT_MS,
        fieldName: "settle.timeoutMs",
        max: SETTLE_MAX_TIMEOUT_MS,
    });
    if (timeoutMsResult.error)
        return { error: timeoutMsResult.error };
    const requireNetworkIdleResult = readBooleanOption(record.requireNetworkIdle, {
        fallback: true,
        fieldName: "settle.requireNetworkIdle",
    });
    if (requireNetworkIdleResult.error)
        return { error: requireNetworkIdleResult.error };
    const requireDomStableResult = readBooleanOption(record.requireDomStable, {
        fallback: true,
        fieldName: "settle.requireDomStable",
    });
    if (requireDomStableResult.error)
        return { error: requireDomStableResult.error };
    const quietMs = quietMsResult.value;
    const timeoutMs = Math.max(timeoutMsResult.value, quietMs + SETTLE_POLL_INTERVAL_MS);
    const budget = {
        quietMs,
        requireDomStable: requireDomStableResult.value,
        requireNetworkIdle: requireNetworkIdleResult.value,
        timeoutMs,
    };
    const stdin = buildSettleProbeSource(budget);
    return {
        compiled: {
            args: ["eval", "--stdin"],
            budget,
            query: { ...budget },
            stdin,
        },
    };
}

function unwrapSettlePayload(data) {
    if (isRecord(data) && isRecord(data.result))
        return data.result;
    if (isRecord(data) && isRecord(data.data))
        return data.data;
    return data;
}

function extractCount(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractText(value, maxChars) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length === 0)
        return undefined;
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

export function analyzeSettleResult(data) {
    let payload = unwrapSettlePayload(data);
    if (typeof payload === "string") {
        const text = payload.trim();
        if (text.startsWith("{") || text.startsWith("[")) {
            try {
                payload = JSON.parse(text);
            }
            catch {
                payload = undefined;
            }
        }
        if (typeof payload === "string" || payload === undefined) {
            const detail = extractText(text, SETTLE_MAX_SUMMARY_CHARS);
            return {
                reason: "eval-error",
                settled: false,
                summary: detail ? `Settle: probe failed (${detail}).` : "Settle: probe failed without a usable result.",
                waitedMs: undefined,
            };
        }
    }
    const record = isRecord(payload) ? payload : undefined;
    if (!record) {
        return {
            reason: "no-result",
            settled: false,
            summary: "Settle: no probe result was returned; page quietness is unverified.",
            waitedMs: undefined,
        };
    }
    const settled = record.settled === true;
    const reason = typeof record.reason === "string" && record.reason.trim().length > 0 ? record.reason : settled ? "quiet" : "unknown";
    const waitedMs = extractCount(record.waitedMs);
    const pendingResources = extractCount(record.pendingResources);
    const mutations = extractCount(record.mutations);
    const readyState = extractText(record.readyState, 32);
    const url = extractText(record.url, 120);
    const evidence = [
        readyState ? `readyState ${readyState}` : undefined,
        pendingResources === undefined ? undefined : `${pendingResources} resource(s)`,
        mutations === undefined ? undefined : `${mutations} mutation(s)`,
    ].filter((part) => part !== undefined);
    const spent = waitedMs === undefined ? "an unknown duration" : `${waitedMs} ms`;
    const where = url ? ` on ${url}` : "";
    const suffix = evidence.length > 0 ? ` (${evidence.join(", ")})` : "";
    return {
        reason,
        settled,
        summary: settled
            ? `Settle: page quiet after ${spent}${where}${suffix}.`
            : `Settle: page not quiet after ${spent}${where} (${reason})${suffix}.`,
        waitedMs,
    };
}
