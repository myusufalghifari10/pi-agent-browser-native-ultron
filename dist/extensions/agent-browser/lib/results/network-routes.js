import { isRecord } from "../parsing.js";
import { redactSensitiveText } from "../runtime.js";
import { getStringRecordField, isApiLikeNetworkRequest } from "./network.js";
function getArrayField(data, key) {
    const value = data[key];
    return Array.isArray(value) ? value : undefined;
}
function networkRoutePatternMatchesUrl(pattern, url) {
    if (pattern === url)
        return true;
    if (pattern.includes("*")) {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
        return new RegExp(`^${escaped}$`).test(url);
    }
    return pattern.length >= 4 && url.includes(pattern);
}
function getSafeRequestId(item) {
    const requestId = getStringRecordField(item, "requestId") ?? getStringRecordField(item, "id");
    if (!requestId || redactSensitiveText(requestId) !== requestId)
        return undefined;
    return requestId;
}
function getRouteDiagnosticReason(item, route) {
    const statusMissing = typeof item.status !== "number";
    const error = getStringRecordField(item, "error") ?? getStringRecordField(item, "failureText") ?? getStringRecordField(item, "errorText");
    if (error && /(?:cors|cross-origin|preflight|access-control-allow-origin)/i.test(error))
        return "cors-likely-routed-request";
    if (statusMissing && isApiLikeNetworkRequest(item))
        return "pending-routed-request";
    if (route.mode !== "abort" && ((typeof item.status === "number" && item.status >= 400) || item.failed === true || typeof error === "string"))
        return "unfulfilled-routed-request";
    return undefined;
}
export function getNetworkRouteMode(args) {
    if (args.includes("--abort"))
        return "abort";
    if (args.includes("--body"))
        return "body";
    return "handler";
}
export function applyNetworkRouteRecords(routes, commandTokens, succeeded) {
    if (!succeeded || commandTokens?.[0] !== "network")
        return routes;
    const subcommand = commandTokens[1];
    if (subcommand !== "route" && subcommand !== "unroute")
        return routes;
    const existing = routes ?? [];
    const pattern = commandTokens[2];
    // wave23, reported by a reviewer lane and CONFIRMED by running it before fixing. `if (!pattern)
    // return undefined` did double damage: a `network unroute` with no pattern — or with an empty
    // string, which is indistinguishable from absent here — returned undefined, and the caller's
    // `next.delete(sessionName)` turned that into "erase every route for this session". The route
    // table then read empty, buildNetworkRouteDiagnostics returned undefined, and the unfulfilled /
    // CORS / pending-route diagnostics stopped firing with no message at all: a check that no longer
    // ran, reported as if there were nothing to report.
    //
    // Separately, `network route --abort` stored {mode:"abort", pattern:"--abort"} — the flag itself
    // persisted as a URL pattern. Verified by running it: the entry appeared in the route list.
    //
    // Both are now no-ops. Never destroying state on a malformed command is the floor: an incomplete
    // unroute leaves routes armed and upstream reports the usage error, whereas the old path
    // silently disarmed every mock the caller had configured.
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.startsWith("--"))
        return existing.length > 0 ? existing : undefined;
    if (subcommand === "route")
        return [...existing.filter((route) => route.pattern !== pattern), { mode: getNetworkRouteMode(commandTokens), pattern }];
    const next = existing.filter((route) => route.pattern !== pattern);
    return next.length > 0 ? next : undefined;
}
export function buildNetworkRouteDiagnostics(data, routes) {
    if (!routes || routes.length === 0 || !isRecord(data))
        return undefined;
    const requests = getArrayField(data, "requests");
    if (!requests)
        return undefined;
    const diagnostics = [];
    for (const item of requests) {
        if (!isRecord(item))
            continue;
        const url = getStringRecordField(item, "url");
        if (!url)
            continue;
        const route = routes.find((candidate) => networkRoutePatternMatchesUrl(candidate.pattern, url));
        if (!route)
            continue;
        const reason = getRouteDiagnosticReason(item, route);
        if (!reason)
            continue;
        const requestId = getSafeRequestId(item);
        const requestUrl = redactSensitiveText(url);
        const routePattern = redactSensitiveText(route.pattern);
        diagnostics.push({
            mode: route.mode,
            reason,
            ...(requestId ? { requestId } : {}),
            requestUrl,
            routePattern,
            summary: reason === "cors-likely-routed-request"
                ? `Routed request ${requestId ?? requestUrl} looks CORS/preflight-related for route ${routePattern}.`
                : reason === "unfulfilled-routed-request"
                    ? `Routed request ${requestId ?? requestUrl} failed instead of returning the configured route ${routePattern}.`
                    : `Routed request ${requestId ?? requestUrl} is still pending/no-status for route ${routePattern}.`,
        });
    }
    return diagnostics.length > 0 ? diagnostics.slice(0, 5) : undefined;
}
