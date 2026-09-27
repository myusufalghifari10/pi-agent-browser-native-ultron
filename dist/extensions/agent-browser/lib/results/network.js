import { isRecord } from "../parsing.js";
export function getStringRecordField(value, key) {
    const field = value[key];
    return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}
export function getNetworkRequestUrlPath(url) {
    if (!url)
        return undefined;
    try {
        return new URL(url).pathname;
    }
    catch {
        const withoutQuery = url.split(/[?#]/, 1)[0];
        return withoutQuery.length > 0 ? withoutQuery : undefined;
    }
}
function isFailedNetworkRequest(request) {
    return (typeof request.status === "number" && request.status >= 400) || request.failed === true || typeof request.error === "string";
}
export function isNetworkArtifactNoiseRequest(request) {
    const url = getStringRecordField(request, "url") ?? "";
    const resourceType = (getStringRecordField(request, "resourceType") ?? getStringRecordField(request, "mimeType") ?? "").toLowerCase();
    return /^data:image\//i.test(url) || (url.startsWith("data:") && resourceType.includes("image"));
}
function isBenignAssetFailure(request, url, resourceType) {
    const path = getNetworkRequestUrlPath(url);
    if (!path)
        return false;
    const normalizedResourceType = resourceType?.toLowerCase();
    return /(?:^|\/)(?:favicon(?:[-.\w]*)?\.(?:ico|png|svg)|apple-touch-icon(?:[-.\w]*)?\.png)$/i.test(path)
        && (request.status === 404 || request.failed === true || typeof request.error === "string")
        && (!normalizedResourceType || ["image", "img", "other"].includes(normalizedResourceType) || normalizedResourceType.startsWith("image/"));
}
export function isApiLikeNetworkRequest(request) {
    const method = (getStringRecordField(request, "method") ?? "GET").toUpperCase();
    const resourceType = (getStringRecordField(request, "resourceType") ?? "").toLowerCase();
    const mimeType = (getStringRecordField(request, "mimeType") ?? "").toLowerCase();
    const path = getNetworkRequestUrlPath(getStringRecordField(request, "url")) ?? "";
    return resourceType === "fetch" || resourceType === "xhr" || mimeType.includes("json") || /\/(?:api|graphql|rpc)(?:\/|$)/i.test(path) || !["GET", "HEAD"].includes(method);
}
export function classifyNetworkRequestFailure(request) {
    if (!isFailedNetworkRequest(request))
        return undefined;
    const url = getStringRecordField(request, "url");
    const resourceType = getStringRecordField(request, "resourceType") ?? getStringRecordField(request, "mimeType");
    const status = typeof request.status === "number" ? request.status : undefined;
    if (isBenignAssetFailure(request, url, resourceType)) {
        return { impact: "benign", reason: "low-impact browser icon asset", resourceType, status, url };
    }
    return { impact: "actionable", reason: "document, script, API, or non-benign request failure", resourceType, status, url };
}
export function summarizeNetworkFailures(requests) {
    const failures = requests.flatMap((request) => {
        if (!isRecord(request) || isNetworkArtifactNoiseRequest(request))
            return [];
        const classification = classifyNetworkRequestFailure(request);
        return classification ? [classification] : [];
    });
    const benignCount = failures.filter((failure) => failure.impact === "benign").length;
    return {
        actionableCount: failures.length - benignCount,
        benignCount,
        failures,
        totalCount: failures.length,
    };
}
