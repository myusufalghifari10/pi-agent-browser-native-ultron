import { isNavigationObservableCommandName, isOpenNavigationCommand, isPageChangeSummaryCommand } from "../../command-taxonomy.js";
import { isRecord } from "../../parsing.js";
import { detectConfirmationRequired } from "../confirmation.js";
import { firstLine, omitUpstreamLifecycle, redactModelFacingText, stringifyModelFacing } from "./common.js";
const NAVIGATION_SUMMARY_FIELD = "navigationSummary";
const GET_RESULT_FIELDS = {
    attr: "value",
    count: "count",
    html: "html",
    text: "text",
    title: "title",
    url: "url",
    value: "value",
};
function getScalarExtractionResult(commandInfo, data) {
    const fallbackField = commandInfo.command === "get" && commandInfo.subcommand ? GET_RESULT_FIELDS[commandInfo.subcommand] ?? "" : "";
    const resultField = Object.hasOwn(data, "result") ? "result" : fallbackField.length > 0 && Object.hasOwn(data, fallbackField) ? fallbackField : undefined;
    if (resultField === undefined)
        return undefined;
    const result = data[resultField];
    if (typeof result === "string")
        return result.trim().length > 0 ? result : "(empty string)";
    if (typeof result === "number" || typeof result === "boolean")
        return String(result);
    if (result === null || result === undefined)
        return "null";
    if (typeof result === "object")
        return JSON.stringify(result, null, 2);
    return undefined;
}
function getExtractionOrigin(data) {
    if (typeof data.origin === "string" && data.origin.trim().length > 0) {
        return data.origin.trim();
    }
    if (typeof data.url === "string" && data.url.trim().length > 0) {
        return data.url.trim();
    }
    return undefined;
}
function formatGetSummaryLabel(subcommand) {
    if (!subcommand) {
        return "Get result";
    }
    if (subcommand.toLowerCase() === "url") {
        return "URL";
    }
    return `${subcommand.slice(0, 1).toUpperCase()}${subcommand.slice(1)}`;
}
export function formatExtractionSummary(commandInfo, data) {
    const scalarResult = getScalarExtractionResult(commandInfo, data);
    if (!scalarResult) {
        return undefined;
    }
    const safeScalarResult = redactModelFacingText(scalarResult);
    const firstResultLine = firstLine(safeScalarResult);
    if (commandInfo.command === "get") {
        return `${formatGetSummaryLabel(commandInfo.subcommand)}: ${firstResultLine}`;
    }
    if (commandInfo.command === "eval") {
        return `Eval result: ${firstResultLine}`;
    }
    return undefined;
}
export function formatExtractionText(commandInfo, data) {
    if (commandInfo.command !== "get" && commandInfo.command !== "eval") {
        return undefined;
    }
    const scalarResult = getScalarExtractionResult(commandInfo, data);
    if (!scalarResult) {
        return undefined;
    }
    const origin = getExtractionOrigin(data);
    const safeScalarResult = redactModelFacingText(scalarResult);
    const safeOrigin = origin ? redactModelFacingText(origin) : undefined;
    return safeOrigin && safeOrigin !== safeScalarResult ? `${safeScalarResult}\n\nOrigin: ${safeOrigin}` : safeScalarResult;
}
export function isNavigationObservableCommand(command, subcommand) {
    return isNavigationObservableCommandName(command, subcommand);
}
function isNavigationSummary(value) {
    return isRecord(value) && (typeof value.title === "string" || typeof value.url === "string");
}
export function getNavigationSummary(data) {
    const candidate = data[NAVIGATION_SUMMARY_FIELD];
    return isNavigationSummary(candidate) ? candidate : undefined;
}
function getTopLevelNavigationSummary(data) {
    return isNavigationSummary(data)
        ? {
            title: typeof data.title === "string" ? data.title : undefined,
            url: typeof data.url === "string" ? data.url : undefined,
        }
        : undefined;
}
function getNormalizedNavigationSummary(summary) {
    const title = typeof summary?.title === "string" && summary.title.trim().length > 0 ? summary.title.trim() : undefined;
    const url = typeof summary?.url === "string" && summary.url.trim().length > 0 ? summary.url.trim() : undefined;
    return title || url ? { title, url, ...(typeof summary?.urlChanged === "boolean" ? { urlChanged: summary.urlChanged } : {}) } : undefined;
}
export function formatNavigationSummary(summary) {
    const normalized = getNormalizedNavigationSummary(summary);
    if (!normalized)
        return undefined;
    if (normalized.title && normalized.url)
        return `${normalized.title}\n${normalized.url}`;
    return normalized.title ?? normalized.url;
}
export function buildPageChangeSummary(options) {
    const { artifacts, commandInfo, data, nextActions, savedFilePath } = options;
    const artifactCount = artifacts?.length ?? 0;
    const navigation = isRecord(data)
        ? getNormalizedNavigationSummary(getNavigationSummary(data) ?? (isPageChangeSummaryCommand(commandInfo.command, commandInfo.subcommand) ? getTopLevelNavigationSummary(data) : undefined))
        : undefined;
    const confirmationRequired = detectConfirmationRequired(data) !== undefined;
    if (!navigation && !confirmationRequired && artifactCount === 0 && !savedFilePath && !isPageChangeSummaryCommand(commandInfo.command, commandInfo.subcommand)) {
        return undefined;
    }
    const navigationObserved = navigation && (navigation.urlChanged === true || isOpenNavigationCommand(commandInfo.command) || ["back", "forward", "pushstate", "reload"].includes(commandInfo.command ?? ""));
    const changeType = savedFilePath || artifactCount > 0
        ? "artifact"
        : navigationObserved
            ? "navigation"
            : confirmationRequired
                ? "confirmation"
                : "mutation";
    const observed = changeType !== "mutation";
    const parts = [commandInfo.command ?? "agent-browser", observed ? changeType : "action dispatched"];
    if (navigation?.title)
        parts.push(navigation.title);
    if (navigation?.url)
        parts.push(navigation.url);
    if (savedFilePath)
        parts.push(savedFilePath);
    else if (artifactCount > 0)
        parts.push(`${artifactCount} artifact${artifactCount === 1 ? "" : "s"}`);
    return {
        ...(artifactCount > 0 ? { artifactCount } : {}),
        changeType,
        ...(commandInfo.command ? { command: commandInfo.command } : {}),
        ...(nextActions ? { nextActionIds: nextActions.map((action) => action.id) } : {}),
        observed,
        ...(savedFilePath ? { savedFilePath } : {}),
        summary: `${parts.join(" → ")}${observed ? "" : " → application change unverified"}`,
        ...(navigation?.title ? { title: navigation.title } : {}),
        ...(navigation?.url ? { url: navigation.url } : {}),
    };
}
function stripNavigationSummary(data) {
    const { [NAVIGATION_SUMMARY_FIELD]: _navigationSummary, ...rest } = data;
    return rest;
}
export function formatNavigationActionResult(data) {
    const actionData = omitUpstreamLifecycle(stripNavigationSummary(data));
    const lines = [];
    if (typeof actionData.clicked === "string" || typeof actionData.clicked === "boolean") {
        lines.push(`Clicked: ${String(actionData.clicked)}`);
    }
    if (typeof actionData.href === "string") {
        lines.push(`Href: ${redactModelFacingText(actionData.href)}`);
    }
    if (typeof actionData.navigated === "boolean") {
        lines.push(`Navigated: ${actionData.navigated}`);
    }
    if (lines.length > 0) {
        return lines.join("\n");
    }
    const actionText = stringifyModelFacing(actionData).trim();
    if (actionText.length === 0 || actionText === "{}") {
        return undefined;
    }
    return actionText;
}
