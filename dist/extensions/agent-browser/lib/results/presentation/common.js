import { isRecord } from "../../parsing.js";
import { redactSensitiveText, redactSensitiveValue } from "../../runtime.js";
import { stringifyUnknown, truncateText } from "../text.js";
const UNTITLED_PAGE_SUMMARY = "(untitled page)";
export function stringifyModelFacing(value) {
    return stringifyUnknown(redactSensitiveValue(value));
}
export function redactModelFacingText(text) {
    return redactSensitiveText(text);
}
export function getArrayField(data, key) {
    return Array.isArray(data[key]) ? data[key] : undefined;
}
export function getStringField(data, key) {
    const value = data[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
// `lifecycle` is upstream launch/reuse bookkeeping, never page content, so it must not be the
// answer an agent reads when a command has no dedicated presenter.
export function extractAgentBrowserLifecycle(result) {
    if (Array.isArray(result)) {
        let latest;
        for (const row of result) {
            const nested = isRecord(row) ? row.result ?? row.data ?? row : row;
            latest = extractAgentBrowserLifecycle(nested) ?? latest;
        }
        return latest;
    }
    if (!isRecord(result))
        return undefined;
    if (isRecord(result.lifecycle) && isRecord(result.lifecycle.effectiveLaunch)) {
        const browserLaunched = result.lifecycle.effectiveLaunch.browserLaunched;
        if (typeof browserLaunched === "boolean")
            return { effectiveLaunch: { browserLaunched } };
    }
    return extractAgentBrowserLifecycle(result.result ?? result.data);
}
export function omitUpstreamLifecycle(data) {
    const { lifecycle: _lifecycle, ...rest } = data;
    return rest;
}
export function getPageSummary(data) {
    const title = typeof data.title === "string" ? data.title : undefined;
    const url = typeof data.url === "string" ? data.url : undefined;
    if (title === undefined && url === undefined)
        return undefined;
    const summary = title && url ? `${title}\n${url}` : url || title || UNTITLED_PAGE_SUMMARY;
    const webmcp = isRecord(data.webmcp) ? data.webmcp : undefined;
    return webmcp?.available === true && typeof webmcp.toolCount === "number" && Number.isInteger(webmcp.toolCount) && webmcp.toolCount > 0
        ? `${summary}\n\nWebMCP tools are available on this page (experimental). Run webmcp list to view them.`
        : summary;
}
export function formatCount(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
}
export function firstLine(value, maxChars = 160) {
    return truncateText(value.split("\n", 1)[0] ?? value, maxChars);
}
