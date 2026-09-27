import { rm } from "node:fs/promises";
import { getAgentBrowserSessionIdentityKey } from "../../argv-grammar.js";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { isBrowserIndependentRead, needsManagedSession } from "../../command-policy.js";
import { runAgentBrowserProcess } from "../../process.js";
import { buildAgentBrowserNextActions } from "../../results/action-recommendations.js";
import { parseAgentBrowserEnvelope } from "../../results/envelope.js";
import { buildNextToolAction, withOptionalNamespaceArgs, withOptionalSessionArgs } from "../../results/next-actions.js";
import { getSessionPageStateKey, isAboutBlankUrl, normalizeComparableUrl, targetsMatch, } from "../../session-page-state.js";
import { getRecordCommandOperands, isCloseCommand, isElectronPostCommandHealthCommand, isNavigationObservableCommandName, isOpenNavigationCommand, isRefGuardedCommand, isRefInvalidatingBatchCommand, isSessionTabPinningExcludedCommand, isSessionTabPostCommandCorrectionExcludedCommand, isWindowOrDiffPageTransitionCommand, } from "../../command-taxonomy.js";
import { chooseOpenResultTabCorrection } from "../../runtime.js";
import { isRecord, parseRefId } from "../../parsing.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { findFirstPositionalArgument } from "./prepare/wait-timeouts.js";
export function applyBrowserRunStatePatch(state, patch) {
    if (!patch)
        return;
    if ("artifactManifest" in patch)
        state.artifactManifest = patch.artifactManifest;
    if (patch.freshSessionOrdinal !== undefined)
        state.freshSessionOrdinal = patch.freshSessionOrdinal;
    if (patch.managedSessionActive !== undefined)
        state.managedSessionActive = patch.managedSessionActive;
    if ("managedSessionCompatibilityWorkaround" in patch)
        state.managedSessionCompatibilityWorkaround = patch.managedSessionCompatibilityWorkaround;
    if (patch.managedSessionHeadedAutosaveDisabled !== undefined)
        state.managedSessionHeadedAutosaveDisabled = patch.managedSessionHeadedAutosaveDisabled;
    if ("managedSessionHeadedAutosaveInterval" in patch)
        state.managedSessionHeadedAutosaveInterval = patch.managedSessionHeadedAutosaveInterval;
    if (patch.managedSessionCwd !== undefined)
        state.managedSessionCwd = patch.managedSessionCwd;
    if (patch.managedSessionName !== undefined)
        state.managedSessionName = patch.managedSessionName;
    if ("managedSessionNamespace" in patch)
        state.managedSessionNamespace = patch.managedSessionNamespace;
    if (patch.networkRoutesBySession)
        state.networkRoutesBySession = patch.networkRoutesBySession;
}
export const getSessionContextKey = getSessionPageStateKey;
export function buildSessionDetailFields(sessionName, usedImplicitSession, namespace, managedSessionRestoreDisabled = false) {
    return {
        ...(namespace !== undefined ? { namespace } : {}),
        ...(sessionName
            ? {
                sessionName,
                usedImplicitSession,
                ...(managedSessionRestoreDisabled ? { managedSessionRestoreDisabled: true } : {}),
            }
            : {}),
    };
}
export function buildManagedSessionOutcome(options) {
    const { activeAfter, activeBefore, attemptedSessionName, command, currentSessionName, currentSessionNamespace, previousSessionName, replacedSessionName, replacedSessionNamespace, sessionMode, succeeded } = options;
    if (!attemptedSessionName)
        return undefined;
    let status;
    let summary;
    if (isCloseCommand(command)) {
        status = succeeded ? "closed" : activeBefore ? "preserved" : "abandoned";
        summary = succeeded
            ? `Managed session ${attemptedSessionName} was closed.`
            : activeBefore
                ? `Managed session close failed; previous managed session ${previousSessionName} remains current.`
                : `Managed session close failed; no managed session is active.`;
    }
    else if (succeeded) {
        if (replacedSessionName) {
            status = "replaced";
            summary = `Managed session ${replacedSessionName} was replaced by ${currentSessionName}.`;
        }
        else if (!activeBefore && activeAfter) {
            status = "created";
            summary = `Managed session ${currentSessionName} is now current.`;
        }
        else {
            status = "unchanged";
            summary = `Managed session ${currentSessionName} remains current.`;
        }
    }
    else if (activeBefore) {
        status = "preserved";
        summary = sessionMode === "fresh" && attemptedSessionName !== previousSessionName
            ? `Fresh managed session ${attemptedSessionName} failed before becoming current; previous managed session ${previousSessionName} was preserved.`
            : `Managed session call failed; previous managed session ${previousSessionName} was preserved.`;
    }
    else {
        status = "abandoned";
        summary = sessionMode === "fresh"
            ? `Fresh managed session ${attemptedSessionName} failed before becoming current; no previous managed session was active, so no managed session is current.`
            : `Managed session call failed before any managed session became current.`;
    }
    return {
        activeAfter,
        activeBefore,
        attemptedSessionName,
        currentSessionName,
        ...(currentSessionNamespace ? { currentSessionNamespace } : {}),
        previousSessionName,
        replacedSessionName,
        replacedSessionNamespace,
        sessionMode,
        status,
        succeeded,
        summary,
    };
}
function isFreshPostLaunchFailure(outcome) {
    return !outcome.succeeded && outcome.sessionMode === "fresh" && outcome.activeAfter && !!outcome.currentSessionName && (outcome.status === "created" || outcome.status === "replaced" || outcome.status === "unchanged");
}
function formatManagedSessionOutcomeHeadline(outcome) {
    if (outcome.status === "preserved") {
        return "Managed session outcome: Fresh launch failed; your previous browser session is still active.";
    }
    if (outcome.status === "abandoned") {
        return "Managed session outcome: Fresh launch failed; no managed browser session is current.";
    }
    if (isFreshPostLaunchFailure(outcome)) {
        return "Managed session outcome: Fresh launch became current, but this tool call failed after launch.";
    }
    return `Managed session outcome: ${outcome.summary}`;
}
function formatManagedSessionOutcomeRecoveryGuidance(outcome) {
    const lines = ["Recovery:"];
    if (outcome.status === "preserved") {
        lines.push('- Continue with sessionMode "auto" on the current session, or retry the intended launch with sessionMode "fresh".');
        lines.push("- Run doctor to verify agent-browser install and environment when failures persist.");
    }
    else if (outcome.status === "abandoned") {
        lines.push('- Retry with sessionMode "fresh" (for example args: ["open", "<url>"]) after verifying agent-browser is on PATH.');
        lines.push("- Run doctor when install or environment issues are suspected.");
    }
    else if (isFreshPostLaunchFailure(outcome)) {
        lines.push('- Continue with sessionMode "auto" on the current session, or inspect failureCategory / qaPreset to fix the post-launch failure.');
        lines.push("- Run doctor only if later browser commands also fail.");
    }
    else {
        lines.push('- Retry with sessionMode "fresh" when launch-scoped flags must apply, or run doctor to verify the environment.');
    }
    lines.push("- Full session names and transition details remain in details.managedSessionOutcome.");
    return lines.join("\n");
}
export function formatManagedSessionOutcomeText(outcome) {
    if (!outcome)
        return undefined;
    if (outcome.replacedSessionClosed === false) {
        const cleanupWarning = "Cleanup warning: Automatic close of the previous wrapper-managed session failed, so it remains wrapper-owned. Use details.managedSessionOutcome for its exact identity and close it explicitly when safe.";
        return outcome.succeeded
            ? ["Managed session outcome: The fresh browser became current.", cleanupWarning].join("\n")
            : [formatManagedSessionOutcomeHeadline(outcome), formatManagedSessionOutcomeRecoveryGuidance(outcome), cleanupWarning].join("\n");
    }
    if (outcome.status === "closed" && outcome.succeeded) {
        return [
            "Managed session outcome: The current wrapper-managed browser session was closed.",
            "Next sessionMode auto call will start or attach a managed session as needed. If upstream session list still shows rows, they are separate saved/upstream sessions; use close --all only when full cleanup is intended.",
            "Full session names and transition details remain in details.managedSessionOutcome.",
        ].join("\n");
    }
    if (outcome.succeeded || outcome.sessionMode !== "fresh")
        return undefined;
    return [formatManagedSessionOutcomeHeadline(outcome), formatManagedSessionOutcomeRecoveryGuidance(outcome)].join("\n");
}
export function buildManagedSessionFreshFailureNextActions(outcome) {
    if (!outcome || outcome.succeeded || outcome.sessionMode !== "fresh")
        return [];
    const actions = [];
    if (!isFreshPostLaunchFailure(outcome)) {
        actions.push(buildNextToolAction({
            args: ["doctor"],
            id: "run-agent-browser-doctor",
            reason: "Verify agent-browser install, PATH, and environment after a failed fresh launch.",
            safety: "Read-only local diagnostics; does not mutate browser state.",
        }));
    }
    if ((outcome.status === "preserved" || isFreshPostLaunchFailure(outcome)) && outcome.activeAfter && outcome.currentSessionName) {
        const sessionLabel = isFreshPostLaunchFailure(outcome) ? "current managed session" : "preserved managed session";
        const currentSessionArgs = (args) => withOptionalNamespaceArgs(outcome.currentSessionNamespace, withOptionalSessionArgs(outcome.currentSessionName, args));
        actions.push(buildNextToolAction({
            args: currentSessionArgs(["get", "url"]),
            id: "verify-current-managed-session",
            reason: `Confirm the ${sessionLabel} before continuing with sessionMode auto.`,
            safety: `Read-only URL check on the ${sessionLabel}.`,
        }), buildNextToolAction({
            args: currentSessionArgs(["snapshot", "-i"]),
            id: "snapshot-current-managed-session",
            reason: `Refresh interactive refs on the ${sessionLabel} before retrying the workflow.`,
            safety: "Read-only snapshot; no navigation.",
        }));
    }
    else {
        actions.push(buildNextToolAction({
            args: ["open", "about:blank"],
            id: "retry-fresh-managed-session",
            reason: "Start a new managed browser session after the failed fresh launch.",
            safety: "Replace about:blank with the intended URL from your workflow.",
            sessionMode: "fresh",
        }));
    }
    return actions;
}
function getTraceOwner(command) {
    return command === "trace" || command === "profiler" ? command : undefined;
}
export function getTraceOwnerGuardMessage(options) {
    const owner = getTraceOwner(options.command);
    if (!owner || !options.sessionName || (options.subcommand !== "start" && options.subcommand !== "stop")) {
        return undefined;
    }
    const activeOwner = options.traceOwners.get(options.sessionName);
    if (!activeOwner || activeOwner === owner) {
        return undefined;
    }
    return options.subcommand === "start"
        ? `Wrapper believes ${activeOwner} tracing is active for session ${options.sessionName}; stop ${activeOwner} before starting ${owner}.`
        : `Wrapper believes tracing for session ${options.sessionName} is owned by ${activeOwner}; run ${activeOwner} stop instead of ${owner} stop.`;
}
export function updateTraceOwnerState(options) {
    if (!options.sessionName || !options.succeeded)
        return;
    if (isCloseCommand(options.command)) {
        options.traceOwners.delete(options.sessionName);
        return;
    }
    const owner = getTraceOwner(options.command);
    if (!owner)
        return;
    if (options.subcommand === "start") {
        options.traceOwners.set(options.sessionName, owner);
    }
    if (options.subcommand === "stop" && options.traceOwners.get(options.sessionName) === owner) {
        options.traceOwners.delete(options.sessionName);
    }
}
export function extractStringResultField(data, fieldName) {
    if (typeof data === "string") {
        if (fieldName === "value")
            return data;
        const text = data.trim();
        return text.length > 0 ? text : undefined;
    }
    if (!isRecord(data) || typeof data[fieldName] !== "string") {
        return undefined;
    }
    if (fieldName === "value")
        return data[fieldName];
    const text = data[fieldName].trim();
    return text.length > 0 ? text : undefined;
}
export function extractNavigationSummaryFromData(data) {
    const result = isRecord(data) && isRecord(data.result) ? data.result : data;
    const title = extractStringResultField(result, "title");
    const url = extractStringResultField(result, "url");
    const urlChanged = isRecord(result) && typeof result.urlChanged === "boolean" ? result.urlChanged : undefined;
    return title || url ? { title, url, urlChanged } : undefined;
}
export function shouldCaptureNavigationSummary(command, data, subcommand) {
    if (command === "eval")
        return true;
    return (isNavigationObservableCommandName(command, subcommand) &&
        (!isRecord(data) || (typeof data.title !== "string" && typeof data.url !== "string")));
}
export function mergeNavigationSummaryIntoData(data, navigationSummary) {
    if (isRecord(data)) {
        return { ...data, navigationSummary };
    }
    return { navigationSummary, result: data };
}
export function buildAboutBlankRecoveryHint() {
    return "agent_browser detected that the active tab became about:blank while this session still had a prior intended tab. Run tab list for this session and re-select the intended tab, or retry with sessionMode:fresh if the tab is gone.".replace("sessionMode:fresh", "sessionMode=fresh");
}
export function buildAboutBlankWarning(mismatch) {
    return `Warning: agent_browser detected that this session returned about:blank while the prior intended tab was ${mismatch.targetUrl}. ${mismatch.recoveryApplied ? "The wrapper re-selected the intended tab for the session." : "No matching tab could be re-selected; run tab list for the same session or retry with sessionMode=fresh."}`;
}
function extractBatchResultCommand(item) {
    return Array.isArray(item.command) ? item.command.filter((token) => typeof token === "string") : [];
}
export function getStaleRefArgs(commandTokens, stdin) {
    if (commandTokens[0] !== "batch") {
        return commandTokens;
    }
    const steps = getUpstreamEffectiveBatchSteps(commandTokens, stdin);
    return steps.length > 0 ? steps.flatMap((step) => step) : commandTokens;
}
// Inspect only upstream's selector slots: fill text, file paths and key data are not refs.
function collectRefsFromTokens(tokens) {
    if (!isRefGuardedCommand(tokens[0]) || (tokens[0] === "diff" && tokens[1] !== "screenshot"))
        return [];
    let selectors;
    switch (tokens[0]) {
        case "click":
            selectors = [tokens.slice(1).find((token) => token !== "--new-tab")];
            break;
        case "drag":
            selectors = tokens.slice(1, 3);
            break;
        case "get":
            selectors = [!["url", "title", "cdp-url", "count"].includes(tokens[1]) ? tokens[2] : undefined];
            break;
        case "is":
            selectors = [tokens[2]];
            break;
        case "screenshot":
            selectors = [tokens.slice(1).find((token) => !["--full", "-f"].includes(token))];
            break;
        case "diff":
        case "scroll": {
            let selector;
            for (let index = tokens[0] === "diff" ? 2 : 1; index < tokens.length; index += 1) {
                const token = tokens[index];
                if (token === "--selector" || token === "-s")
                    selector = tokens[++index];
                else if (tokens[0] === "diff" && ["--baseline", "-b", "--output", "-o", "--threshold", "-t", "--depth", "-d"].includes(token))
                    index += 1;
            }
            selectors = [selector];
            break;
        }
        default: selectors = [tokens[1]];
    }
    return selectors.flatMap((selector) => {
        const ref = selector === undefined ? undefined : parseRefId(selector);
        return ref === undefined ? [] : [ref];
    });
}
export function getGuardedRefUsage(commandTokens, stdin, options = {}) {
    if (commandTokens[0] !== "batch") {
        return collectRefsFromTokens(commandTokens);
    }
    const steps = getUpstreamEffectiveBatchSteps(commandTokens, stdin);
    const refsBeforeInBatchSnapshot = [];
    for (const step of steps) {
        if (!options.includeRefsAfterBatchSnapshot && (step[0] ?? "") === "snapshot")
            break;
        refsBeforeInBatchSnapshot.push(...collectRefsFromTokens(step));
    }
    return refsBeforeInBatchSnapshot;
}
function getSnapshotRefRole(refSnapshot, refId) {
    return refSnapshot?.refs?.[refId]?.role?.toLowerCase();
}
function isSafeSameSnapshotFormBatchStep(step, refSnapshot) {
    const command = step[0];
    const refIds = collectRefsFromTokens(step);
    if (refIds.length === 0 || !refSnapshot)
        return false;
    const roles = refIds.map((refId) => getSnapshotRefRole(refSnapshot, refId));
    if (roles.some((role) => role === undefined))
        return false;
    if (command === "check" || command === "uncheck")
        return roles.every((role) => role === "checkbox" || role === "radio");
    if (command === "click" || command === "tap")
        return roles.every((role) => role === "checkbox" || role === "radio");
    if (command === "select")
        return roles.every((role) => role === "combobox");
    return false;
}
function getBatchRefInvalidationMessage(commandTokens, stdin, refSnapshot) {
    if (commandTokens[0] !== "batch")
        return undefined;
    let priorStepInvalidatesRefs = false;
    for (const step of getUpstreamEffectiveBatchSteps(commandTokens, stdin)) {
        if ((step[0] ?? "") === "snapshot") {
            priorStepInvalidatesRefs = false;
        }
        const refIds = collectRefsFromTokens(step);
        if (refIds.length > 0 && isRefGuardedCommand(step[0]) && priorStepInvalidatesRefs) {
            return `Batch step ${step[0]} uses page-scoped ref ${refIds.map((refId) => `@${refId}`).join(", ")} after an earlier batch step can navigate or mutate the page. Split the batch, run snapshot -i after the page-changing step, then retry with current refs.`;
        }
        if (isRefInvalidatingBatchCommand(step) && !isSafeSameSnapshotFormBatchStep(step, refSnapshot)) {
            priorStepInvalidatesRefs = true;
        }
    }
    return undefined;
}
export function buildStaleRefPreflight(options) {
    const guardedRefIds = [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin))];
    const usedRefIds = options.refSnapshotInvalidation
        ? [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin, { includeRefsAfterBatchSnapshot: true }))]
        : guardedRefIds;
    const batchInvalidationMessage = getBatchRefInvalidationMessage(options.commandTokens, options.stdin, options.refSnapshot);
    if (batchInvalidationMessage && guardedRefIds.length > 0) {
        return {
            message: batchInvalidationMessage,
            refIds: guardedRefIds,
            snapshot: options.refSnapshot,
        };
    }
    if (usedRefIds.length === 0)
        return undefined;
    if (options.refSnapshotInvalidation) {
        return {
            message: options.refSnapshotInvalidation.reason === "page-transition"
                ? `Ref ${usedRefIds.map((refId) => `@${refId}`).join(", ")} cannot be used yet. ${options.refSnapshotInvalidation.summary}`
                : `Ref ${usedRefIds.map((refId) => `@${refId}`).join(", ")} cannot be used because the latest snapshot for this session reported No active page. Run snapshot -i successfully before using page-scoped refs.`,
            refIds: usedRefIds,
            snapshotInvalidation: options.refSnapshotInvalidation,
        };
    }
    if (!options.refSnapshot)
        return undefined;
    if (!targetsMatch(options.refSnapshot.target, options.currentTarget)) {
        return {
            message: `Ref ${usedRefIds.map((refId) => `@${refId}`).join(", ")} came from a snapshot for ${options.refSnapshot.target?.url ?? "a prior page"}, but the current session target is ${options.currentTarget?.url ?? "unknown"}. Run snapshot -i again before using page-scoped refs.`,
            refIds: usedRefIds,
            snapshot: options.refSnapshot,
        };
    }
    const knownRefs = new Set(options.refSnapshot.refIds);
    const missingRefs = usedRefIds.filter((refId) => !knownRefs.has(refId));
    if (missingRefs.length > 0) {
        return {
            message: `Ref ${missingRefs.map((refId) => `@${refId}`).join(", ")} was not present in the latest snapshot for this session. Run snapshot -i again before using page-scoped refs.`,
            refIds: missingRefs,
            snapshot: options.refSnapshot,
        };
    }
    return undefined;
}
export function commandChoosesSessionTabTarget(args) {
    const tokens = parseArgvDescriptor(args).upstreamCommandTokens;
    const [command, subcommand] = tokens;
    return isOpenNavigationCommand(command) || isCloseCommand(command) || command === "connect"
        || (command === "state" && subcommand === "load")
        || (command === "tab" && subcommand !== undefined && subcommand !== "list")
        || isWindowOrDiffPageTransitionCommand(command, subcommand)
        || (command === "a11y" && findFirstPositionalArgument(tokens) !== undefined)
        || (["vitals", "web-vitals"].includes(command) && tokens.slice(1).some((token) => !token.startsWith("--")))
        || getRecordCommandOperands(tokens).url !== undefined;
}
export function shouldPinSessionTabForCommand(options) {
    if (!options.pinningRequired || !options.sessionName || !options.command || isBrowserIndependentRead(options.commandTokens, options.stdin))
        return false;
    const steps = options.command === "batch" ? getUpstreamEffectiveBatchSteps(options.commandTokens, options.stdin) : [options.commandTokens];
    for (const step of steps) {
        const descriptor = parseArgvDescriptor(step);
        const tokens = descriptor.upstreamCommandTokens;
        const [command, subcommand] = tokens;
        // A later page action uses the explicit destination, not the remembered tab.
        if (commandChoosesSessionTabTarget(tokens))
            return false;
        if (!needsManagedSession(descriptor) || isSessionTabPinningExcludedCommand(command))
            continue;
        if (command === "get" && subcommand === "url" && !options.reopenPending)
            continue;
        if (command === "record" && subcommand === "stop")
            continue;
        if (["console", "errors"].includes(command))
            continue;
        if (command === "network" && !(subcommand === "requests" && tokens.some((token) => ["--current-page", "--current-origin", "--current-url"].includes(token))))
            continue;
        return true;
    }
    return false;
}
export function shouldCorrectSessionTabAfterCommand(options) {
    return (options.pinningRequired === true &&
        options.sessionName !== undefined &&
        options.command !== undefined &&
        !isSessionTabPostCommandCorrectionExcludedCommand(options.command));
}
function getTabSelection(tab) {
    if (typeof tab.tabId === "string" && tab.tabId.trim().length > 0)
        return { selectedTab: tab.tabId.trim(), selectionKind: "tabId" };
    if (typeof tab.label === "string" && tab.label.trim().length > 0)
        return { selectedTab: tab.label.trim(), selectionKind: "label" };
    return typeof tab.index === "number" ? { selectedTab: String(tab.index), selectionKind: "index" } : undefined;
}
function selectSessionTargetTab(options) {
    return chooseOpenResultTabCorrection({
        tabs: options.tabs,
        targetTitle: options.target.title,
        targetUrl: options.target.url,
    });
}
function selectAnySessionTargetTab(options) {
    const targetUrl = typeof options.target.url === "string" ? normalizeComparableUrl(options.target.url) : undefined;
    if (!targetUrl)
        return undefined;
    const matchingTabs = options.tabs.filter((tab) => normalizeComparableUrl(tab.url ?? "") === targetUrl);
    const targetTitle = options.target.title?.trim() ?? "";
    const titledTabs = targetTitle ? matchingTabs.filter((tab) => tab.title?.trim() === targetTitle) : [];
    const selectedTab = titledTabs.find((tab) => tab.active) ?? titledTabs[0] ?? matchingTabs.find((tab) => tab.active) ?? matchingTabs[0];
    const selection = selectedTab ? getTabSelection(selectedTab) : undefined;
    return selection ? { ...selection, ...(targetTitle ? { targetTitle } : {}), targetUrl } : undefined;
}
// wave4 (live-sweep W-N3): pure decision for the extinct-target case — the active page to follow
// when no tab matches the tracked URL, or undefined when there is nothing sane to follow.
export function resolveExtinctTargetFollowTab(tabs) {
    const activeTab = (Array.isArray(tabs) ? tabs : []).find((tab) => isRecord(tab) && tab.active === true);
    if (!activeTab)
        return undefined;
    const activeUrl = normalizeComparableUrl(typeof activeTab.url === "string" ? activeTab.url : "");
    if (!activeUrl || isAboutBlankUrl(activeTab.url ?? ""))
        return undefined;
    const selection = getTabSelection(activeTab);
    return selection ? { ...selection, targetUrl: activeUrl, extinctTargetFollowed: true } : undefined;
}
export async function runSessionCommandData(options) {
    const { args, cwd, env, namespace, pinNamespace, sessionName, signal, stdin, throwOnFailure, timeoutMs } = options;
    if (!sessionName)
        return undefined;
    const processResult = await runAgentBrowserProcess({
        args: ["--json", ...(namespace !== undefined || pinNamespace ? ["--namespace", namespace ?? ""] : []), "--session", sessionName, ...args],
        cwd,
        env,
        signal,
        stdin,
        timeoutMs,
    });
    try {
        options.onProcessResult?.(processResult);
        if (processResult.aborted || processResult.spawnError || processResult.exitCode !== 0) {
            if (throwOnFailure) {
                const reason = processResult.aborted
                    ? "command was aborted"
                    : processResult.spawnError
                        ? "process could not start"
                        : `process exited with code ${processResult.exitCode}`;
                throw new Error(`agent-browser ${reason}`);
            }
            return undefined;
        }
        const parsed = await parseAgentBrowserEnvelope({
            stdout: processResult.stdout,
            stdoutPath: processResult.stdoutSpillPath,
        });
        if (parsed.parseError || parsed.envelope?.success === false) {
            if (throwOnFailure)
                throw new Error(parsed.parseError ? "agent-browser returned invalid structured output" : "agent-browser reported failure");
            return undefined;
        }
        return parsed.envelope?.data;
    }
    finally {
        if (processResult.stdoutSpillPath) {
            await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
        }
    }
}
export async function collectOpenResultTabCorrection(options) {
    const { cwd, namespace, sessionName, signal, targetTitle, targetUrl } = options;
    const tabData = await runSessionCommandData({ args: ["tab", "list"], cwd, namespace, sessionName, signal });
    if (!isRecord(tabData) || !Array.isArray(tabData.tabs)) {
        return undefined;
    }
    const tabs = tabData.tabs.filter(isRecord).map((tab, index) => ({
        active: tab.active === true,
        index: typeof tab.index === "number" ? tab.index : index,
        label: typeof tab.label === "string" ? tab.label : undefined,
        tabId: typeof tab.tabId === "string" ? tab.tabId : undefined,
        title: typeof tab.title === "string" ? tab.title : undefined,
        url: typeof tab.url === "string" ? tab.url : undefined,
    }));
    return chooseOpenResultTabCorrection({ tabs, targetTitle, targetUrl });
}
function mapTabData(tabData) {
    if (!isRecord(tabData) || !Array.isArray(tabData.tabs))
        return undefined;
    return tabData.tabs.filter(isRecord).map((tab, index) => ({
        active: tab.active === true,
        index: typeof tab.index === "number" ? tab.index : index,
        label: typeof tab.label === "string" ? tab.label : undefined,
        tabId: typeof tab.tabId === "string" ? tab.tabId : undefined,
        title: typeof tab.title === "string" ? tab.title : undefined,
        url: typeof tab.url === "string" ? tab.url : undefined,
    }));
}
export async function collectSessionTabSelection(options) {
    const { cwd, namespace, sessionName, signal, target } = options;
    const tabData = await runSessionCommandData({ args: ["tab", "list"], cwd, namespace, sessionName, signal });
    const tabs = mapTabData(tabData);
    return tabs ? selectSessionTargetTab({ tabs, target }) : undefined;
}
export async function ensureSessionTabTarget(options) {
    const readTabs = async () => mapTabData(await runSessionCommandData({ ...options, args: ["tab", "list"] }));
    const tabs = await readTabs();
    const active = tabs?.find((tab) => tab.active);
    const correction = tabs && selectAnySessionTargetTab({ tabs, target: options.target });
    const error = "agent-browser could not re-select and verify the intended tab before running the command. Run tab list, then select the intended tab with tab <label> (for example [\"tab\",\"t1\"]), then snapshot -i before retrying.";
    if (!correction) {
        // wave4 (live-sweep W-N3): the tracked target URL is extinct — no open tab is at that URL
        // anymore because the tab navigated itself (server redirect chains, SPA handoffs, OIDC
        // callbacks). Previously this returned the drift error unconditionally and the caller
        // looped forever: tab list never heals a dead target and only the undiscoverable
        // `tab <label>` command did. The only sane continuation is the active page — follow it and
        // let this run's observed target re-record the tracked state. Refs stay protected by the
        // separate ref-snapshot invalidation machinery (URL change ⇒ stale refs).
        const follow = resolveExtinctTargetFollowTab(tabs);
        if (follow)
            return { correction: follow };
        return { error };
    }
    // Native tab selection clears refs and frame scope even when selecting the current tab.
    if (active && getTabSelection(active)?.selectedTab === correction.selectedTab)
        return {};
    if (!await applyOpenResultTabCorrection({ ...options, correction }))
        return { correction, error };
    const selected = (await readTabs())?.find((tab) => tab.active);
    return selected && getTabSelection(selected)?.selectedTab === correction.selectedTab && normalizeComparableUrl(selected.url ?? "") === normalizeComparableUrl(options.target.url)
        ? { correction }
        : { correction, error };
}
export async function applyOpenResultTabCorrection(options) {
    const { correction, cwd, namespace, sessionName, signal } = options;
    const result = await runSessionCommandData({
        args: ["tab", correction.selectedTab],
        cwd,
        namespace,
        sessionName,
        signal,
    });
    return result === undefined ? undefined : correction;
}
export function isLiveElectronRendererTarget(target) {
    const normalizedUrl = normalizeComparableUrl(target.url);
    if (!normalizedUrl || normalizedUrl === "about:blank" || normalizedUrl.startsWith("devtools://"))
        return false;
    return target.type === undefined || target.type === "page" || target.type === "webview";
}
export function getLiveElectronRendererTargets(targets) {
    return targets.filter(isLiveElectronRendererTarget);
}
export function electronTargetLabel(target) {
    if (!target)
        return "unknown target";
    return [target.title, target.url, target.id].find((value) => typeof value === "string" && value.trim().length > 0) ?? "unknown target";
}
export function getActiveElectronRecords(records) {
    return [...records.values()].filter((record) => record.cleanupState === "active" || record.cleanupState === "dead" || record.cleanupState === "partial" || record.cleanupState === "failed");
}
export function findElectronLaunchRecordForSession(sessionName, records, namespace) {
    if (!sessionName)
        return undefined;
    const sessionKey = getAgentBrowserSessionIdentityKey(sessionName, namespace);
    return getActiveElectronRecords(records).find((record) => record.sessionName && getAgentBrowserSessionIdentityKey(record.sessionName, record.namespace) === sessionKey);
}
function buildElectronReattachNextAction(record, liveTarget) {
    const endpoint = liveTarget?.webSocketDebuggerUrl ?? record.webSocketDebuggerUrl ?? String(record.port);
    return {
        id: "reattach-electron-launch",
        params: { args: ["connect", endpoint], sessionMode: "fresh" },
        reason: "Attach a fresh managed session to the same wrapper-tracked Electron debug endpoint when the current session no longer matches the live renderer.",
        safety: "Creates a new managed browser session; it does not mutate the Electron app. Keep the launchId for later status and cleanup.",
        tool: "agent_browser",
    };
}
export function buildElectronMismatchNextActions(record, liveTarget) {
    const baseActions = buildAgentBrowserNextActions({
        electron: { launchId: record.launchId, sessionName: record.sessionName, status: record.cleanupState },
        resultCategory: "success",
        successCategory: "completed",
    }) ?? [];
    const reattachAction = buildElectronReattachNextAction(record, liveTarget);
    const actions = [];
    for (const action of baseActions) {
        actions.push(action);
        if (action.id === "probe-electron-launch")
            actions.push(reattachAction);
    }
    if (!actions.some((action) => action.id === reattachAction.id))
        actions.push(reattachAction);
    return actions;
}
export function buildElectronSessionMismatch(options) {
    const liveTargets = getLiveElectronRendererTargets(options.statusTargets);
    if (liveTargets.length === 0)
        return undefined;
    const managedUrl = normalizeComparableUrl(options.managedSession.url);
    const matchingLiveTarget = managedUrl
        ? liveTargets.find((target) => normalizeComparableUrl(target.url) === managedUrl)
        : undefined;
    if (matchingLiveTarget)
        return undefined;
    const liveTarget = liveTargets[0];
    let reason;
    if (isAboutBlankUrl(options.managedSession.url)) {
        reason = "managed-session-about-blank-while-launch-target-live";
    }
    else if (options.record.sessionName && options.record.sessionName !== options.managedSession.sessionName) {
        reason = "launch-session-not-current";
    }
    else if (managedUrl) {
        reason = "managed-session-target-not-in-launch-status";
    }
    if (!reason)
        return undefined;
    const managedDescription = options.managedSession.url ?? options.managedSession.title ?? options.managedSession.sessionName;
    const liveDescription = electronTargetLabel(liveTarget);
    const summary = reason === "launch-session-not-current"
        ? `Electron session mismatch: current managed session ${options.managedSession.sessionName} is not the wrapper launch session ${options.record.sessionName ?? "unknown"}, while launch ${options.record.launchId} still has live target ${liveDescription}.`
        : `Electron session mismatch: managed session ${options.managedSession.sessionName} is on ${managedDescription}, but launch ${options.record.launchId} still has live target ${liveDescription}.`;
    const nextActions = buildElectronMismatchNextActions(options.record, liveTarget);
    return {
        launchId: options.record.launchId,
        liveTarget,
        managedSession: options.managedSession,
        nextActionIds: nextActions.map((action) => action.id),
        reason,
        sessionName: options.record.sessionName,
        statusTargets: options.statusTargets,
        summary,
    };
}
export function formatElectronSessionMismatchText(mismatch) {
    return `${mismatch.summary}\nNext: run electron.status/electron.probe with launchId ${mismatch.launchId}, reattach with the reattach-electron-launch nextAction if needed, or cleanup when finished.`;
}
export function shouldInspectElectronPostCommandHealth(command) {
    return isElectronPostCommandHealthCommand(command);
}
export function buildElectronLifecycleNextActions(record) {
    return buildAgentBrowserNextActions({
        electron: { launchId: record.launchId, sessionName: record.sessionName, status: record.cleanupState },
        resultCategory: "success",
        successCategory: "completed",
    }) ?? [];
}
export function buildElectronPostCommandHealthDiagnostic(options) {
    let reason;
    if (options.status.pidAlive === false)
        reason = "process-dead";
    else if (!options.status.portAlive)
        reason = "debug-port-dead";
    else if (isAboutBlankUrl(options.target?.url) && getLiveElectronRendererTargets(options.status.targets).length === 0)
        reason = "about-blank-no-live-target";
    if (!reason)
        return undefined;
    const nextActions = buildElectronLifecycleNextActions(options.record);
    const commandText = options.command ? `${options.command} command` : "command";
    const statusText = `${options.status.portAlive ? "debug port alive" : "debug port dead"}${options.status.pidAlive === undefined ? "" : options.status.pidAlive ? ", pid alive" : ", pid dead"}`;
    const summary = `Electron lifecycle warning: ${commandText} completed, but launch ${options.record.launchId} is no longer healthy (${statusText}).`;
    return {
        appName: options.record.appName,
        command: options.command,
        launchId: options.record.launchId,
        nextActionIds: nextActions.map((action) => action.id),
        reason,
        sessionName: options.record.sessionName,
        status: options.status,
        summary,
        target: options.target,
    };
}
export function formatElectronPostCommandHealthText(diagnostic) {
    if (!diagnostic)
        return undefined;
    const lines = [diagnostic.summary];
    if (diagnostic.target?.url)
        lines.push(`Current browser session target: ${diagnostic.target.url}.`);
    lines.push(`Status: ${diagnostic.status.portAlive ? "debug port alive" : "debug port dead"}${diagnostic.status.pidAlive === undefined ? "" : diagnostic.status.pidAlive ? ", pid alive" : ", pid dead"}; ${diagnostic.status.targets.length} CDP target(s).`);
    lines.push(`Next: run electron.status/electron.probe with launchId ${diagnostic.launchId}, cleanup the wrapper-owned launch if dead, or relaunch the app.`);
    return lines.join("\n");
}
export function buildElectronIdentifiers(record) {
    return { appName: record.appName, launchId: record.launchId, sessionName: record.sessionName };
}
export function buildElectronRefFreshnessNextActions(sessionName) {
    return [{
            id: "refresh-electron-refs-after-rerender",
            params: { args: sessionName ? ["--session", sessionName, "snapshot", "-i"] : ["snapshot", "-i"] },
            reason: "Electron UIs often rerender without changing URL; refresh refs before using old @e handles again.",
            safety: "Read-only snapshot; avoids stale same-URL refs after quick-pick, modal, theme, or editor rerenders.",
            tool: "agent_browser",
        }];
}
export function buildElectronRefFreshnessDiagnostic(options) {
    if (!options.record || !shouldInspectElectronPostCommandHealth(options.command))
        return undefined;
    if (getGuardedRefUsage(options.commandTokens, options.stdin).length === 0)
        return undefined;
    const nextActions = buildElectronRefFreshnessNextActions(options.sessionName);
    return {
        command: options.command,
        launchId: options.record.launchId,
        nextActionIds: nextActions.map((action) => action.id),
        sessionName: options.sessionName,
        summary: `Electron ref freshness: ${options.command ?? "mutation"} used page-scoped refs in an Electron UI. Re-run snapshot -i before reusing old @e refs, even if the URL did not change.`,
    };
}
export function formatElectronRefFreshnessText(diagnostic) {
    return diagnostic?.summary;
}
export { extractBatchResultCommand };
export function getPersistentSessionArtifactStore(ctx) {
    const sessionDir = typeof ctx.sessionManager.getSessionDir === "function" ? ctx.sessionManager.getSessionDir() : undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    return sessionDir && sessionId ? { sessionDir, sessionId } : undefined;
}
