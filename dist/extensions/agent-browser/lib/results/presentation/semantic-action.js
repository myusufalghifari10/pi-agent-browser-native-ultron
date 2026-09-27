import { getCompiledSemanticActionCommandIndex, isCompiledSemanticActionFindCommand, } from "../../input-modes/semantic-action.js";
import { isRecord } from "../../parsing.js";
import { formatNavigationSummary, getNavigationSummary, isNavigationObservableCommand, } from "./navigation.js";
import { getPageSummary, redactModelFacingText } from "./common.js";
const SEMANTIC_NAVIGATION_PROBE_ACTIONS = new Set(["check", "click"]);
const SEMANTIC_PRESENTATION_ACTIONS = new Set(["check", "click", "fill", "select"]);
function formatSemanticActionTarget(compiled) {
    if (compiled.action === "select") {
        const selector = compiled.selector ?? "selector";
        const values = compiled.values?.length ? compiled.values.join(", ") : "";
        return values ? `${selector} → ${values}` : selector;
    }
    const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
    const locator = compiled.locator ?? compiled.args[commandIndex + 1] ?? "locator";
    const locatorValue = compiled.args[commandIndex + 2];
    const nameIndex = compiled.args.indexOf("--name");
    const name = nameIndex >= 0 ? compiled.args[nameIndex + 1] : undefined;
    const quotedValue = JSON.stringify(locatorValue ?? "");
    const target = `${locator} ${quotedValue}`;
    return name ? `${target} (name ${JSON.stringify(name)})` : target;
}
export function formatSemanticActionCompactLine(compiled) {
    const target = formatSemanticActionTarget(compiled);
    switch (compiled.action) {
        case "click":
            return `Clicked: ${target}`;
        case "fill":
            return `Filled: ${target}`;
        case "check":
            return `Checked: ${target}`;
        case "select":
            return `Selected: ${target}`;
        default:
            return `${compiled.action}: ${target}`;
    }
}
export function resolveSemanticPresentationCommand(compiled) {
    if (!compiled || !SEMANTIC_PRESENTATION_ACTIONS.has(compiled.action))
        return undefined;
    if (compiled.action === "select")
        return "select";
    if (isCompiledSemanticActionFindCommand(compiled))
        return compiled.action;
    return undefined;
}
export function resolvePresentationCommandInfo(commandInfo, compiledSemanticAction) {
    const presentationCommand = resolveSemanticPresentationCommand(compiledSemanticAction);
    if (!presentationCommand)
        return commandInfo;
    return { ...commandInfo, command: presentationCommand };
}
export function shouldCaptureSemanticActionNavigationSummary(compiled, data) {
    if (!compiled || !SEMANTIC_NAVIGATION_PROBE_ACTIONS.has(compiled.action))
        return false;
    if (!isCompiledSemanticActionFindCommand(compiled))
        return false;
    return !isRecord(data) || (typeof data.title !== "string" && typeof data.url !== "string");
}
export function formatSemanticActionPresentationText(compiled, data) {
    const presentationCommand = resolveSemanticPresentationCommand(compiled);
    if (!presentationCommand)
        return undefined;
    const actionLine = formatSemanticActionCompactLine(compiled);
    const navigationSummary = getNavigationSummary(data);
    if (navigationSummary && isNavigationObservableCommand(presentationCommand)) {
        const navigationText = formatNavigationSummary(navigationSummary);
        if (navigationText)
            return `${actionLine}\n\nCurrent page:\n${navigationText}`;
    }
    const pageSummary = getPageSummary(data);
    if (pageSummary)
        return `${actionLine}\n\nCurrent page:\n${redactModelFacingText(pageSummary)}`;
    return actionLine;
}
export function formatSemanticActionPresentationSummary(compiled, data) {
    const presentationCommand = resolveSemanticPresentationCommand(compiled);
    if (!presentationCommand)
        return undefined;
    const navigationSummary = getNavigationSummary(data);
    if (navigationSummary && isNavigationObservableCommand(presentationCommand)) {
        const navigationText = formatNavigationSummary(navigationSummary);
        if (navigationText) {
            return `${presentationCommand} → ${navigationText.split("\n", 1)[0] ?? navigationText}`;
        }
    }
    const pageSummary = getPageSummary(data);
    if (pageSummary)
        return `${presentationCommand} → ${pageSummary.split("\n", 1)[0] ?? pageSummary}`;
    return `${presentationCommand} → ${formatSemanticActionTarget(compiled)}`;
}
