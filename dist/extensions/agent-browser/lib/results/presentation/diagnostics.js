import { isRecord } from "../../parsing.js";
import { redactSensitiveText, redactSensitiveValue } from "../../runtime.js";
import { classifyNetworkRequestFailure, isApiLikeNetworkRequest, isNetworkArtifactNoiseRequest, summarizeNetworkFailures } from "../network.js";
import { withOptionalSessionArgs } from "../next-actions.js";
import { stringifyUnknown, truncateText } from "../text.js";
import { firstLine, formatCount, getArrayField, getStringField, redactModelFacingText, stringifyModelFacing, } from "./common.js";
const DIAGNOSTIC_REQUEST_PREVIEW_LIMIT = 40;
const DIAGNOSTIC_LOG_PREVIEW_LIMIT = 80;
const NETWORK_BODY_PREVIEW_MAX_CHARS = 280;
const NETWORK_ERROR_PREVIEW_MAX_CHARS = 220;
const NETWORK_NEXT_ACTION_LIMIT = 6;
const NETWORK_FILTER_MAX_CHARS = 160;
const STORAGE_VALUE_PREVIEW_MAX_CHARS = 160;
const STORAGE_SECRET_KEY_PATTERN = /(?:access(?:_|-)?token|account|api(?:_|-)?key|auth(?:orization)?|bearer|client(?:_|-)?secret|cookie|credential|csrf|email|id(?:_|-)?token|jwt|pass(?:word)?|private(?:_|-)?key|profile|refresh(?:_|-)?token|secret|session|sid|sig(?:nature)?|token|user(?:name)?|x(?:_|-)?api(?:_|-)?key|xsrf)/i;
const STORAGE_BENIGN_KEY_PATTERN = /^(?:color(?:scheme)?|debug|dev|experiment|feature(?:flag)?|flag|language|layout|locale|mode|onboarding|sort|tab|theme|timezone|tour|variant|view)$/i;
const STORAGE_TOKEN_VALUE_PATTERN = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bBasic\s+[A-Za-z0-9+/=]+|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_~+/=-]{32,})/;
const STORAGE_SECRET_VALUE_WORD_PATTERN = /(?:secret|token|password|passwd|bearer|credential|authorization|cookie|session[-_ ]?id)/i;
const STORAGE_EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STORAGE_IDENTITY_VALUE_PATTERN = /(?:^|[\s:=/_-])(?:account|profile|session|sid|user(?:id|name)?)(?:[\s:=/_-]|$)/i;
const NETWORK_FILTER_SENSITIVE_SEGMENT_TERMS = [
    "apikey",
    "api-key",
    "api_key",
    "authentication",
    "authorization",
    "bearer",
    "credential",
    "credentials",
    "jwt",
    "passwd",
    "password",
    "reset",
    "secret",
    "session",
    "token",
];
const NETWORK_FILTER_OPAQUE_SEGMENT_PATTERN = /^(?:[A-Fa-f0-9]{16,}|(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{16,})$/;
const NETWORK_PREVIEW_FIELD_CANDIDATES = {
    request: ["postData"],
    response: ["responseBody"],
    error: ["error", "failureText", "errorText"],
};
const AUTH_SHOW_SAFE_FIELDS = ["name", "profile", "url", "username", "createdAt", "updatedAt"];
export function getTabSummary(data) {
    const tabs = Array.isArray(data.tabs) ? data.tabs : undefined;
    if (!tabs)
        return undefined;
    const lines = tabs.map((tab, index) => {
        if (!isRecord(tab))
            return `${index}: <invalid tab>`;
        const marker = tab.active === true ? "*" : "-";
        const title = typeof tab.title === "string" ? tab.title : "(untitled)";
        const url = typeof tab.url === "string" ? tab.url : "(no url)";
        const label = typeof tab.label === "string" && tab.label.trim().length > 0 ? tab.label.trim() : undefined;
        const tabSelector = typeof tab.tabId === "string" && tab.tabId.trim().length > 0
            ? tab.tabId.trim()
            : label
                ? label
                : typeof tab.index === "number"
                    ? String(tab.index)
                    : String(index);
        const labelText = label && label !== tabSelector ? ` label=${redactModelFacingText(label)}` : "";
        const targetId = typeof tab.targetId === "string" && tab.targetId.trim().length > 0 ? tab.targetId.trim() : undefined;
        const targetText = targetId && targetId !== tabSelector ? ` target=${redactModelFacingText(targetId)}` : "";
        return `${marker} [${tabSelector}]${labelText}${targetText} ${title} — ${url}`;
    });
    return lines.join("\n");
}
export function getStreamSummary(data) {
    if (data.alreadyEnabled === true) {
        const lines = ["Stream already enabled (idempotent no-op)."];
        if (typeof data.port === "number") {
            lines.push(`Port: ${data.port}`);
            lines.push(`WebSocket URL: ${getStreamWebSocketUrl(data.port)}`);
        }
        lines.push("Run stream status for current connection details or stream disable when streaming is no longer needed.");
        return lines.join("\n");
    }
    if (typeof data.enabled !== "boolean" || typeof data.connected !== "boolean") {
        return undefined;
    }
    const lines = [
        `Enabled: ${data.enabled}`,
        `Connected: ${data.connected}`,
        `Screencasting: ${data.screencasting === true}`,
    ];
    if (typeof data.port === "number") {
        lines.push(`Port: ${data.port}`);
        lines.push(`WebSocket URL: ${getStreamWebSocketUrl(data.port)}`);
        lines.push(`Frame format: JSON messages with base64 JPEG frame data`);
    }
    return lines.join("\n");
}
function getStreamWebSocketUrl(port) {
    return `ws://127.0.0.1:${port}`;
}
export function enrichStreamStatusData(commandInfo, data) {
    if (commandInfo.command !== "stream" || commandInfo.subcommand !== "status" || !isRecord(data) || typeof data.port !== "number") {
        return data;
    }
    return {
        ...data,
        frameFormat: "JSON messages with base64 JPEG frame data",
        wsUrl: getStreamWebSocketUrl(data.port),
    };
}
function isClearDiagnosticCommand(commandInfo) {
    return commandInfo.subcommand === "--clear" || commandInfo.commandTokens?.includes("--clear") === true;
}
export function formatDiagnosticSummary(commandInfo, data) {
    if (commandInfo.command === "session") {
        const sessions = getArrayField(data, "sessions");
        if (sessions)
            return `Sessions: ${sessions.length}`;
        const session = getStringField(data, "session");
        if (session)
            return `Session: ${session}`;
    }
    if (commandInfo.command === "profiles") {
        const profiles = getArrayField(data, "profiles");
        if (profiles)
            return `Chrome profiles: ${profiles.length}`;
    }
    if (commandInfo.command === "auth") {
        const profiles = getArrayField(data, "profiles");
        if (profiles)
            return `Auth profiles: ${profiles.length}`;
        const name = getStringField(data, "name") ?? getStringField(data, "profile") ?? commandInfo.subcommand;
        if (name && commandInfo.subcommand === "show")
            return `Auth profile: ${name}`;
        if (name && ["save", "login", "delete"].includes(commandInfo.subcommand ?? ""))
            return `Auth ${commandInfo.subcommand}: ${name}`;
    }
    if (commandInfo.command === "cookies") {
        const cookies = getArrayField(data, "cookies");
        if (cookies)
            return `Cookies: ${cookies.length}`;
        const name = getStringField(data, "name");
        if (name)
            return name;
        if (data.set === true)
            return "Cookie set";
        if (data.cleared === true || data.clear === true)
            return "Cookies cleared";
    }
    if (commandInfo.command === "storage") {
        const entries = getArrayField(data, "entries") ?? getArrayField(data, "items");
        if (entries)
            return `Storage entries: ${entries.length}`;
        const key = getStringField(data, "key");
        if (key && (commandInfo.subcommand === "set" || data.set === true || Object.hasOwn(data, "value")))
            return `Storage set: ${key}`;
        if (data.cleared === true || data.clear === true)
            return "Storage cleared";
    }
    if (commandInfo.command === "dialog") {
        const open = typeof data.open === "boolean" ? data.open : undefined;
        if (open !== undefined)
            return open ? "Dialog open" : "No dialog open";
        if (data.accepted === true)
            return "Dialog accepted";
        if (data.dismissed === true)
            return "Dialog dismissed";
    }
    if (commandInfo.command === "frame") {
        const frame = getStringField(data, "frame") ?? getStringField(data, "name") ?? getStringField(data, "selector") ?? commandInfo.subcommand;
        if (frame)
            return `Frame: ${frame}`;
    }
    if (commandInfo.command === "state") {
        const states = getArrayField(data, "states") ?? getArrayField(data, "files");
        if (states)
            return `States: ${states.length}`;
        if (commandInfo.subcommand === "load")
            return undefined;
        const stateName = getStringField(data, "name") ?? getStringField(data, "file") ?? getStringField(data, "filename") ?? getStringField(data, "path") ?? commandInfo.subcommand;
        if (stateName)
            return `State ${commandInfo.subcommand ?? "result"}: ${stateName}`;
    }
    if (commandInfo.command === "network") {
        if (commandInfo.subcommand === "requests") {
            const requests = getArrayField(data, "requests");
            if (requests)
                return isClearDiagnosticCommand(commandInfo) ? `Network requests reset: ${requests.length} cleared` : `Network requests: ${requests.length}`;
        }
        if (commandInfo.subcommand === "route") {
            const routed = getStringField(data, "routed") ?? getStringField(data, "url") ?? getStringField(data, "pattern");
            return routed ? `Network route: ${redactSensitiveText(routed)}` : "Network route configured";
        }
        if (commandInfo.subcommand === "unroute") {
            const unrouted = getStringField(data, "unrouted") ?? getStringField(data, "url") ?? getStringField(data, "pattern");
            return unrouted ? `Network unroute: ${redactSensitiveText(unrouted)}` : "Network route removed";
        }
        if (commandInfo.subcommand === "har") {
            const state = getStringField(data, "state") ?? getStringField(data, "status") ?? commandInfo.subcommand;
            return `Network HAR: ${state}`;
        }
    }
    if (commandInfo.command === "diff") {
        if (commandInfo.subcommand === "snapshot")
            return "Snapshot diff completed";
        if (commandInfo.subcommand === "url")
            return "URL diff completed";
    }
    if (["trace", "profiler"].includes(commandInfo.command ?? "")) {
        const state = getStringField(data, "state") ?? getStringField(data, "status") ?? commandInfo.subcommand;
        if (state)
            return `${commandInfo.command === "trace" ? "Trace" : "Profiler"}: ${state}`;
    }
    if (commandInfo.command === "highlight")
        return "Element highlighted";
    if (commandInfo.command === "inspect")
        return "DevTools inspect opened";
    if (commandInfo.command === "clipboard")
        return `Clipboard ${commandInfo.subcommand ?? "completed"}`;
    if (commandInfo.command === "stream") {
        if (commandInfo.subcommand === "enable") {
            if (data.alreadyEnabled === true)
                return "Stream already enabled";
            const port = typeof data.port === "number" ? ` on port ${data.port}` : "";
            return `Stream enabled${port}`;
        }
        if (commandInfo.subcommand === "disable")
            return "Stream disabled";
    }
    if (commandInfo.command === "chat")
        return "Chat response";
    if (commandInfo.command === "console") {
        const messages = getArrayField(data, "messages");
        if (messages)
            return isClearDiagnosticCommand(commandInfo) ? `Console reset: ${messages.length} cleared` : `Console messages: ${messages.length}`;
    }
    if (commandInfo.command === "errors") {
        const errors = getArrayField(data, "errors");
        if (errors)
            // local patch: upstream 0.37.0 `errors --clear` reports cleared rows but does not purge the
            // session buffer (verified: the same rows return on the next read), so claiming a reset makes
            // agents treat stale errors as current-page evidence.
            return isClearDiagnosticCommand(commandInfo)
                ? `Page errors clear requested: upstream reported ${errors.length} row${errors.length === 1 ? "" : "s"} (agent-browser 0.37.0 may not purge them; re-read before assuming an empty buffer)`
                : `Page errors: ${errors.length}`;
    }
    if (commandInfo.command === "dashboard") {
        if (typeof data.port === "number")
            return `Dashboard running on port ${data.port}`;
        if (data.stopped === true)
            return "Dashboard stopped";
        if (data.stopped === false) {
            const reason = getStringField(data, "reason");
            return reason ? `Dashboard not stopped: ${reason}` : "Dashboard not stopped";
        }
    }
    if (commandInfo.command === "doctor") {
        const status = getStringField(data, "status") ?? getStringField(data, "result");
        if (status)
            return `Doctor: ${status}`;
        const checks = getArrayField(data, "checks") ?? getArrayField(data, "issues") ?? getArrayField(data, "problems");
        if (checks)
            return `Doctor: ${formatCount(checks.length, "item")}`;
    }
    return undefined;
}
function formatSessionText(data) {
    const sessions = getArrayField(data, "sessions");
    if (sessions) {
        if (sessions.length === 0)
            return "No active sessions.";
        return sessions
            .map((item, index) => {
            if (!isRecord(item))
                return `${index + 1}. ${stringifyModelFacing(item)}`;
            const name = redactModelFacingText(getStringField(item, "name") ?? getStringField(item, "session") ?? getStringField(item, "id") ?? `(session ${index + 1})`);
            const active = item.active === true;
            const url = getStringField(item, "url");
            const title = getStringField(item, "title");
            const label = getStringField(item, "label");
            const tabCount = typeof item.tabCount === "number" ? `${item.tabCount} tab${item.tabCount === 1 ? "" : "s"}` : undefined;
            const metadata = [
                `active=${active ? "true" : "false"}`,
                label ? `label=${redactModelFacingText(label)}` : undefined,
                title ? `title=${redactSensitiveText(title)}` : undefined,
                url ? `url=${redactSensitiveText(url)}` : undefined,
                tabCount,
            ].filter(Boolean).join("; ");
            return `${index + 1}. name=${name}${active ? " *active*" : ""}; ${metadata}`;
        })
            .join("\n");
    }
    if (typeof data.active === "boolean") {
        const runtime = data.runtime;
        const browser = isRecord(runtime) && isRecord(runtime.browser) ? runtime.browser : undefined;
        const identity = [
            `Daemon: ${data.active ? "active" : "inactive"}; PID: ${data.pid ?? "unknown"}`,
            `Browser: ${browser?.status ?? "unknown"}; alive: ${browser?.alive ?? "unknown"}; Chrome PID: ${browser?.pid ?? "unknown"}`,
            `Exact profile: ${browser?.userDataDir ?? "unknown"}`,
            `Native browser ownership: ${browser?.ownership ?? "unknown"}; Pi cleanup ownership: ${data.piCleanupOwnership ?? "unknown"}`,
        ].join("\n");
        return `${redactModelFacingText(identity)}\n\n${stringifyModelFacing({
            ...Object.fromEntries(["session", "namespace", "socketDir", "active", "pid", "version", "runtimeError"].map((key) => [key, data[key]])),
            // Native runtime also includes restore check URLs, text and code; show status/identity only.
            runtime: isRecord(runtime) ? Object.fromEntries([
                "session", "namespace", "socketDir", "backgroundPid", "browserLaunched", "browser", "recording", "capabilities", "pageCount", "engine", "launchHash",
                "compatibilityStatus", "restoreKey", "restoreStatus", "restoreLoadedPath", "restoreValidationPending",
                "restoreSave", "saveStatus", "restoreSavedPath",
            ].map((key) => [key, runtime[key]])) : runtime,
        })}`;
    }
    const session = getStringField(data, "session");
    return session ? `Current session: ${redactModelFacingText(session)}` : undefined;
}
export function formatProfilesText(profiles, label) {
    if (profiles.length === 0)
        return `No ${label}.`;
    return profiles
        .map((item, index) => {
        if (!isRecord(item))
            return `${index + 1}. ${stringifyModelFacing(item)}`;
        const name = redactModelFacingText(getStringField(item, "name") ?? getStringField(item, "profile") ?? `(unnamed ${index + 1})`);
        const directory = getStringField(item, "directory") ?? getStringField(item, "path");
        return directory ? `${index + 1}. ${name} (${redactModelFacingText(directory)})` : `${index + 1}. ${name}`;
    })
        .join("\n");
}
function formatAuthShowText(data) {
    const lines = AUTH_SHOW_SAFE_FIELDS.flatMap((key) => {
        const value = data[key];
        return typeof value === "string" && value.trim().length > 0 ? [`${key}: ${redactModelFacingText(value.trim())}`] : [];
    });
    return lines.length > 0 ? lines.join("\n") : undefined;
}
function getPreviewCandidate(item, keys) {
    for (const key of keys) {
        const value = item[key];
        if (value !== undefined && value !== null && value !== "")
            return value;
    }
    return undefined;
}
function formatNetworkPreviewValue(value, maxChars) {
    if (value === undefined || value === null)
        return undefined;
    const redacted = redactSensitiveValue(value);
    const raw = typeof redacted === "string" ? redacted : stringifyUnknown(redacted);
    const normalized = raw.replace(/\s+/g, " ").trim();
    if (normalized.length === 0)
        return undefined;
    return truncateText(redactSensitiveText(normalized), maxChars);
}
function appendNetworkPreview(lines, label, value, maxChars) {
    const preview = formatNetworkPreviewValue(value, maxChars);
    if (!preview)
        return;
    lines.push(`   ${label}: ${preview}`);
}
function formatNetworkRequestLine(item, index) {
    const method = getStringField(item, "method") ?? "GET";
    const status = typeof item.status === "number" ? String(item.status) : "pending";
    const type = getStringField(item, "resourceType") ?? getStringField(item, "mimeType");
    const url = getStringField(item, "url") ?? "(no url)";
    const requestId = getStringField(item, "requestId") ?? getStringField(item, "id");
    const idText = requestId ? ` [${redactSensitiveText(requestId)}]` : "";
    const failureClassification = classifyNetworkRequestFailure(item);
    const impactText = failureClassification ? ` [${failureClassification.impact}: ${failureClassification.reason}]` : "";
    const lines = [`${index + 1}. ${status} ${method} ${truncateText(redactSensitiveText(url), 180)}${type ? ` (${type})` : ""}${idText}${impactText}`];
    appendNetworkPreview(lines, "Payload", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.request), NETWORK_BODY_PREVIEW_MAX_CHARS);
    appendNetworkPreview(lines, "Response", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.response), NETWORK_BODY_PREVIEW_MAX_CHARS);
    appendNetworkPreview(lines, "Error", getPreviewCandidate(item, NETWORK_PREVIEW_FIELD_CANDIDATES.error), NETWORK_ERROR_PREVIEW_MAX_CHARS);
    return lines;
}
function formatNetworkRequestsText(data, commandInfo) {
    const requests = getArrayField(data, "requests");
    if (isClearDiagnosticCommand(commandInfo) && data.cleared === true && !requests)
        return "Network request buffer cleared.";
    if (!requests)
        return undefined;
    if (isClearDiagnosticCommand(commandInfo)) {
        return requests.length === 0
            ? "Network request buffer cleared; no prior request rows were returned. This reset output is not evidence of current-page network activity."
            : `Network request buffer cleared; upstream returned ${requests.length} cleared/stale row${requests.length === 1 ? "" : "s"}. Treat these as reset output, not current-page request failures.`;
    }
    if (requests.length === 0)
        return "No network requests captured. Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page.";
    const shown = ["Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page; do not attribute old requests to the current page without URL/time evidence."];
    const indexedRequests = requests.map((item, index) => ({ index, item }));
    const artifactNoiseRequests = indexedRequests.filter((indexed) => isRecord(indexed.item) && isNetworkArtifactNoiseRequest(indexed.item));
    const previewRequests = indexedRequests.filter((indexed) => !(isRecord(indexed.item) && isNetworkArtifactNoiseRequest(indexed.item)));
    const networkFailureSummary = summarizeNetworkFailures(previewRequests.map((indexed) => indexed.item));
    if (networkFailureSummary.totalCount > 0) {
        shown.push(`Network failure summary: ${networkFailureSummary.actionableCount} actionable, ${networkFailureSummary.benignCount} benign low-impact (${networkFailureSummary.totalCount} total).`);
    }
    const failedRequests = [];
    const normalRequests = [];
    for (const indexed of previewRequests) {
        if (isRecord(indexed.item) && classifyNetworkRequestFailure(indexed.item))
            failedRequests.push(indexed);
        else
            normalRequests.push(indexed);
    }
    if (artifactNoiseRequests.length > 0) {
        shown.push(`Diagnostic noise hidden from preview: ${artifactNoiseRequests.length} data:image/artifact request row${artifactNoiseRequests.length === 1 ? "" : "s"}; raw rows remain in details.data.requests.`);
    }
    failedRequests.sort((left, right) => {
        const leftClassification = isRecord(left.item) ? classifyNetworkRequestFailure(left.item) : undefined;
        const rightClassification = isRecord(right.item) ? classifyNetworkRequestFailure(right.item) : undefined;
        const leftRank = leftClassification?.impact === "actionable" ? 0 : 1;
        const rightRank = rightClassification?.impact === "actionable" ? 0 : 1;
        return leftRank - rightRank || left.index - right.index;
    });
    const prioritizedRequests = [...failedRequests, ...normalRequests];
    shown.push(...prioritizedRequests.slice(0, DIAGNOSTIC_REQUEST_PREVIEW_LIMIT).flatMap(({ item, index }) => {
        if (!isRecord(item))
            return [`${index + 1}. ${stringifyModelFacing(item)}`];
        // local patch: header values are NOT printed per row. Prose runs through the string redactor, which
        // rewrites `Bearer <token>` to a placeholder, so a per-row reveal line can only ever show the
        // placeholder. The values are printed once, after all redaction, at the end of the result (P13).
        return formatNetworkRequestLine(item, index);
    }));
    const omittedPreviewCount = Math.max(0, prioritizedRequests.length - DIAGNOSTIC_REQUEST_PREVIEW_LIMIT);
    if (omittedPreviewCount > 0) {
        shown.push(`... (${omittedPreviewCount} additional non-noise requests omitted from preview; failed requests are shown first when present)`);
    }
    // local patch: honest reveal reporting (P13). Upstream's LIST payload carries no headers at all (only the
    // single-request detail read does), so say that instead of printing a warning that implies a value appeared.
    if (Array.isArray(commandInfo?.revealSecrets?.headers) && commandInfo.revealSecrets.headers.length > 0) {
        // A neutral pointer, because this formatter cannot know which copy of the payload it received and must
        // never contradict the trailing value block: say what was asked for, and where the values end up.
        shown.push(`Reveal requested for: ${commandInfo.revealSecrets.headers.join(", ")}. Values, when this payload carries them, are printed at the end of this result; this list payload often omits request headers, in which case read a single row with \`network request <requestId>\` plus revealSecrets.`);
    }
    return shown.join("\n");
}
function formatNetworkRequestText(data, commandInfo) {
    // The revealed value is appended at the END of the result instead of here, because this prose still goes
    // through the string redactor, which rewrites `Bearer <token>` to `Bearer [REDACTED]`. Here we only point
    // at that trailing block when the caller asked for a reveal.
    const revealPointer = Array.isArray(commandInfo?.revealSecrets?.headers) && commandInfo.revealSecrets.headers.length > 0
        ? `  Requested header(s) for this row are printed at the end of this result: ${commandInfo.revealSecrets.headers.join(", ")}.`
        : undefined;
    if (!getStringField(data, "url") && !getStringField(data, "requestId") && !getStringField(data, "id")) {
        return undefined;
    }
    return [formatNetworkRequestLine(data, 0).join("\n"), revealPointer].filter(Boolean).join("\n");
}
function getSafeNetworkActionValue(value) {
    if (!value)
        return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || redactSensitiveText(trimmed) !== trimmed)
        return undefined;
    return trimmed;
}
function getNetworkRequestId(item) {
    return getSafeNetworkActionValue(getStringField(item, "requestId") ?? getStringField(item, "id"));
}
function isSensitiveNetworkPathSegment(segment) {
    const normalized = segment.toLowerCase();
    return normalized === "auth" || NETWORK_FILTER_SENSITIVE_SEGMENT_TERMS.some((term) => normalized.includes(term));
}
function pathFilterMayExposeSensitiveSegment(filter) {
    const decoded = (() => {
        try {
            return decodeURIComponent(filter);
        }
        catch {
            return filter;
        }
    })();
    return decoded.split("/").some((segment) => isSensitiveNetworkPathSegment(segment) || NETWORK_FILTER_OPAQUE_SEGMENT_PATTERN.test(segment));
}
function getNetworkRequestPathFilter(item) {
    const url = getStringField(item, "url");
    if (!url)
        return undefined;
    let filter;
    try {
        filter = new URL(url).pathname;
    }
    catch {
        filter = url.split(/[?#]/, 1)[0];
    }
    filter = filter?.trim();
    if (!filter || filter === "/" || filter.length > NETWORK_FILTER_MAX_CHARS || pathFilterMayExposeSensitiveSegment(filter))
        return undefined;
    return getSafeNetworkActionValue(filter);
}
function getNetworkRequestActionCandidate(item) {
    if (isNetworkArtifactNoiseRequest(item))
        return undefined;
    const requestId = getNetworkRequestId(item);
    if (!requestId)
        return undefined;
    const classification = classifyNetworkRequestFailure(item);
    const kind = classification?.impact === "actionable"
        ? "actionable"
        : classification?.impact === "benign"
            ? "benign"
            : isApiLikeNetworkRequest(item)
                ? "api"
                : "request";
    return { filter: getNetworkRequestPathFilter(item), item, kind, requestId };
}
function chooseNetworkRequestActionCandidate(candidates) {
    return candidates.find((candidate) => candidate.kind === "actionable")
        ?? candidates.find((candidate) => candidate.kind === "api")
        ?? candidates.find((candidate) => candidate.kind === "benign")
        ?? candidates[0];
}
function formatNetworkRequestActionDescriptor(candidate) {
    const method = getStringField(candidate.item, "method") ?? "GET";
    const status = typeof candidate.item.status === "number" ? String(candidate.item.status) : "pending";
    const target = candidate.filter ? ` ${candidate.filter}` : "";
    return `${status} ${method}${target} [${candidate.requestId}]`;
}
function getNetworkRequestDetailActionId(candidate) {
    if (candidate.kind === "actionable")
        return "inspect-actionable-network-request";
    if (candidate.kind === "benign")
        return "inspect-benign-network-request";
    return "inspect-network-request";
}
export function formatNetworkRouteDiagnosticsText(diagnostics) {
    if (!diagnostics || diagnostics.length === 0)
        return undefined;
    const lines = ["Network route diagnostics:"];
    for (const diagnostic of diagnostics) {
        const target = diagnostic.requestId ? `[${diagnostic.requestId}] ${diagnostic.requestUrl ?? "request"}` : diagnostic.requestUrl ?? "request";
        lines.push(`- ${diagnostic.reason}: ${target} matched route ${diagnostic.routePattern} (${diagnostic.mode}).`);
    }
    lines.push("If this route is intended as a mock, inspect the request/headers and treat failed, pending, or CORS-looking rows as unfulfilled until a mocked response is observed.");
    return lines.join("\n");
}
export function buildNetworkRouteDiagnosticsNextActions(diagnostics, sessionName) {
    const diagnostic = diagnostics?.find((item) => item.requestId) ?? diagnostics?.[0];
    if (!diagnostic)
        return undefined;
    const actions = [];
    if (diagnostic.requestId) {
        actions.push({
            id: "inspect-routed-network-request",
            params: { args: withOptionalSessionArgs(sessionName, ["network", "request", diagnostic.requestId]) },
            reason: `Inspect the routed request ${diagnostic.requestId} before assuming the route mock fulfilled normally.`,
            safety: "Read-only request diagnostic; look for failed status, pending state, CORS/preflight errors, response body, and headers.",
            tool: "agent_browser",
        });
    }
    actions.push({
        id: "start-network-har-capture-for-route-mock",
        params: { args: withOptionalSessionArgs(sessionName, ["network", "har", "start"]) },
        reason: "Capture a HAR before reproducing the route mock so pending/CORS behavior has request and response headers.",
        safety: "HARs can contain URLs and headers; stop to an explicit path and avoid sharing sensitive captures.",
        tool: "agent_browser",
    });
    return actions;
}
export function buildNetworkRequestsNextActions(data, sessionName, routeDiagnostics) {
    if (!isRecord(data))
        return undefined;
    const requests = getArrayField(data, "requests");
    if (!requests)
        return undefined;
    const candidates = requests.flatMap((item) => {
        if (!isRecord(item))
            return [];
        const candidate = getNetworkRequestActionCandidate(item);
        return candidate ? [candidate] : [];
    });
    const selected = chooseNetworkRequestActionCandidate(candidates);
    if (!selected)
        return undefined;
    const descriptor = formatNetworkRequestActionDescriptor(selected);
    const actions = [
        {
            id: getNetworkRequestDetailActionId(selected),
            params: { args: withOptionalSessionArgs(sessionName, ["network", "request", selected.requestId]) },
            reason: `Inspect full request details for ${descriptor}.`,
            safety: "Read-only network diagnostic; request inspection must not replace the active page/ref context.",
            tool: "agent_browser",
        },
    ];
    if (selected.kind === "actionable") {
        actions.push({
            id: "trace-actionable-network-source",
            params: { networkSourceLookup: { requestId: selected.requestId, ...(sessionName ? { session: sessionName } : {}) } },
            reason: `Look for local source candidates related to ${descriptor}.`,
            safety: "Read-only experimental helper; it reports bounded candidates and may miss bundled or dynamic call sites.",
            tool: "agent_browser",
        });
    }
    if (selected.filter) {
        actions.push({
            id: "filter-network-requests-by-path",
            params: { args: withOptionalSessionArgs(sessionName, ["network", "requests", "--filter", selected.filter]) },
            reason: `List captured requests matching ${selected.filter}.`,
            safety: "Read-only request-list filter; absence from a compact preview is not proof the request did not happen.",
            tool: "agent_browser",
        });
    }
    actions.push({
        id: "clear-network-requests-before-repro",
        params: { args: withOptionalSessionArgs(sessionName, ["network", "requests", "--clear"]) },
        reason: "Clear the aggregate request buffer before reproducing the current-page network behavior.",
        safety: "This mutates only diagnostic buffers for the session; capture or inspect needed old rows first.",
        tool: "agent_browser",
    });
    actions.push({
        id: "start-network-har-capture",
        params: { args: withOptionalSessionArgs(sessionName, ["network", "har", "start"]) },
        reason: "Start HAR capture before reproducing the network behavior again.",
        safety: "HARs can contain URLs and headers; stop to an explicit path, inspect metadata, and avoid sharing sensitive captures.",
        tool: "agent_browser",
    });
    return [...(buildNetworkRouteDiagnosticsNextActions(routeDiagnostics, sessionName) ?? []), ...actions].slice(0, NETWORK_NEXT_ACTION_LIMIT);
}
export function buildStreamNextActions(commandInfo, data, sessionName) {
    if (commandInfo.command !== "stream" || commandInfo.subcommand !== "enable" || !isRecord(data) || data.alreadyEnabled !== true)
        return undefined;
    return [
        {
            id: "check-stream-status-after-noop",
            params: { args: withOptionalSessionArgs(sessionName, ["stream", "status"]) },
            reason: "Read current stream port and connection details after the idempotent enable no-op.",
            safety: "Read-only stream diagnostic.",
            tool: "agent_browser",
        },
        {
            id: "disable-existing-stream-when-done",
            params: { args: withOptionalSessionArgs(sessionName, ["stream", "disable"]) },
            reason: "Disable the existing stream when it is no longer needed.",
            safety: "Only run when no other workflow is relying on the current stream.",
            tool: "agent_browser",
        },
    ];
}
function formatConsoleText(data, commandInfo) {
    const messages = getArrayField(data, "messages");
    if (isClearDiagnosticCommand(commandInfo) && data.cleared === true && !messages)
        return "Console buffer cleared.";
    if (!messages)
        return undefined;
    if (isClearDiagnosticCommand(commandInfo)) {
        return messages.length === 0
            ? "Console buffer cleared; no prior message rows were returned. This reset output is not evidence of current-page console activity."
            : `Console buffer cleared; upstream returned ${messages.length} cleared/stale message row${messages.length === 1 ? "" : "s"}. Treat these as reset output, not current-page console errors.`;
    }
    if (messages.length === 0)
        return "No console messages. Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page.";
    const shown = ["Scope: upstream session aggregate unless the upstream command output says it was cleared or filtered for this page; do not attribute old messages to the current page without URL/time evidence."];
    shown.push(...messages.slice(0, DIAGNOSTIC_LOG_PREVIEW_LIMIT).map((item, index) => {
        if (!isRecord(item))
            return `${index + 1}. ${stringifyModelFacing(item)}`;
        const type = redactModelFacingText(getStringField(item, "type") ?? "message");
        const text = getStringField(item, "text") ?? stringifyModelFacing(item);
        return `${index + 1}. [${type}] ${firstLine(redactModelFacingText(text).replace(/\s+/g, " ").trim(), 220)}`;
    }));
    const previewedMessageCount = Math.min(messages.length, DIAGNOSTIC_LOG_PREVIEW_LIMIT);
    if (messages.length > previewedMessageCount) {
        shown.push(`... (${messages.length - previewedMessageCount} additional console messages omitted from preview)`);
    }
    return shown.join("\n");
}
function formatA11yText(data) {
    const counts = isRecord(data.counts) ? data.counts : undefined;
    const violations = getArrayField(data, "violations") ?? [];
    const incomplete = getArrayField(data, "incomplete") ?? [];
    if (!counts && violations.length === 0 && incomplete.length === 0)
        return undefined;
    const lines = [];
    const axeVersion = getStringField(data, "axeVersion");
    if (axeVersion)
        lines.push(`axe-core ${redactModelFacingText(axeVersion)}`);
    const url = getStringField(data, "url");
    if (url)
        lines.push(`URL: ${redactModelFacingText(url)}`);
    const violationCount = typeof counts?.violations === "number" ? counts.violations : violations.length;
    const incompleteCount = typeof counts?.incomplete === "number" ? counts.incomplete : incomplete.length;
    const passCount = typeof counts?.passes === "number" ? counts.passes : undefined;
    const inapplicableCount = typeof counts?.inapplicable === "number" ? counts.inapplicable : undefined;
    const countParts = [`${violationCount} violation${violationCount === 1 ? "" : "s"}`, `${incompleteCount} incomplete`];
    if (passCount !== undefined)
        countParts.push(`${passCount} passes`);
    if (inapplicableCount !== undefined)
        countParts.push(`${inapplicableCount} inapplicable`);
    lines.push(`A11y audit: ${countParts.join(", ")}.`);
    const previewLimit = Math.min(10, DIAGNOSTIC_LOG_PREVIEW_LIMIT);
    const preview = violations.slice(0, previewLimit).map((item, index) => {
        if (!isRecord(item))
            return `${index + 1}. ${stringifyModelFacing(item)}`;
        const id = redactModelFacingText(getStringField(item, "id") ?? "rule");
        const impact = redactModelFacingText(getStringField(item, "impact") ?? "unknown");
        const help = firstLine(redactModelFacingText(getStringField(item, "help") ?? "").replace(/\s+/g, " ").trim(), 160);
        const nodeCount = typeof item.nodeCount === "number" ? item.nodeCount : getArrayField(item, "nodes")?.length;
        const nodePart = typeof nodeCount === "number" ? `, ${nodeCount} node${nodeCount === 1 ? "" : "s"}` : "";
        return `${index + 1}. [${impact}] ${id}${nodePart}${help ? ` — ${help}` : ""}`;
    });
    lines.push(...preview);
    if (violations.length > preview.length) {
        lines.push(`... (${violations.length - preview.length} additional violations omitted from preview)`);
    }
    if (incompleteCount > 0) {
        lines.push(`${incompleteCount} incomplete check${incompleteCount === 1 ? "" : "s"} need manual review (see details.data.incomplete).`);
    }
    return lines.join("\n");
}
function formatErrorsText(data, commandInfo) {
    const errors = getArrayField(data, "errors");
    if (!errors)
        return undefined;
    if (isClearDiagnosticCommand(commandInfo)) {
        // local patch: upstream 0.37.0 `errors --clear` does not purge the session buffer (verified: the
        // same rows return on the next read), so do not present the buffer as cleared. Keep the returned
        // rows labelled as clear output while making the persistence caveat explicit.
        const rowWord = errors.length === 1 ? "row" : "rows";
        return errors.length === 0
            ? "Page error clear requested; upstream returned no rows. Agent-browser 0.37.0 may not purge its error buffer, so re-read `errors` before assuming it is empty; this reset output is not evidence of current-page errors."
            : `Page error clear requested; upstream returned ${errors.length} cleared/stale error ${rowWord}. Agent-browser 0.37.0 may not purge its error buffer (these rows can reappear), so treat them as reset output rather than current-page evidence.`;
    }
    if (errors.length === 0)
        return "No page errors.";
    const shown = errors.slice(0, DIAGNOSTIC_LOG_PREVIEW_LIMIT).map((item, index) => {
        if (!isRecord(item))
            return `${index + 1}. ${stringifyModelFacing(item)}`;
        const text = getStringField(item, "text") ?? stringifyModelFacing(item);
        const location = [
            getStringField(item, "url"),
            typeof item.line === "number" ? `line ${item.line}` : undefined,
            typeof item.column === "number" ? `column ${item.column}` : undefined,
        ]
            .filter(Boolean)
            .map((item) => redactModelFacingText(String(item)))
            .join(":");
        const safeText = firstLine(redactModelFacingText(text), 220);
        return location ? `${index + 1}. ${safeText} (${location})` : `${index + 1}. ${safeText}`;
    });
    if (errors.length > shown.length) {
        shown.push(`... (${errors.length - shown.length} additional errors omitted from preview)`);
    }
    return shown.join("\n");
}
function formatDashboardText(data) {
    const lines = [];
    if (typeof data.port === "number")
        lines.push(`Port: ${data.port}`);
    if (typeof data.pid === "number")
        lines.push(`PID: ${data.pid}`);
    if (typeof data.stopped === "boolean")
        lines.push(`Stopped: ${data.stopped}`);
    const reason = getStringField(data, "reason");
    if (reason)
        lines.push(`Reason: ${redactModelFacingText(reason)}`);
    return lines.length > 0 ? lines.join("\n") : undefined;
}
function formatChatText(data) {
    const response = getStringField(data, "response") ?? getStringField(data, "message") ?? getStringField(data, "text") ?? getStringField(data, "result");
    if (response)
        return redactModelFacingText(response);
    const model = getStringField(data, "model");
    const provider = getStringField(data, "provider");
    const lines = [model ? `Model: ${redactModelFacingText(model)}` : undefined, provider ? `Provider: ${redactModelFacingText(provider)}` : undefined].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : undefined;
}
function formatDoctorText(data) {
    const lines = [];
    const status = getStringField(data, "status") ?? getStringField(data, "result");
    if (status)
        lines.push(`Status: ${redactModelFacingText(status)}`);
    const summary = isRecord(data.summary) ? data.summary : undefined;
    if (summary) {
        const parts = ["pass", "warn", "fail"].flatMap((key) => typeof summary[key] === "number" ? [`${key}:${summary[key]}`] : []);
        if (parts.length > 0)
            lines.push(`Summary: ${parts.join(", ")}`);
    }
    const checks = getArrayField(data, "checks");
    if (checks) {
        lines.push(`Checks: ${checks.length}`);
        for (const [index, item] of checks.slice(0, 30).entries()) {
            if (!isRecord(item)) {
                lines.push(`${index + 1}. ${stringifyModelFacing(item)}`);
                continue;
            }
            const checkStatus = getStringField(item, "status") ?? "info";
            const id = getStringField(item, "id");
            const category = getStringField(item, "category");
            const message = getStringField(item, "message") ?? getStringField(item, "name") ?? getStringField(item, "title") ?? getStringField(item, "check") ?? stringifyModelFacing(item);
            const label = [category, id].filter(Boolean).join("/");
            lines.push(`${index + 1}. [${redactModelFacingText(checkStatus)}]${label ? ` ${redactModelFacingText(label)}:` : ""} ${firstLine(redactModelFacingText(message), 220)}`);
            const fix = getStringField(item, "fix");
            if (fix)
                lines.push(`   fix: ${redactModelFacingText(fix)}`);
        }
        if (checks.length > 30)
            lines.push(`... (${checks.length - 30} additional checks omitted from preview)`);
    }
    for (const key of ["issues", "problems"]) {
        const items = getArrayField(data, key);
        if (items)
            lines.push(`${key}: ${items.length}`);
    }
    if (lines.length === 0) {
        const keys = Object.keys(data).filter((key) => key !== "success");
        if (keys.length > 0)
            return `Doctor diagnostics returned unrecognized fields: ${keys.map(redactModelFacingText).join(", ")}. See details.data for structured diagnostics.`;
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
}
function formatCookieRecordText(item, fallbackName) {
    const name = redactModelFacingText(getStringField(item, "name") ?? fallbackName);
    const domain = getStringField(item, "domain");
    const path = getStringField(item, "path");
    const flags = [item.httpOnly === true ? "httpOnly" : undefined, item.secure === true ? "secure" : undefined].filter(Boolean).join(", ");
    const location = [domain, path].filter(Boolean).join("");
    return [name, location ? `(${redactModelFacingText(location)})` : undefined, flags ? `[${flags}]` : undefined].filter(Boolean).join(" ");
}
// local patch: upstream 0.37.0 `cookies get` always scopes to the active page origin and silently ignores
// `--url` (verified: a cookie set for example.com is invisible while about:blank is the active page, and
// `cookies get --url <origin>` returns the same empty list without an error). Say so, so an empty list is not
// read as proof that the browser holds no cookies.
function getCookiesScopeNote(data, commandInfo) {
    if (data.set === true || data.cleared === true || data.clear === true)
        return "";
    const tokens = Array.isArray(commandInfo?.commandTokens) ? commandInfo.commandTokens : [];
    return tokens.includes("--url")
        ? " Note: `cookies get` ignores `--url` in agent-browser 0.37.0 and lists cookies for the active page origin only, so this result is not scoped to the URL you passed. Navigate to that origin (or use `state save`/`cookies set --url` for writes) and read again."
        : " Note: cookies are listed for the active page origin only, so an empty list on about:blank or a page that never received cookies does not prove the browser holds no cookies for other origins.";
}
function formatCookiesText(data, commandInfo) {
    const cookies = getArrayField(data, "cookies");
    if (cookies) {
        if (cookies.length === 0)
            return `No cookies.${getCookiesScopeNote(data, commandInfo)}`;
        return cookies
            .map((item, index) => (isRecord(item) ? formatCookieRecordText(item, `(cookie ${index + 1})`) : `${index + 1}. [REDACTED]`))
            .join("\n");
    }
    if (getStringField(data, "name") || getStringField(data, "domain") || getStringField(data, "path") || Object.hasOwn(data, "value")) {
        return formatCookieRecordText(data, "cookie");
    }
    if (data.set === true)
        return "Cookie set.";
    if (data.cleared === true || data.clear === true)
        return "Cookies cleared.";
    return undefined;
}
function valueContainsStorageSecret(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0)
            return false;
        if (STORAGE_TOKEN_VALUE_PATTERN.test(trimmed) || STORAGE_SECRET_VALUE_WORD_PATTERN.test(trimmed) || STORAGE_EMAIL_VALUE_PATTERN.test(trimmed) || STORAGE_IDENTITY_VALUE_PATTERN.test(trimmed))
            return true;
        try {
            const url = new URL(trimmed);
            if (url.protocol === "http:" || url.protocol === "https:" || url.username || url.password || url.search)
                return true;
        }
        catch { }
        if (redactSensitiveText(trimmed) !== trimmed)
            return true;
        try {
            return valueContainsStorageSecret(JSON.parse(trimmed));
        }
        catch {
            return false;
        }
    }
    if (Array.isArray(value))
        return value.some((item) => valueContainsStorageSecret(item));
    if (!isRecord(value))
        return false;
    return Object.entries(value).some(([key, entryValue]) => STORAGE_SECRET_KEY_PATTERN.test(key) || valueContainsStorageSecret(entryValue));
}
function shouldRevealStorageValue(key, value) {
    // local patch: a nullish value carries no secret (usually a missing key), so it must not be
    // disguised as "[REDACTED]". Upstream returns null for absent keys; redacting that misleads
    // callers into believing a sensitive value exists.
    if (value === null || value === undefined)
        return true;
    if (!key || STORAGE_SECRET_KEY_PATTERN.test(key) || !STORAGE_BENIGN_KEY_PATTERN.test(key))
        return false;
    if (valueContainsStorageSecret(value))
        return false;
    if (typeof value === "string")
        return value.length <= STORAGE_VALUE_PREVIEW_MAX_CHARS;
    return value === null || typeof value === "number" || typeof value === "boolean";
}
function formatStorageValue(key, value) {
    if (!shouldRevealStorageValue(key, value))
        return "[REDACTED]";
    if (typeof value === "string")
        return redactModelFacingText(value);
    return stringifyModelFacing(value);
}
function redactStorageEntryValue(item) {
    if (!Object.hasOwn(item, "value"))
        return redactSensitiveValue(item);
    const key = getStringField(item, "key") ?? getStringField(item, "name");
    const value = item.value;
    if (shouldRevealStorageValue(key, value))
        return redactSensitiveValue(item);
    return {
        ...redactSensitiveValue({ ...item, value: undefined }),
        value: "[REDACTED]",
        valueRedacted: true,
        valueRedactionReason: key && STORAGE_SECRET_KEY_PATTERN.test(key) ? "sensitive-key" : "sensitive-value",
    };
}
function redactStorageData(value) {
    if (Array.isArray(value))
        return value.map((item) => redactStorageData(item));
    if (!isRecord(value))
        return redactSensitiveValue(value);
    const entries = Object.fromEntries(Object.entries(value).map(([key, entryValue]) => {
        if ((key === "entries" || key === "items") && Array.isArray(entryValue))
            return [key, entryValue.map((item) => isRecord(item) ? redactStorageEntryValue(item) : redactSensitiveValue(item))];
        if (key === "value") {
            const itemKey = getStringField(value, "key") ?? getStringField(value, "name");
            return [key, shouldRevealStorageValue(itemKey, entryValue) ? redactSensitiveValue(entryValue) : "[REDACTED]"];
        }
        return [key, redactSensitiveValue(entryValue)];
    }));
    if (Object.hasOwn(value, "value")) {
        const key = getStringField(value, "key") ?? getStringField(value, "name");
        if (!shouldRevealStorageValue(key, value.value)) {
            entries.valueRedacted = true;
            entries.valueRedactionReason = key && STORAGE_SECRET_KEY_PATTERN.test(key) ? "sensitive-key" : "sensitive-value";
        }
    }
    return entries;
}
function formatStorageText(data) {
    const type = getStringField(data, "type") ?? getStringField(data, "storage") ?? "storage";
    const entries = getArrayField(data, "entries") ?? getArrayField(data, "items");
    if (entries) {
        if (entries.length === 0)
            return `${type}: no entries.`;
        return entries
            .map((item, index) => {
            if (!isRecord(item))
                return `${index + 1}. [REDACTED]`;
            const rawKey = getStringField(item, "key") ?? getStringField(item, "name") ?? `(entry ${index + 1})`;
            const key = redactModelFacingText(rawKey);
            return Object.hasOwn(item, "value") ? `${key}: ${formatStorageValue(rawKey, item.value)}` : key;
        })
            .join("\n");
    }
    const key = getStringField(data, "key");
    if (key && Object.hasOwn(data, "value"))
        return `${type} ${redactModelFacingText(key)}: ${formatStorageValue(key, data.value)}`;
    if (key && data.set === true)
        return `${type} set: ${redactModelFacingText(key)}`;
    if (data.cleared === true || data.clear === true)
        return `${type} cleared.`;
    return undefined;
}
function formatDialogText(data) {
    const lines = [];
    if (typeof data.open === "boolean")
        lines.push(data.open ? "Dialog open." : "No dialog open.");
    const type = getStringField(data, "type");
    if (type)
        lines.push(`Type: ${redactModelFacingText(type)}`);
    const message = getStringField(data, "message");
    if (message)
        lines.push(`Message: ${redactModelFacingText(message)}`);
    if (data.accepted === true)
        lines.push("Accepted.");
    if (data.dismissed === true)
        lines.push("Dismissed.");
    return lines.length > 0 ? lines.join("\n") : undefined;
}
function formatFrameText(data) {
    const frame = getStringField(data, "frame") ?? getStringField(data, "name") ?? getStringField(data, "selector");
    const url = getStringField(data, "url");
    const title = getStringField(data, "title");
    const lines = [frame ? `Frame: ${redactModelFacingText(frame)}` : undefined, title ? `Title: ${redactModelFacingText(title)}` : undefined, url ? `URL: ${redactSensitiveText(url)}` : undefined].filter(Boolean);
    return lines.length > 0 ? lines.join("\n") : undefined;
}
function formatStateText(data, subcommand) {
    if (subcommand === "show") {
        const filename = getStringField(data, "filename") ?? getStringField(data, "name") ?? "saved state";
        const summary = getStringField(data, "summary");
        const lines = [`Saved state: ${redactModelFacingText(filename)}`];
        if (summary)
            lines.push(`Summary: ${redactModelFacingText(summary)}`);
        if (typeof data.encrypted === "boolean")
            lines.push(`Encrypted: ${data.encrypted ? "yes" : "no"}`);
        if (typeof data.size === "number")
            lines.push(`Size: ${data.size} bytes`);
        return lines.join("\n");
    }
    const states = getArrayField(data, "states") ?? getArrayField(data, "files");
    if (states) {
        if (states.length === 0)
            return "No saved states.";
        return states
            .map((item, index) => {
            if (!isRecord(item))
                return `${index + 1}. ${stringifyModelFacing(item)}`;
            const name = getStringField(item, "name") ?? getStringField(item, "file") ?? getStringField(item, "path") ?? `(state ${index + 1})`;
            const url = getStringField(item, "url");
            return url ? `${index + 1}. ${redactModelFacingText(name)} — ${redactSensitiveText(url)}` : `${index + 1}. ${redactModelFacingText(name)}`;
        })
            .join("\n");
    }
    if (data.loaded === true)
        return `State loaded: ${redactModelFacingText(getStringField(data, "path") ?? getStringField(data, "name") ?? "ok")}`;
    if (data.cleared === true || data.clear === true)
        return "State cleared.";
    return undefined;
}
function redactStatefulValues(value, sensitiveKeys) {
    if (Array.isArray(value))
        return value.map((item) => redactStatefulValues(item, sensitiveKeys));
    if (!isRecord(value))
        return redactSensitiveValue(value);
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
        key,
        sensitiveKeys.has(key.toLowerCase()) ? "[REDACTED]" : redactStatefulValues(entryValue, sensitiveKeys),
    ]));
}
export function redactPresentationData(commandInfo, data, reveal) {
    const redacted = (() => {
        if (commandInfo.command === "cookies")
            return redactStatefulValues(data, new Set(["value"]));
        if (commandInfo.command === "storage")
            return redactStorageData(data);
        if (commandInfo.command === "state" && commandInfo.subcommand === "show")
            return redactStatefulValues(data, new Set(["value"]));
        return redactSensitiveValue(data);
    })();
    // local patch: explicit revealSecrets (PATCHES.md P13). Redaction already ran, so the named header
    // values are copied back from the untouched original payload for the rows the caller asked about.
    if (commandInfo.command !== "network" || !Array.isArray(reveal?.headers) || reveal.headers.length === 0) {
        return redacted;
    }
    return restoreRevealedNetworkHeaders(redacted, data, reveal);
}
export function restoreRevealedNetworkHeaders(redacted, original, reveal) {
    if (!isRecord(redacted) || !isRecord(original)) {
        return redacted;
    }
    const names = reveal.headers.map((header) => header.toLowerCase());
    const pick = (row) => {
        const out = {};
        for (const container of [row?.requestHeaders, row?.responseHeaders, row?.headers, row?.request?.headers, row?.response?.headers]) {
            if (!isRecord(container)) {
                continue;
            }
            for (const [key, value] of Object.entries(container)) {
                if (names.includes(key.toLowerCase()) && typeof value === "string" && value.length > 0) {
                    out[key.toLowerCase()] = value;
                }
            }
        }
        return Object.keys(out).length > 0 ? out : undefined;
    };
    const originalRows = Array.isArray(original.requests) ? original.requests : (Array.isArray(original.items) ? original.items : undefined);
    const out = { ...redacted };
    for (const containerKey of ["requests", "items"]) {
        if (!Array.isArray(redacted[containerKey]) || !originalRows) {
            continue;
        }
        out[containerKey] = redacted[containerKey].map((row, index) => {
            const headers = pick(originalRows[index] ?? row);
            return headers ? { ...row, revealedHeaders: headers } : row;
        });
    }
    const detailHeaders = pick(original);
    if (Array.isArray(out.requests) === false && detailHeaders) {
        out.revealedHeaders = detailHeaders;
    }
    return out;
}
function isPlaceholderHeaderValue(value) {
    return typeof value !== "string" || value.length === 0 || value.includes("[REDACTED]");
}
export function collectRevealedHeaderLines(data, reveal) {
    if (!Array.isArray(reveal?.headers) || reveal.headers.length === 0 || !isRecord(data)) {
        return [];
    }
    const names = reveal.headers.map((header) => header.toLowerCase());
    const rows = Array.isArray(data.requests) ? data.requests : (Array.isArray(data.items) ? data.items : [data]);
    const lines = [];
    const seen = new Set();
    for (const row of rows) {
        if (!isRecord(row)) {
            continue;
        }
        for (const container of [row.revealedHeaders, row.requestHeaders, row.responseHeaders, row.headers]) {
            if (!isRecord(container)) {
                continue;
            }
            for (const [key, value] of Object.entries(container)) {
                const lower = key.toLowerCase();
                if (!names.includes(lower) || seen.has(lower) || isPlaceholderHeaderValue(value)) {
                    continue;
                }
                seen.add(lower);
                lines.push(`  → ${lower}: ${value}`);
            }
        }
    }
    return lines;
}
export function formatRevealedHeaderLines(row, reveal) {
    const names = Array.isArray(reveal?.headers) ? reveal.headers.map((header) => header.toLowerCase()) : [];
    if (names.length === 0 || !isRecord(row)) {
        return [];
    }
    // The prose formatter runs against the UNREDACTED payload, while the redacted copy carries the
    // `revealedHeaders` annotation, so read every plausible container and skip placeholders.
    const lines = [];
    const seen = new Set();
    for (const container of [row.revealedHeaders, row.requestHeaders, row.responseHeaders, row.headers, row.request?.headers, row.response?.headers]) {
        if (!isRecord(container)) {
            continue;
        }
        for (const [key, value] of Object.entries(container)) {
            const lower = key.toLowerCase();
            if (!names.includes(lower) || seen.has(lower) || isPlaceholderHeaderValue(value)) {
                continue;
            }
            seen.add(lower);
            lines.push(`  → ${lower}: ${value}`);
        }
    }
    return lines;
}
export function formatDiagnosticText(commandInfo, data) {
    if (commandInfo.command === "session")
        return formatSessionText(data);
    if (commandInfo.command === "profiles") {
        const profiles = getArrayField(data, "profiles");
        if (profiles)
            return formatProfilesText(profiles, "Chrome profiles");
    }
    if (commandInfo.command === "auth") {
        const profiles = getArrayField(data, "profiles");
        if (profiles)
            return formatProfilesText(profiles, "auth profiles");
        if (commandInfo.subcommand === "show")
            return formatAuthShowText(data);
    }
    if (commandInfo.command === "cookies")
        return formatCookiesText(data, commandInfo);
    if (commandInfo.command === "storage")
        return formatStorageText(data);
    if (commandInfo.command === "dialog")
        return formatDialogText(data);
    if (commandInfo.command === "frame")
        return formatFrameText(data);
    if (commandInfo.command === "state")
        return formatStateText(data, commandInfo.subcommand);
    if (commandInfo.command === "network" && commandInfo.subcommand === "requests")
        return formatNetworkRequestsText(data, commandInfo);
    if (commandInfo.command === "network" && commandInfo.subcommand === "request")
        return formatNetworkRequestText(data, commandInfo);
    if (commandInfo.command === "diff")
        return stringifyModelFacing(data);
    if (commandInfo.command === "clipboard") {
        const text = getStringField(data, "text") ?? getStringField(data, "value") ?? getStringField(data, "result");
        if (text)
            return redactModelFacingText(text);
    }
    if (commandInfo.command === "stream") {
        const streamSummary = getStreamSummary(data);
        if (streamSummary)
            return streamSummary;
    }
    if (commandInfo.command === "chat")
        return formatChatText(data);
    if (commandInfo.command === "console")
        return formatConsoleText(data, commandInfo);
    if (commandInfo.command === "errors")
        return formatErrorsText(data, commandInfo);
    if (commandInfo.command === "a11y")
        return formatA11yText(data);
    if (commandInfo.command === "dashboard")
        return formatDashboardText(data);
    if (commandInfo.command === "doctor")
        return formatDoctorText(data);
    return undefined;
}
