import { rm } from "node:fs/promises";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { isBrowserIndependentRead, needsManagedSession } from "../../command-policy.js";
import { deleteIdentityKeysInNamespace, getAgentBrowserSessionIdentityKey, isAgentBrowserSessionIdentityKeyInNamespace } from "../../argv-grammar.js";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "../../batch-lifecycle.js";
import { isCloseAllCommand, isCloseCommand, isOpenNavigationCommand, isRecordPageTransitionCommand, isUnverifiedPageTransitionCommand, isWindowOrDiffPageTransitionCommand } from "../../command-taxonomy.js";
import { OPEN_RESULT_TAB_CORRECTION_FLAGS } from "../../launch-scoped-flags.js";
import { cleanupElectronLaunchResources, inspectElectronLaunchStatus } from "../../electron/cleanup.js";
import { getResultingPageTargetState, commandRequiresLivePageVerification } from "../../page-target-validation.js";
import { analyzeNetworkSourceLookupResults, analyzeSourceLookupResults, redactNetworkSourceLookupAnalysis } from "../../input-modes/lookups.js";
import { isAgentBrowserScriptSessionName } from "../../input-modes/script.js";
import { runAgentBrowserProcess, withChromeStartupArgs } from "../../process.js";
import { analyzeJobReceipts, analyzeQaPresetResults, analyzeQaPresetTimeout, buildQaCompactFailureText, buildQaCompactPassText, extractQaPageContext } from "../../input-modes/job.js";
import { applyNetworkRouteRecords, buildNetworkRouteDiagnostics } from "../../results/network-routes.js";
import { buildToolPresentation } from "../../results/presentation.js";
import { compactLargePresentationOutput } from "../../results/presentation/large-output.js";
import { extractEnvelopeErrorText, getAgentBrowserErrorText, parseAgentBrowserEnvelope } from "../../results/envelope.js";
import { detectConfirmationRequired } from "../../results/confirmation.js";
import { analyzeDebugPresetResults } from "../../input-modes/debug.js";
// local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7).
import { finalizeCheckpointRun } from "../../input-modes/checkpoint.js";
import { collectRevealedHeaderLines } from "../../results/presentation/diagnostics.js";
import { analyzeSettleResult } from "../../input-modes/settle.js";
import { extractNetworkBodies } from "../../input-modes/network-body.js";
import { omitUpstreamLifecycle } from "../../results/presentation/common.js";
import { getClipboardWritePayloadCandidates, redactClipboardPermissionEcho, redactClipboardPermissionErrorValue } from "../../results/presentation/errors.js";
import { shouldCaptureSemanticActionNavigationSummary } from "../../results/presentation/semantic-action.js";
import { buildPageTransitionRefSnapshotInvalidation, commandExplicitlyTargetsAboutBlank, getCommandRefSnapshotInvalidation, deriveSessionTabTarget, extractLatestRefSnapshotStateFromBatchResults, extractRefSnapshotFromData, extractSessionTabTargetFromBatchResults, extractSessionTabTargetFromCommandData, isAboutBlankSessionTabTarget, normalizeSessionTabTarget, } from "../../session-page-state.js";
import { isRecord } from "../../parsing.js";
import { buildReadConfirmationNextActions, nextReadConfirmation } from "../../read-confirmation.js";
import { pruneOwnedManagedSessionRestoreSnapshots } from "../../managed-session-restore.js";
import { isManagedSessionRestoreKey } from "../../managed-session-storage.js";
import { createFreshSessionName, extractUpstreamCommandTokens, redactSensitiveText, resolveManagedSessionState } from "../../runtime.js";
import { getUpstreamEffectiveBatchSteps } from "../batch-stdin.js";
import { closeManagedSession, inspectManagedSessionDaemon } from "./managed-session-daemon-policy.js";
import { applyOpenResultTabCorrection, buildAboutBlankRecoveryHint, buildAboutBlankWarning, buildElectronPostCommandHealthDiagnostic, buildElectronRefFreshnessDiagnostic, buildElectronSessionMismatch, buildManagedSessionOutcome, collectOpenResultTabCorrection, collectSessionTabSelection, commandChoosesSessionTabTarget, extractNavigationSummaryFromData, extractStringResultField, findElectronLaunchRecordForSession, formatElectronPostCommandHealthText, formatElectronSessionMismatchText, getSessionContextKey, getStaleRefArgs, mergeNavigationSummaryIntoData, shouldCaptureNavigationSummary, shouldCorrectSessionTabAfterCommand, shouldInspectElectronPostCommandHealth, updateTraceOwnerState, } from "./session-state.js";
import { collectClickDispatchDiagnostic } from "./click-dispatch.js";
import { collectGeolocationStubNote } from "./geolocation-stub.js";
import { buildScrollNoopDiagnostic, collectComboboxFocusDiagnostic, collectElectronBroadGetTextScopeDiagnostics, collectElectronHandoff, collectFillVerificationDiagnostic, collectNavigationSummary, collectOverlayBlockerDiagnostic, collectQaAttachedTarget, collectSnapshotOverlayBlockerDiagnostic, collectRecordingDependencyWarning, collectScrollPositionSnapshot, collectSelectorTextVisibilityDiagnostics, collectTimeoutPartialProgress, sleepMs, formatQaAttachedTargetText, getArtifactCleanupGuidance, getEvalResultWarning, getEvalStdinHint, getSourceLookupElectronContext, } from "./diagnostics.js";
import { repairScreenshotData } from "./prepare.js";
import { mergeRecordingRecoveryPresentation, recoverRecordingStop } from "./recording-recovery.js";
import { getPersistentSessionArtifactStore } from "./session-state.js";
import { buildFinalAgentBrowserToolResult, buildRedactedPresentationContent, buildWrapperRecoveryHint, prepareFinalResultRecoveryState, redactExactSensitiveValue, } from "./final-result.js";
import { computeRetryTimeoutMs, hasSettleRetryTimeBudget, SETTLE_RETRY_DELAY_MS, shouldRetrySettle } from "./settle-retry.js";
import { createDiagnosticsBufferState, describeDiagnosticsBuffer, partitionDiagnosticRows } from "../../session-diagnostics-buffer.js";
// local patch: reliable "since my last read" windows for console/errors/network reads (PATCHES.md P24).
// Upstream's `--clear` does not actually purge its buffers, so the wrapper remembers which rows it already
// reported per session and says how many are new. Rows are never dropped: the payload stays complete and the
// annotation only adds counts and indexes.
const diagnosticsBufferBySession = new Map();
function extractDiagnosticRows(command, data) {
    if (!data || typeof data !== "object") {
        return undefined;
    }
    if (command === "console") {
        return Array.isArray(data.messages) ? data.messages : (Array.isArray(data.logs) ? data.logs : (Array.isArray(data.entries) ? data.entries : undefined));
    }
    if (command === "errors") {
        return Array.isArray(data.errors) ? data.errors : (Array.isArray(data.messages) ? data.messages : undefined);
    }
    if (Array.isArray(data.requests))
        return data.requests;
    if (Array.isArray(data.items))
        return data.items;
    if (Array.isArray(data.entries))
        return data.entries;
    return undefined;
}
export function applyDiagnosticsBufferDedup({ command, data, result, sessionKey, jsonLane = false }) {
    try {
        const stream = command === "console" ? "console" : command === "errors" ? "errors" : command === "network" ? "network" : undefined;
        if (!stream || !result || !isRecord(result.details)) {
            return undefined;
        }
        const rows = extractDiagnosticRows(stream === "network" ? "network" : stream, data);
        if (!rows || rows.length === 0) {
            return undefined;
        }
        const key = sessionKey ?? `${stream}:default`;
        const previous = diagnosticsBufferBySession.get(key) ?? createDiagnosticsBufferState();
        const partition = partitionDiagnosticRows(previous, stream, rows);
        diagnosticsBufferBySession.set(key, partition.state);
        const newRowIndexes = [];
        let cursor = 0;
        for (const row of rows) {
            if (partition.newRows.includes(row)) {
                newRowIndexes.push(cursor);
            }
            cursor += 1;
        }
        const note = partition.seenCount > 0
            ? `${partition.seenCount} of ${rows.length} ${stream} row(s) were already reported earlier in this session (${partition.newCount} new). Upstream's clear does not purge its buffer, so treat repeats as the same events, not new ones.`
            : `${partition.newCount} new ${stream} row(s) since the previous read.`;
        const details = {
            ...result.details,
            diagnosticsBuffer: {
                newCount: partition.newCount,
                newRowIndexes,
                seenCount: partition.seenCount,
                stream,
                totalRows: rows.length,
                ...describeDiagnosticsBuffer(partition.state),
            },
        };
        // wave3 (JSON-lane parseability): when the caller requested --json and content[0].text parsed,
        // compose the dedup note into the wave3-H envelope contract instead of appending prose —
        // {"result": <payload>, "appended": [..., "<redacted note>"]} when an envelope already exists,
        // or a fresh envelope over a plain parsed payload. An unparseable JSON-lane payload keeps the
        // historical prose append (the pre-wave3 behavior). The note is wrapper-generated text
        // (counts + stream name only) but passes redactSensitiveText for envelope consistency.
        if (jsonLane && Array.isArray(result.content) && result.content[0]?.type === "text") {
            try {
                const parsed = JSON.parse(result.content[0].text);
                const redactedNote = redactSensitiveText(note);
                const envelope = isRecord(parsed) && Array.isArray(parsed.appended) && "result" in parsed
                    ? { ...parsed, appended: [...parsed.appended, redactedNote] }
                    : { result: parsed, appended: [redactedNote] };
                const jsonContent = [{ ...result.content[0], text: JSON.stringify(envelope, null, 2) }, ...result.content.slice(1)];
                return { ...result, content: jsonContent, details };
            }
            catch {
                // fall through to the prose append below
            }
        }
        const content = Array.isArray(result.content) && result.content[0]?.type === "text"
            ? [{ ...result.content[0], text: `${result.content[0].text}\n\n${note}` }, ...result.content.slice(1)]
            : [{ type: "text", text: note }, ...(result.content ?? [])];
        return { ...result, content, details };
    }
    catch {
        // A bookkeeping failure must never affect the browser result itself.
        return undefined;
    }
}
export function resetDiagnosticsBufferState() {
    diagnosticsBufferBySession.clear();
}
// local patch: count the rows an explicit revealSecrets request actually matched (PATCHES.md P13), so the
// warning can state a real number instead of a guess.
function countRevealedSecretRows(data, reveal) {
    const rows = [];
    for (const list of [data?.requests, data?.items, data?.entries, data?.result?.requests, data?.result?.items]) {
        if (Array.isArray(list))
            rows.push(...list);
    }
    if (Array.isArray(data))
        rows.push(...data.map((item) => item?.result ?? item));
    if (rows.length === 0 && (data?.url || data?.requestId))
        rows.push(data);
    const filter = reveal?.urlFilter;
    return rows.filter((row) => {
        const url = row?.url ?? row?.request?.url;
        return typeof url === "string" && (!filter || url.includes(filter));
    }).length;
}
async function repairScreenshotArtifact(options) {
    const { cwd, envelope, request } = options;
    if (!request || !envelope || !isRecord(envelope.data))
        return { envelope, request };
    const repaired = await repairScreenshotData({ cwd, data: envelope.data, request });
    return { envelope: { ...envelope, data: repaired.data }, request: repaired.request };
}
async function repairBatchScreenshotArtifacts(options) {
    const { cwd, envelope, requests } = options;
    if (!envelope || !Array.isArray(envelope.data) || !requests?.some((request) => request !== undefined))
        return { envelope, requests };
    const repairedRequests = [];
    const repairedData = await Promise.all(envelope.data.map(async (item, index) => {
        const request = requests[index];
        if (!request || !isRecord(item) || !isRecord(item.result))
            return item;
        const repaired = await repairScreenshotData({ cwd, data: item.result, request });
        repairedRequests[index] = repaired.request;
        return { ...item, result: repaired.data };
    }));
    return { envelope: { ...envelope, data: repairedData }, requests: repairedRequests };
}
function getEnvelopeErrorString(envelope) {
    if (!envelope?.error)
        return undefined;
    if (typeof envelope.error === "string")
        return envelope.error;
    if (isRecord(envelope.error) && typeof envelope.error.message === "string")
        return envelope.error.message;
    return String(envelope.error);
}
function isStreamEnableAlreadyEnabledNoop(options) {
    if (!options.processSucceeded || options.command !== "stream" || options.subcommand !== "enable" || options.envelope?.success !== false)
        return false;
    const message = (getEnvelopeErrorString(options.envelope) ?? "").trim().replace(/[.!]+$/, "").toLowerCase();
    return message === "streaming is already enabled for this session" || message === "streaming is already enabled" || message === "stream already enabled";
}
function isPendingWebMcpMutation(command, subcommand, data) {
    return command === "webmcp"
        && ["invoke", "result"].includes(subcommand ?? "")
        && isRecord(data)
        && data.status === "pending";
}
function isWebMcpSettlementCommand(command, subcommand) {
    return command === "webmcp" && ["result", "cancel"].includes(subcommand ?? "");
}
function batchHasPendingWebMcpMutation(data) {
    if (!Array.isArray(data))
        return false;
    return data.some((row) => {
        if (!isRecord(row) || row.success === false || !Array.isArray(row.command) || !row.command.every((token) => typeof token === "string"))
            return false;
        const [command, subcommand] = extractUpstreamCommandTokens(row.command);
        return isPendingWebMcpMutation(command, subcommand, row.result);
    });
}
function batchHasFailedWebMcpSettlement(data) {
    if (!Array.isArray(data))
        return false;
    return data.some((row) => {
        if (!isRecord(row) || row.success !== false || !Array.isArray(row.command) || !row.command.every((token) => typeof token === "string"))
            return false;
        const [command, subcommand] = extractUpstreamCommandTokens(row.command);
        return isWebMcpSettlementCommand(command, subcommand);
    });
}
function batchStartedManagedBrowser(data) {
    if (!Array.isArray(data))
        return false;
    return data.some((entry) => {
        if (!isRecord(entry) || entry.success !== true || !Array.isArray(entry.command))
            return false;
        const command = typeof entry.command[0] === "string" ? entry.command[0] : undefined;
        return command === "connect" || command === "goto" || command === "navigate" || isOpenNavigationCommand(command);
    });
}
function withoutNamespaceEntries(entries, namespace) {
    return new Map([...entries].filter(([key]) => !isAgentBrowserSessionIdentityKeyInNamespace(key, namespace)));
}
function setNetworkRouteState(options) {
    if (!options.sessionName)
        return options.routesBySession;
    const previousRoutes = options.routesBySession.get(options.sessionName);
    if (options.routes === previousRoutes)
        return options.routesBySession;
    const next = new Map(options.routesBySession);
    if (options.routes && options.routes.length > 0)
        next.set(options.sessionName, options.routes);
    else
        next.delete(options.sessionName);
    return next;
}
function applyNetworkRouteState(options) {
    const routes = options.sessionName ? applyNetworkRouteRecords(options.routesBySession.get(options.sessionName), options.commandTokens, options.succeeded) : undefined;
    return setNetworkRouteState({ routes, routesBySession: options.routesBySession, sessionName: options.sessionName });
}
function applyBatchNetworkRouteState(options) {
    if (!options.succeeded || !options.sessionName || !Array.isArray(options.data))
        return options.routesBySession;
    let routes = options.routesBySession.get(options.sessionName);
    for (const item of options.data) {
        if (!isRecord(item) || !Array.isArray(item.command) || !item.command.every((token) => typeof token === "string"))
            continue;
        const commandTokens = extractUpstreamCommandTokens(item.command);
        const stepSucceeded = item.success !== false;
        if (stepSucceeded && isCloseCommand(commandTokens[0]))
            routes = undefined;
        else
            routes = applyNetworkRouteRecords(routes, commandTokens, stepSucceeded);
    }
    return setNetworkRouteState({ routes, routesBySession: options.routesBySession, sessionName: options.sessionName });
}
export async function processBrowserOutput(input) {
    const { ctx, cwd, electronPostCommandStatusSettleMs, implicitSessionCloseTimeoutMs, sessionPageStateUpdate, signal, state } = input;
    const { prepared, processResult } = input;
    const { electronChildProcesses, electronLaunchRecords, sessionPageState, traceOwners } = state;
    let artifactManifest = state.artifactManifest;
    let freshSessionOrdinal = state.freshSessionOrdinal;
    let managedSessionActive = state.managedSessionActive;
    let managedSessionCompatibilityWorkaround = state.managedSessionCompatibilityWorkaround;
    let managedSessionHeadedAutosaveDisabled = state.managedSessionHeadedAutosaveDisabled === true;
    let managedSessionHeadedAutosaveInterval = state.managedSessionHeadedAutosaveInterval;
    let managedSessionCwd = state.managedSessionCwd;
    let managedSessionName = state.managedSessionName;
    let managedSessionNamespace = state.managedSessionNamespace;
    let networkRoutesBySession = state.networkRoutesBySession;
    try {
        const persistentArtifactStore = getPersistentSessionArtifactStore(ctx);
        // Native upgrade prints text even with --json; all other command shapes keep strict JSON parsing.
        const plainTextUpgrade = !prepared.executionPlan.plainTextInspection && prepared.executionPlan.commandInfo.command === "upgrade" && !needsManagedSession(parseArgvDescriptor(prepared.runtimeToolArgs));
        const parsed = await parseAgentBrowserEnvelope({ stdout: processResult.stdout, stdoutPath: processResult.stdoutSpillPath, plainText: plainTextUpgrade });
        let parseError = parsed.parseError;
        const recordingStopRecovery = await recoverRecordingStop({
            artifactManifest, artifactRunStartedAtMs: input.artifactRunStartedAtMs, commandTokens: prepared.commandTokens, cwd,
            envelope: parsed.envelope, namespace: prepared.executionPlan.namespace, parseError, processResult,
            reservation: prepared.executionPlan.sessionName ? state.activeRecordingReservations?.get(getAgentBrowserSessionIdentityKey(prepared.executionPlan.sessionName, prepared.executionPlan.namespace)) : undefined,
            sessionName: prepared.executionPlan.sessionName, signal, stdin: prepared.runtimeToolStdin,
        });
        let presentationEnvelope = recordingStopRecovery?.envelope ?? parsed.envelope;
        let navigationSummary = undefined;
        let failedTransitionReverification = false;
        const repairedScreenshot = await repairScreenshotArtifact({ cwd, envelope: presentationEnvelope, request: prepared.preparedArgs.screenshotPathRequest });
        presentationEnvelope = repairedScreenshot.envelope;
        const repairedBatchScreenshots = await repairBatchScreenshotArtifacts({ cwd, envelope: presentationEnvelope, requests: prepared.preparedArgs.batchScreenshotPathRequests });
        presentationEnvelope = repairedBatchScreenshots.envelope;
        const screenshotArtifactRequest = repairedScreenshot.request;
        const batchScreenshotArtifactRequests = repairedBatchScreenshots.requests;
        const batchCommandSteps = prepared.executionPlan.commandInfo.command === "batch"
            ? getUpstreamEffectiveBatchSteps(prepared.commandTokens, prepared.runtimeToolStdin)
            : [];
        const dispatchedCommands = prepared.executionPlan.commandInfo.command !== "batch"
            ? [prepared.commandTokens]
            : Array.isArray(presentationEnvelope?.data)
                ? presentationEnvelope.data.flatMap((row, index) => isRecord(row) ? [Array.isArray(row.command) && row.command.every((token) => typeof token === "string") ? row.command : batchCommandSteps[index] ?? []] : [])
                : batchCommandSteps;
        const confirmationSessionName = prepared.executionPlan.sessionName ?? "default";
        let readConfirmation = state.sessionPageState.getReadConfirmation(getAgentBrowserSessionIdentityKey(confirmationSessionName, prepared.executionPlan.namespace));
        let readConfirmationEvent;
        const confirmationRows = prepared.executionPlan.commandInfo.command === "batch" && Array.isArray(presentationEnvelope?.data)
            ? presentationEnvelope.data.flatMap((row, index) => isRecord(row) ? [{ tokens: batchCommandSteps[index] ?? [], data: row.result, response: row, succeeded: row.success === true }] : [])
            : [{ tokens: prepared.commandTokens, data: presentationEnvelope?.data, response: presentationEnvelope, succeeded: presentationEnvelope?.success === true }];
        for (const row of confirmationRows) {
            const transition = nextReadConfirmation({ commandTokens: row.tokens, current: readConfirmation, data: row.data, namespace: prepared.executionPlan.namespace, sessionName: confirmationSessionName, succeeded: row.succeeded });
            if (transition) {
                readConfirmationEvent = transition;
                readConfirmation = transition;
            }
            if (row.tokens.length === 2 && row.tokens[0] === "confirm" && isRecord(row.data) && row.data.confirmed === true && row.data.action === "read" && isRecord(row.data.result) && row.data.result.success === false && row.response) {
                row.response.success = false;
                row.response.error = row.data.result.error;
                if (presentationEnvelope)
                    presentationEnvelope.success = false;
            }
        }
        const destinationTransition = dispatchedCommands.some((step) => {
            const [command, subcommand] = extractUpstreamCommandTokens(step);
            return isWindowOrDiffPageTransitionCommand(command, subcommand);
        });
        const nestedBatchClose = prepared.executionPlan.commandInfo.command === "batch"
            ? getSuccessfulBatchCloseLifecycle(presentationEnvelope?.data, batchCommandSteps)
            : undefined;
        const nestedBatchClosed = nestedBatchClose?.endsClosed === true;
        const nestedBatchRemainsActive = nestedBatchClose?.endsClosed === false;
        const nestedBatchClosesAll = prepared.executionPlan.commandInfo.command === "batch"
            && batchHasSuccessfulCloseAll(presentationEnvelope?.data, batchCommandSteps);
        const directCloseAllRequested = isCloseAllCommand(extractUpstreamCommandTokens(prepared.commandTokens));
        const rawCloseStatePath = isCloseCommand(prepared.executionPlan.commandInfo.command)
            && isRecord(presentationEnvelope?.data)
            && typeof presentationEnvelope.data.statePath === "string"
            ? presentationEnvelope.data.statePath
            : nestedBatchClose?.statePath;
        if (presentationEnvelope && prepared.exactSensitiveValues.length > 0)
            presentationEnvelope = redactExactSensitiveValue(presentationEnvelope, prepared.exactSensitiveValues);
        const parseFailureOutput = parseError && processResult.stdoutSpillPath
            ? { fullOutputUnavailable: "Malformed upstream output was discarded because it may contain sensitive browser data." }
            : {};
        const browserIndependentRead = prepared.readConfirmation !== undefined || isBrowserIndependentRead(prepared.commandTokens, prepared.runtimeToolStdin);
        const processSucceeded = !processResult.timedOut && !processResult.aborted && !processResult.spawnError && processResult.exitCode === 0;
        const plainTextInspection = prepared.executionPlan.plainTextInspection && processSucceeded;
        const parseSucceeded = plainTextInspection || parseError === undefined;
        if (isStreamEnableAlreadyEnabledNoop({ command: prepared.executionPlan.commandInfo.command, envelope: presentationEnvelope, processSucceeded, subcommand: prepared.executionPlan.commandInfo.subcommand })) {
            presentationEnvelope = { success: true, data: { alreadyEnabled: true, enabled: true, message: getEnvelopeErrorString(presentationEnvelope) ?? "Stream already enabled" } };
        }
        const envelopeSuccess = plainTextInspection ? true : presentationEnvelope?.success !== false;
        let succeeded = (processSucceeded && parseSucceeded && envelopeSuccess) || recordingStopRecovery?.recovery.healed === true;
        const inspectionText = plainTextInspection ? processResult.stdout.trim() : undefined;
        const sessionStateKey = getSessionContextKey(prepared.executionPlan.sessionName, prepared.executionPlan.namespace);
        const closeAllApplied = nestedBatchClosesAll || (directCloseAllRequested && succeeded);
        if (sessionStateKey && processResult.agentBrowserStarted && sessionPageState.get(sessionStateKey).tabReopenPending === true) {
            if (dispatchedCommands.some(commandChoosesSessionTabTarget))
                sessionPageState.setTabReopenPending({ pending: false, sessionName: sessionStateKey, update: sessionPageStateUpdate });
        }
        if (closeAllApplied) {
            networkRoutesBySession = withoutNamespaceEntries(networkRoutesBySession, prepared.executionPlan.namespace);
            deleteIdentityKeysInNamespace(state.attachedSessionKeys, prepared.executionPlan.namespace);
            deleteIdentityKeysInNamespace(traceOwners, prepared.executionPlan.namespace);
            sessionPageState.clearNamespace(prepared.executionPlan.namespace);
            const retainedSessionKey = nestedBatchRemainsActive ? sessionStateKey : undefined;
            for (const [key, owner] of state.ownedManagedSessions) {
                if (!isAgentBrowserSessionIdentityKeyInNamespace(key, prepared.executionPlan.namespace) || key === retainedSessionKey)
                    continue;
                state.closedManagedSessionNames.add(key);
                state.managedSessionRestoreState.clear(owner.sessionName, owner.namespace);
            }
        }
        else if (nestedBatchClose && sessionStateKey) {
            networkRoutesBySession = new Map(networkRoutesBySession);
            networkRoutesBySession.delete(sessionStateKey);
            sessionPageState.clearSession(sessionStateKey);
        }
        if (prepared.executionPlan.commandInfo.command === "batch" && Array.isArray(presentationEnvelope?.data)) {
            for (const [index, row] of presentationEnvelope.data.entries()) {
                if (!isRecord(row))
                    continue;
                const rowCommand = Array.isArray(row.command) && row.command.every((token) => typeof token === "string")
                    ? row.command
                    : batchCommandSteps[index];
                if (!rowCommand)
                    continue;
                const [command, subcommand] = extractUpstreamCommandTokens(rowCommand);
                updateTraceOwnerState({ command, sessionName: sessionStateKey, subcommand, succeeded: row.success === true, traceOwners });
            }
        }
        else {
            updateTraceOwnerState({ command: prepared.executionPlan.commandInfo.command, sessionName: sessionStateKey, subcommand: prepared.executionPlan.commandInfo.subcommand, succeeded, traceOwners });
        }
        let clickDispatchDiagnostic;
        if (succeeded && prepared.clickDispatchProbe) {
            clickDispatchDiagnostic = await collectClickDispatchDiagnostic({ cwd, namespace: prepared.executionPlan.namespace, probe: prepared.clickDispatchProbe, sessionName: prepared.executionPlan.sessionName, signal });
            if (clickDispatchDiagnostic) {
                succeeded = false;
                presentationEnvelope = { ...(presentationEnvelope ?? {}), error: clickDispatchDiagnostic.summary, success: false };
            }
        }
        const tabTransition = prepared.executionPlan.commandInfo.command === "tab" && prepared.executionPlan.commandInfo.subcommand !== undefined && !["list", "new"].includes(prepared.executionPlan.commandInfo.subcommand);
        // Non-page rows (including a failed prefix) cannot retire a cold target for a navigation that never ran.
        const resultingPageState = sessionPageState.get(sessionStateKey).tabReopenPending === true
            ? { currentPageUrl: prepared.priorSessionTabTarget?.url, pageTargetMayHaveChanged: false, pageUrlUnknown: prepared.priorSessionTabTargetUnknown === true }
            : getResultingPageTargetState({
                args: prepared.executionPlan.effectiveArgs,
                executedBatchSteps: dispatchedCommands,
                currentPageUrl: prepared.priorSessionTabTarget?.url,
                pageUrlUnknown: prepared.priorSessionTabTargetUnknown === true,
            });
        if (succeeded &&
            (shouldCaptureNavigationSummary(prepared.executionPlan.commandInfo.command, presentationEnvelope?.data, prepared.executionPlan.commandInfo.subcommand) ||
                shouldCaptureSemanticActionNavigationSummary(prepared.compiledSemanticAction, presentationEnvelope?.data) ||
                commandRequiresLivePageVerification(prepared.executionPlan.effectiveArgs, prepared.runtimeToolStdin) ||
                (destinationTransition && !nestedBatchClosed) || tabTransition)) {
            navigationSummary = await collectNavigationSummary({ cwd, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, reusePriorTitle: !tabTransition, sessionName: prepared.executionPlan.sessionName, signal });
        }
        // Failed transitions may already have changed the page; keep only a live observed URL.
        if (succeeded === false &&
            processResult.agentBrowserStarted &&
            !processResult.aborted &&
            !processResult.timedOut &&
            !nestedBatchClosed &&
            (destinationTransition || (prepared.executionPlan.commandInfo.command !== "batch" &&
                isUnverifiedPageTransitionCommand(prepared.executionPlan.commandInfo.command, prepared.executionPlan.commandInfo.subcommand)))) {
            navigationSummary = await collectNavigationSummary({ cwd, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName, signal });
            // Re-verifying a failed transition's URL does not make its prior refs valid.
            failedTransitionReverification = navigationSummary !== undefined;
        }
        if (navigationSummary && presentationEnvelope && prepared.executionPlan.commandInfo.command !== "eval" && !Array.isArray(presentationEnvelope.data))
            presentationEnvelope = { ...presentationEnvelope, data: mergeNavigationSummaryIntoData(presentationEnvelope.data, navigationSummary) };
        let overlayBlockerDiagnostic;
        let openResultTabCorrection;
        if (succeeded && prepared.executionPlan.sessionName && prepared.executionPlan.startupScopedFlags.some((flag) => OPEN_RESULT_TAB_CORRECTION_FLAGS.has(flag)) && isOpenNavigationCommand(prepared.executionPlan.commandInfo.command) && !commandExplicitlyTargetsAboutBlank(prepared.commandTokens)) {
            const targetTitle = extractStringResultField(presentationEnvelope?.data, "title");
            const targetUrl = extractStringResultField(presentationEnvelope?.data, "url");
            const plannedTabCorrection = await collectOpenResultTabCorrection({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal, targetTitle, targetUrl });
            if (plannedTabCorrection)
                openResultTabCorrection = await applyOpenResultTabCorrection({ correction: plannedTabCorrection, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal });
        }
        const verifiesCurrentUrl = prepared.executionPlan.commandInfo.command === "get" && prepared.executionPlan.commandInfo.subcommand === "url";
        const trustsReportedPageTarget = !resultingPageState.pageUrlUnknown || verifiesCurrentUrl;
        const pendingWebMcpMutation = isPendingWebMcpMutation(prepared.executionPlan.commandInfo.command, prepared.executionPlan.commandInfo.subcommand, presentationEnvelope?.data) || (prepared.executionPlan.commandInfo.command === "batch" && batchHasPendingWebMcpMutation(presentationEnvelope?.data));
        const failedWebMcpSettlement = prepared.priorSessionTabTargetUnknown === true && ((!succeeded && isWebMcpSettlementCommand(prepared.executionPlan.commandInfo.command, prepared.executionPlan.commandInfo.subcommand))
            || (prepared.executionPlan.commandInfo.command === "batch" && batchHasFailedWebMcpSettlement(presentationEnvelope?.data)));
        const unsettledWebMcpMutation = pendingWebMcpMutation || failedWebMcpSettlement;
        const observedSessionTabTarget = unsettledWebMcpMutation
            ? undefined
            : normalizeSessionTabTarget(navigationSummary)
                ?? (trustsReportedPageTarget ? extractSessionTabTargetFromBatchResults(presentationEnvelope?.data) : undefined)
                ?? (succeeded && trustsReportedPageTarget ? extractSessionTabTargetFromCommandData(prepared.commandTokens, presentationEnvelope?.data) : undefined);
        const safeObservedSessionTabTarget = observedSessionTabTarget;
        let currentSessionTabTarget = safeObservedSessionTabTarget;
        if (!currentSessionTabTarget && nestedBatchClose === undefined) {
            // Window/diff responses do not report the final URL; URL2 is intent, not redirect evidence.
            currentSessionTabTarget = resultingPageState.pageTargetMayHaveChanged
                ? succeeded && !destinationTransition ? normalizeSessionTabTarget({ url: resultingPageState.currentPageUrl }) : undefined
                : deriveSessionTabTarget({ command: prepared.executionPlan.commandInfo.command, data: presentationEnvelope?.data, navigationSummary, previousTarget: prepared.priorSessionTabTarget, subcommand: prepared.executionPlan.commandInfo.subcommand });
        }
        let aboutBlankSessionMismatch;
        let electronPostCommandHealth;
        let electronRefFreshnessDiagnostic;
        let electronSessionMismatch;
        let electronStatusAfterCommand;
        const explicitlyTargetsAboutBlank = dispatchedCommands.some((step) => commandExplicitlyTargetsAboutBlank(extractUpstreamCommandTokens(step)));
        const shouldTreatAboutBlankAsMismatch = succeeded && !tabTransition && !destinationTransition && !explicitlyTargetsAboutBlank && nestedBatchClose === undefined && prepared.priorSessionTabTarget !== undefined && !isAboutBlankSessionTabTarget(prepared.priorSessionTabTarget) && isAboutBlankSessionTabTarget(observedSessionTabTarget ?? currentSessionTabTarget);
        let sessionTabCorrection = prepared.sessionTabCorrection;
        if (shouldTreatAboutBlankAsMismatch && prepared.priorSessionTabTarget) {
            const aboutBlankObservedTarget = observedSessionTabTarget ?? currentSessionTabTarget;
            const aboutBlankRecovery = await collectSessionTabSelection({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal, target: prepared.priorSessionTabTarget });
            const appliedAboutBlankRecovery = aboutBlankRecovery ? await applyOpenResultTabCorrection({ correction: aboutBlankRecovery, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal }) : undefined;
            if (appliedAboutBlankRecovery) {
                sessionTabCorrection = appliedAboutBlankRecovery;
                currentSessionTabTarget = prepared.priorSessionTabTarget;
            }
            else
                currentSessionTabTarget = aboutBlankObservedTarget ?? normalizeSessionTabTarget({ url: "about:blank" });
            aboutBlankSessionMismatch = { activeUrl: "about:blank", recoveryApplied: appliedAboutBlankRecovery !== undefined, recoveryHint: buildAboutBlankRecoveryHint(), targetTitle: prepared.priorSessionTabTarget.title, targetUrl: prepared.priorSessionTabTarget.url };
            const electronRecord = findElectronLaunchRecordForSession(prepared.executionPlan.sessionName, electronLaunchRecords, prepared.executionPlan.namespace);
            if (electronRecord && prepared.executionPlan.sessionName) {
                electronStatusAfterCommand = await inspectElectronLaunchStatus(electronRecord);
                electronSessionMismatch = buildElectronSessionMismatch({ managedSession: { sessionName: prepared.executionPlan.sessionName, title: aboutBlankObservedTarget?.title, url: aboutBlankObservedTarget?.url ?? "about:blank" }, record: electronRecord, statusTargets: electronStatusAfterCommand.targets });
            }
        }
        if (succeeded && prepared.priorSessionTabTarget && !sessionTabCorrection && !aboutBlankSessionMismatch && !commandExplicitlyTargetsAboutBlank(prepared.commandTokens) && observedSessionTabTarget && shouldCorrectSessionTabAfterCommand({ command: prepared.executionPlan.commandInfo.command, pinningRequired: prepared.sessionTabPinningReason !== undefined, sessionName: prepared.executionPlan.sessionName })) {
            const postCommandTabCorrection = await collectSessionTabSelection({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal, target: observedSessionTabTarget });
            if (postCommandTabCorrection) {
                const appliedPostCommandCorrection = await applyOpenResultTabCorrection({ correction: postCommandTabCorrection, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal });
                if (appliedPostCommandCorrection && !sessionTabCorrection)
                    sessionTabCorrection = appliedPostCommandCorrection;
            }
        }
        const electronRecordForCommand = findElectronLaunchRecordForSession(prepared.executionPlan.sessionName, electronLaunchRecords, prepared.executionPlan.namespace);
        if (succeeded && electronRecordForCommand && shouldInspectElectronPostCommandHealth(prepared.executionPlan.commandInfo.command)) {
            electronStatusAfterCommand ??= await inspectElectronLaunchStatus(electronRecordForCommand);
            electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({ command: prepared.executionPlan.commandInfo.command, record: electronRecordForCommand, status: electronStatusAfterCommand, target: observedSessionTabTarget ?? currentSessionTabTarget });
            if (electronPostCommandHealth && electronPostCommandHealth.reason !== "process-dead") {
                await sleepMs(electronPostCommandStatusSettleMs);
                electronStatusAfterCommand = await inspectElectronLaunchStatus(electronRecordForCommand);
                electronPostCommandHealth = buildElectronPostCommandHealthDiagnostic({ command: prepared.executionPlan.commandInfo.command, record: electronRecordForCommand, status: electronStatusAfterCommand, target: observedSessionTabTarget ?? currentSessionTabTarget });
            }
            if (electronPostCommandHealth)
                succeeded = false;
        }
        let fillVerificationDiagnostic;
        let selectorTextVisibilityDiagnostics = [];
        let electronBroadGetTextScopeDiagnostics = [];
        const timeoutPartialProgress = processResult.timedOut && !recordingStopRecovery && !prepared.readConfirmation ? await collectTimeoutPartialProgress({ commandTokens: prepared.commandTokens, compiledJob: prepared.compiledJob, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, stdin: prepared.runtimeToolStdin }) : undefined;
        if (!currentSessionTabTarget && timeoutPartialProgress?.currentPage?.source === "live") {
            currentSessionTabTarget = normalizeSessionTabTarget(timeoutPartialProgress.currentPage);
        }
        if (succeeded) {
            const fillRefSnapshot = prepared.resolvedSemanticActionRefSnapshot ?? prepared.priorRefSnapshotState;
            fillVerificationDiagnostic = await collectFillVerificationDiagnostic({ commandTokens: prepared.commandTokens, cwd, forceValueVerification: electronRecordForCommand !== undefined, namespace: prepared.executionPlan.namespace, refSnapshot: fillRefSnapshot, sessionName: prepared.executionPlan.sessionName, signal });
        }
        if (succeeded && electronRecordForCommand) {
            electronRefFreshnessDiagnostic = buildElectronRefFreshnessDiagnostic({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, record: electronRecordForCommand, sessionName: prepared.executionPlan.sessionName, stdin: prepared.runtimeToolStdin });
        }
        if (succeeded && prepared.executionPlan.commandInfo.command === "snapshot") {
            overlayBlockerDiagnostic = collectSnapshotOverlayBlockerDiagnostic(presentationEnvelope?.data);
        }
        if (succeeded && !overlayBlockerDiagnostic && !sessionTabCorrection && !aboutBlankSessionMismatch && !electronRecordForCommand && !clickDispatchDiagnostic)
            overlayBlockerDiagnostic = await collectOverlayBlockerDiagnostic({ command: prepared.executionPlan.commandInfo.command, cwd, data: presentationEnvelope?.data, namespace: prepared.executionPlan.namespace, navigationSummary, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName, signal });
        if (succeeded) {
            selectorTextVisibilityDiagnostics = await collectSelectorTextVisibilityDiagnostics({ commandInfo: prepared.executionPlan.commandInfo, commandTokens: prepared.commandTokens, cwd, data: presentationEnvelope?.data, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal });
            if (electronRecordForCommand)
                electronBroadGetTextScopeDiagnostics = collectElectronBroadGetTextScopeDiagnostics({ commandInfo: prepared.executionPlan.commandInfo, commandTokens: prepared.commandTokens, currentTarget: currentSessionTabTarget, data: presentationEnvelope?.data, electronLaunchRecords, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName });
        }
        const activeNetworkRoutes = sessionStateKey ? networkRoutesBySession.get(sessionStateKey) : undefined;
        const networkRouteDiagnostics = succeeded && prepared.executionPlan.commandInfo.command === "network" && prepared.executionPlan.commandInfo.subcommand === "requests" && prepared.executionPlan.sessionName
            ? buildNetworkRouteDiagnostics(presentationEnvelope?.data, activeNetworkRoutes)
            : undefined;
        networkRoutesBySession = applyNetworkRouteState({ commandTokens: prepared.commandTokens, routesBySession: networkRoutesBySession, sessionName: sessionStateKey, succeeded });
        const comboboxFocusDiagnostic = succeeded ? await collectComboboxFocusDiagnostic({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, cwd, namespace: prepared.executionPlan.namespace, semanticAction: prepared.compiledSemanticAction, sessionName: prepared.executionPlan.sessionName, signal }) : undefined;
        const recordingDependencyWarning = await collectRecordingDependencyWarning({ command: prepared.executionPlan.commandInfo.command, commandTokens: prepared.commandTokens, succeeded });
        const geolocationStubNote = succeeded
            ? await collectGeolocationStubNote({ commandTokens: prepared.commandTokens, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal })
            : undefined;
        const scrollNoopDiagnostic = succeeded && prepared.shouldProbeScrollNoop ? buildScrollNoopDiagnostic(prepared.scrollPositionBefore, await collectScrollPositionSnapshot({ cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal })) : undefined;
        const batchRefSnapshotState = prepared.executionPlan.commandInfo.command === "batch" ? extractLatestRefSnapshotStateFromBatchResults(presentationEnvelope?.data) : undefined;
        let currentRefSnapshot;
        let currentRefSnapshotInvalidation;
        if (sessionStateKey && !browserIndependentRead) {
            const sessionClosed = (isCloseCommand(prepared.executionPlan.commandInfo.command) && succeeded) || nestedBatchClosed;
            if (sessionClosed) {
                state.attachedSessionKeys.delete(sessionStateKey);
                networkRoutesBySession = new Map(networkRoutesBySession);
                networkRoutesBySession.delete(sessionStateKey);
                sessionPageState.clearSession(sessionStateKey);
                state.closedManagedSessionNames.add(sessionStateKey);
            }
            else {
                // A batch that times out or returns unparseable output yields no result rows, but the daemon
                // may already have executed a recording swap or page-provided WebMCP tool; fall back to the
                // planned steps then. This can over-invalidate by one snapshot, but never under-invalidates.
                const directTransitionInvalidation = getCommandRefSnapshotInvalidation(prepared.commandTokens);
                const plannedBatchTransitionInvalidation = !Array.isArray(presentationEnvelope?.data)
                    ? batchCommandSteps.map(getCommandRefSnapshotInvalidation).find((invalidation) => invalidation !== undefined)
                    : undefined;
                const pageTransitionInvalidation = unsettledWebMcpMutation
                    ? buildPageTransitionRefSnapshotInvalidation("A detached WebMCP invocation is still pending or failed to settle and can mutate, rerender, or navigate the page, so prior snapshot refs remain invalid after URL verification. Run webmcp result or cancel, then take a fresh snapshot before using page-scoped refs.")
                    : processResult.agentBrowserStarted && (directTransitionInvalidation || plannedBatchTransitionInvalidation)
                        ? directTransitionInvalidation ?? plannedBatchTransitionInvalidation
                        : failedTransitionReverification
                            ? buildPageTransitionRefSnapshotInvalidation("A failed eval/back/forward/reload/connect/state-load/tab command may still have changed the page, so the prior snapshot refs were invalidated. Run snapshot -i before using page-scoped refs.")
                            : batchRefSnapshotState?.invalidation?.reason === "page-transition"
                                ? batchRefSnapshotState.invalidation
                                : undefined;
                if (currentSessionTabTarget) {
                    const tabUpdate = sessionPageState.applyTabTarget({ sessionName: sessionStateKey, target: currentSessionTabTarget, update: sessionPageStateUpdate });
                    if (!tabUpdate.applied && succeeded)
                        sessionPageState.markPinning(sessionStateKey, "drift");
                }
                else if (processResult.agentBrowserStarted && (resultingPageState.pageUrlUnknown || resultingPageState.pageTargetMayHaveChanged) && !(prepared.commandTokens[0] === "session" && prepared.commandTokens[1] === "info")) {
                    sessionPageState.markTabTargetUnknown({ sessionName: sessionStateKey, update: sessionPageStateUpdate });
                }
                const refSnapshot = unsettledWebMcpMutation
                    ? undefined
                    : prepared.executionPlan.commandInfo.command === "batch"
                        ? batchRefSnapshotState?.snapshot
                        : succeeded
                            ? prepared.executionPlan.commandInfo.command === "snapshot" ? extractRefSnapshotFromData(presentationEnvelope?.data) : prepared.resolvedSemanticActionRefSnapshot ?? overlayBlockerDiagnostic?.snapshot
                            : undefined;
                if (refSnapshot) {
                    const refUpdate = sessionPageState.applyRefSnapshot({ fallbackTarget: currentSessionTabTarget, sessionName: sessionStateKey, snapshot: refSnapshot, update: sessionPageStateUpdate });
                    currentRefSnapshot = refUpdate.refSnapshot;
                    currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
                }
                else if (pageTransitionInvalidation) {
                    const refUpdate = sessionPageState.applyRefSnapshotInvalidation({ invalidation: pageTransitionInvalidation, sessionName: sessionStateKey, update: sessionPageStateUpdate });
                    currentRefSnapshot = refUpdate.refSnapshot;
                    currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
                }
                else {
                    const stateView = sessionPageState.get(sessionStateKey);
                    currentRefSnapshot = stateView.refSnapshot;
                    currentRefSnapshotInvalidation = stateView.refSnapshotInvalidation;
                }
            }
        }
        const priorManagedSessionActive = managedSessionActive;
        const priorManagedSessionCwd = managedSessionCwd;
        const priorManagedSessionHeadedAutosaveInterval = managedSessionHeadedAutosaveInterval;
        const priorManagedSessionName = managedSessionName;
        const priorManagedSessionNamespace = managedSessionNamespace;
        const priorManagedSessionKey = getSessionContextKey(priorManagedSessionName, priorManagedSessionNamespace) ?? priorManagedSessionName;
        const closeAllTargetsPriorManagedSession = closeAllApplied
            && priorManagedSessionActive
            && isAgentBrowserSessionIdentityKeyInNamespace(priorManagedSessionKey, prepared.executionPlan.namespace);
        const closeAllRetainsPriorManagedSession = closeAllTargetsPriorManagedSession
            && nestedBatchRemainsActive
            && sessionStateKey === priorManagedSessionKey;
        const closeAllClosesPriorManagedSession = closeAllTargetsPriorManagedSession && !closeAllRetainsPriorManagedSession;
        const commandClosesSession = isCloseCommand(prepared.executionPlan.commandInfo.command) || nestedBatchClosed || closeAllClosesPriorManagedSession;
        const closeCommandSucceeded = (isCloseCommand(prepared.executionPlan.commandInfo.command) && succeeded) || nestedBatchClosed || closeAllClosesPriorManagedSession;
        const closeTargetsPriorManagedNamespace = prepared.executionPlan.namespace === priorManagedSessionNamespace;
        const managedCloseSessionName = closeAllClosesPriorManagedSession
            ? priorManagedSessionName
            : closeCommandSucceeded && prepared.executionPlan.sessionName === priorManagedSessionName && closeTargetsPriorManagedNamespace
                ? prepared.executionPlan.sessionName
                : prepared.executionPlan.managedSessionName;
        const postLaunchBatchFailure = !succeeded && processSucceeded && parseSucceeded && prepared.sessionMode === "fresh" && prepared.executionPlan.commandInfo.command === "batch" && batchStartedManagedBrowser(presentationEnvelope?.data);
        const postLaunchTimeoutWithPage = !succeeded && processResult.timedOut && prepared.sessionMode === "fresh" && prepared.executionPlan.commandInfo.command === "batch" && timeoutPartialProgress?.liveUrlRecovered === true;
        const failedFreshSessionMayHaveStarted = !succeeded
            && (processResult.agentBrowserStarted || (!processResult.aborted && processResult.spawnError === undefined))
            && prepared.sessionMode === "fresh"
            && prepared.executionPlan.managedSessionName === prepared.executionPlan.sessionName;
        const failedFreshDaemon = failedFreshSessionMayHaveStarted && prepared.executionPlan.sessionName
            ? await inspectManagedSessionDaemon({
                cwd,
                headedManagedAutosaveInterval: prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval,
                namespace: prepared.executionPlan.namespace,
                sessionName: prepared.executionPlan.sessionName,
                timeoutMs: Math.min(implicitSessionCloseTimeoutMs, 2_000),
            })
            : undefined;
        if (failedFreshDaemon?.status === "active") {
            state.managedSessionRestoreState.recordDaemonRestoreKey(prepared.executionPlan.sessionName, prepared.executionPlan.namespace, failedFreshDaemon.restoreKey);
        }
        // Only a confirmed inactive daemon proves that a started fresh command did not establish browser ownership.
        const postLaunchFreshFailure = failedFreshDaemon !== undefined && failedFreshDaemon.status !== "inactive";
        const managedTransitionSucceeded = succeeded || nestedBatchClosed || nestedBatchRemainsActive || postLaunchBatchFailure || postLaunchTimeoutWithPage || postLaunchFreshFailure;
        const managedSessionState = resolveManagedSessionState({ command: commandClosesSession ? "close" : prepared.executionPlan.commandInfo.command, managedSessionName: managedCloseSessionName, managedSessionNamespace: prepared.executionPlan.namespace, priorActive: priorManagedSessionActive, priorNamespace: priorManagedSessionNamespace, priorSessionName: priorManagedSessionName, succeeded: managedTransitionSucceeded });
        if (!managedTransitionSucceeded && prepared.sessionMode === "fresh" && prepared.executionPlan.managedSessionName) {
            state.managedSessionRestoreState.clear(prepared.executionPlan.managedSessionName, prepared.executionPlan.namespace);
        }
        const replacedManagedSessionName = managedSessionState.replacedSessionName;
        managedSessionActive = managedSessionState.active;
        managedSessionName = managedSessionState.sessionName;
        managedSessionNamespace = managedSessionState.namespace;
        const executionTargetsManagedSession = prepared.executionPlan.sessionName
            && getAgentBrowserSessionIdentityKey(prepared.executionPlan.sessionName, prepared.executionPlan.namespace)
                === getAgentBrowserSessionIdentityKey(managedSessionName, managedSessionNamespace);
        if (!managedSessionActive) {
            managedSessionCompatibilityWorkaround = undefined;
            managedSessionHeadedAutosaveDisabled = false;
            managedSessionHeadedAutosaveInterval = undefined;
        }
        else if (managedTransitionSucceeded && executionTargetsManagedSession && prepared.ownedManagedSessionContext && !prepared.ownedManagedSessionContext.reuseOnly) {
            managedSessionCompatibilityWorkaround = prepared.compatibilityWorkaround;
            managedSessionHeadedAutosaveDisabled = prepared.ownedManagedSessionContext?.headedManagedAutosaveDisabled === true;
            managedSessionHeadedAutosaveInterval = prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval;
        }
        if (closeCommandSucceeded && managedCloseSessionName === priorManagedSessionName && !managedSessionActive) {
            const daemonRestoreKey = state.managedSessionRestoreState.getDaemonRestoreKey(managedCloseSessionName, priorManagedSessionNamespace);
            const ownedRestoreKey = !state.managedSessionRestoreState.isDisabled(managedCloseSessionName, priorManagedSessionNamespace)
                && isManagedSessionRestoreKey(daemonRestoreKey) ? daemonRestoreKey : null;
            state.managedSessionRestoreState.clear(managedCloseSessionName, priorManagedSessionNamespace);
            pruneOwnedManagedSessionRestoreSnapshots({
                cwd,
                namespace: priorManagedSessionNamespace,
                restoreKey: ownedRestoreKey,
                statePath: rawCloseStatePath,
            });
            freshSessionOrdinal += 1;
            managedSessionName = createFreshSessionName(state.managedSessionBaseName, state.ephemeralSessionSeed, freshSessionOrdinal);
            managedSessionNamespace = undefined;
        }
        let managedSessionOutcome = buildManagedSessionOutcome({ activeAfter: managedSessionActive, activeBefore: priorManagedSessionActive, attemptedSessionName: managedCloseSessionName, command: commandClosesSession ? "close" : prepared.executionPlan.commandInfo.command, currentSessionName: managedSessionName, currentSessionNamespace: managedSessionNamespace, previousSessionName: priorManagedSessionName, replacedSessionName: replacedManagedSessionName, replacedSessionNamespace: priorManagedSessionNamespace, sessionMode: prepared.sessionMode, succeeded: managedTransitionSucceeded });
        if (prepared.executionPlan.managedSessionName && managedTransitionSucceeded && managedSessionActive) {
            managedSessionCwd = cwd;
            managedSessionNamespace = prepared.executionPlan.namespace;
        }
        if (sessionStateKey && succeeded) {
            if (openResultTabCorrection || sessionTabCorrection || aboutBlankSessionMismatch?.recoveryApplied)
                sessionPageState.markPinning(sessionStateKey, "drift");
            else if (prepared.sessionTabPinningReason === "restore" && observedSessionTabTarget)
                sessionPageState.clearRestorePinning(sessionStateKey);
        }
        if (replacedManagedSessionName) {
            const replacedSessionStateKey = getSessionContextKey(replacedManagedSessionName, priorManagedSessionNamespace);
            networkRoutesBySession = new Map(networkRoutesBySession);
            networkRoutesBySession.delete(replacedSessionStateKey ?? replacedManagedSessionName);
            sessionPageState.clearSession(replacedSessionStateKey ?? replacedManagedSessionName);
            const replacedSessionKey = replacedSessionStateKey ?? replacedManagedSessionName;
            const replacedCloseError = await closeManagedSession({ cwd: priorManagedSessionCwd, headedManagedAutosaveInterval: priorManagedSessionHeadedAutosaveInterval, namespace: priorManagedSessionNamespace, preserveAttachedBrowserSession: state.attachedSessionKeys.has(replacedSessionKey), restoreState: state.managedSessionRestoreState, sessionName: replacedManagedSessionName, timeoutMs: implicitSessionCloseTimeoutMs });
            if (managedSessionOutcome) {
                managedSessionOutcome = {
                    ...managedSessionOutcome,
                    replacedSessionClosed: !replacedCloseError,
                    summary: replacedCloseError
                        ? `${managedSessionOutcome.summary} Previous session ${replacedManagedSessionName} remains wrapper-owned because automatic close failed; retry an explicit close.`
                        : managedSessionOutcome.summary,
                };
            }
            if (!replacedCloseError) {
                state.attachedSessionKeys.delete(replacedSessionKey);
                state.closedManagedSessionNames.add(replacedSessionKey);
            }
        }
        let electronLaunchRecord;
        let electronFailedConnectCleanup = prepared.electronFailedConnectCleanup;
        let electronHandoff = prepared.electronHandoff;
        if (prepared.electronLaunch) {
            if (succeeded && prepared.executionPlan.sessionName) {
                const electronSessionName = prepared.executionPlan.sessionName;
                const electronSessionStateKey = sessionStateKey ?? electronSessionName;
                electronLaunchRecord = { ...prepared.electronLaunch.record, namespace: prepared.executionPlan.namespace, sessionName: electronSessionName };
                const electronHandoffMode = prepared.compiledElectron?.action === "launch" ? prepared.compiledElectron.handoff : "connect";
                try {
                    electronHandoff = await collectElectronHandoff({ cwd, handoff: electronHandoffMode, namespace: prepared.executionPlan.namespace, sessionName: electronSessionName, signal });
                }
                catch (error) {
                    electronHandoff = {
                        error: error instanceof Error ? error.message : String(error),
                        failureCategory: signal?.aborted ? "aborted" : "upstream-error",
                        handoff: electronHandoffMode,
                    };
                }
                if (electronHandoff.error) {
                    succeeded = false;
                    presentationEnvelope = { error: electronHandoff.error, success: false };
                    const closeError = await closeManagedSession({ cwd, headedManagedAutosaveInterval: prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval, namespace: prepared.executionPlan.namespace, policyLock: prepared.managedSessionPolicyLock, preserveAttachedBrowserSession: input.preserveAttachedBrowserSession, restoreState: state.managedSessionRestoreState, sessionName: electronSessionName, timeoutMs: implicitSessionCloseTimeoutMs });
                    electronFailedConnectCleanup = await cleanupElectronLaunchResources({ child: prepared.electronLaunch.child, record: electronLaunchRecord, timeoutMs: implicitSessionCloseTimeoutMs });
                    electronLaunchRecord = electronFailedConnectCleanup.record;
                    if (electronFailedConnectCleanup.partial) {
                        electronLaunchRecords.set(electronLaunchRecord.launchId, electronLaunchRecord);
                        electronChildProcesses.set(electronLaunchRecord.launchId, prepared.electronLaunch.child);
                    }
                    else {
                        electronLaunchRecords.delete(electronLaunchRecord.launchId);
                        electronChildProcesses.delete(electronLaunchRecord.launchId);
                    }
                    if (!closeError) {
                        state.closedManagedSessionNames.add(electronSessionStateKey);
                        networkRoutesBySession = new Map(networkRoutesBySession);
                        networkRoutesBySession.delete(electronSessionStateKey);
                        sessionPageState.clearSession(electronSessionStateKey);
                        if (managedSessionName === electronSessionName && managedSessionNamespace === prepared.executionPlan.namespace) {
                            managedSessionActive = false;
                            freshSessionOrdinal += 1;
                            managedSessionName = createFreshSessionName(state.managedSessionBaseName, state.ephemeralSessionSeed, freshSessionOrdinal);
                            managedSessionNamespace = undefined;
                        }
                    }
                    managedSessionOutcome = buildManagedSessionOutcome({ activeAfter: managedSessionActive, activeBefore: priorManagedSessionActive, attemptedSessionName: electronSessionName, command: prepared.executionPlan.commandInfo.command, currentSessionName: managedSessionName, currentSessionNamespace: managedSessionNamespace, previousSessionName: priorManagedSessionName, replacedSessionName: replacedManagedSessionName, replacedSessionNamespace: priorManagedSessionNamespace, sessionMode: prepared.sessionMode, succeeded: false });
                }
                else {
                    electronLaunchRecords.set(electronLaunchRecord.launchId, electronLaunchRecord);
                    electronChildProcesses.set(electronLaunchRecord.launchId, prepared.electronLaunch.child);
                    if (electronHandoff.refSnapshot) {
                        const refUpdate = sessionPageState.applyRefSnapshot({ sessionName: electronSessionStateKey, snapshot: electronHandoff.refSnapshot, update: sessionPageStateUpdate });
                        currentRefSnapshot = refUpdate.refSnapshot;
                        currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
                        if (electronHandoff.refSnapshot.target) {
                            const targetUpdate = sessionPageState.applyTabTarget({ sessionName: electronSessionStateKey, target: electronHandoff.refSnapshot.target, update: sessionPageStateUpdate });
                            currentSessionTabTarget = targetUpdate.tabTarget;
                        }
                    }
                }
            }
            else {
                electronFailedConnectCleanup = await cleanupElectronLaunchResources({ child: prepared.electronLaunch.child, record: prepared.electronLaunch.record, timeoutMs: implicitSessionCloseTimeoutMs });
                electronLaunchRecord = electronFailedConnectCleanup.record;
            }
        }
        let errorText = recordingStopRecovery?.recovery.healed ? undefined : getAgentBrowserErrorText({ aborted: processResult.aborted, command: prepared.executionPlan.commandInfo.command, effectiveArgs: prepared.redactedProcessArgs, envelope: presentationEnvelope, exitCode: processResult.exitCode, parseError, plainTextInspection, staleRefArgs: getStaleRefArgs(prepared.commandTokens, prepared.runtimeToolStdin), spawnError: processResult.spawnError, stderr: processResult.stderr, timedOut: processResult.timedOut, timeoutMs: processResult.timeoutMs, wrapperRecoveryHint: buildWrapperRecoveryHint({ sessionTabCorrection }) });
        if (errorText && presentationEnvelope?.success === false && extractEnvelopeErrorText(presentationEnvelope.error) === undefined)
            presentationEnvelope = { ...presentationEnvelope, error: errorText };
        if (errorText) {
            const clipboardWritePayloadCandidates = getClipboardWritePayloadCandidates(prepared.commandTokens);
            errorText = redactClipboardPermissionEcho(prepared.executionPlan.commandInfo, errorText);
            if (presentationEnvelope?.error !== undefined)
                presentationEnvelope = { ...presentationEnvelope, error: redactClipboardPermissionErrorValue(prepared.executionPlan.commandInfo, presentationEnvelope.error, clipboardWritePayloadCandidates) };
        }
        if (plainTextUpgrade && errorText)
            presentationEnvelope = { ...presentationEnvelope, success: false, error: errorText };
        let presentation = plainTextInspection ? { artifacts: undefined, batchFailure: undefined, batchSteps: undefined, content: [{ type: "text", text: inspectionText ?? "" }], data: undefined, fullOutputPath: undefined, fullOutputPaths: undefined, imagePath: undefined, imagePaths: undefined, savedFile: undefined, savedFilePath: undefined, summary: `${prepared.redactedArgs.join(" ")} completed` } : recordingStopRecovery && !recordingStopRecovery.batch ? recordingStopRecovery.presentation : await buildToolPresentation({ args: prepared.redactedProcessArgs, artifactManifest, artifactMaxUpdatedAtMs: Date.now(), artifactMinUpdatedAtMs: input.artifactRunStartedAtMs, artifactRequest: screenshotArtifactRequest, batchArtifactRequests: batchScreenshotArtifactRequests, commandInfo: prepared.executionPlan.commandInfo, compiledSemanticAction: prepared.compiledSemanticAction, cwd, envelope: presentationEnvelope, errorText, namespace: prepared.executionPlan.namespace, networkRouteDiagnostics, networkRoutes: activeNetworkRoutes, persistentArtifactStore, piCleanupOwnership: sessionStateKey && (state.ownedManagedSessions.has(sessionStateKey) || prepared.executionPlan.managedSessionName !== undefined) ? "wrapper-managed" : "caller-owned", revealSecrets: prepared.revealSecrets, sessionName: prepared.executionPlan.sessionName });
        if (recordingStopRecovery)
            presentation = mergeRecordingRecoveryPresentation(presentation, recordingStopRecovery);
        const confirmation = readConfirmationEvent ?? prepared.readConfirmation;
        if (confirmation) {
            presentation.readConfirmation = confirmation;
            if (confirmation.state !== "cleared" || !detectConfirmationRequired(presentationEnvelope?.data)) {
                presentation.nextActions = buildReadConfirmationNextActions(confirmation, readConfirmationEvent?.state === "pending");
            }
            if (readConfirmationEvent?.state === "pending") {
                presentation.resultCategory = "failure";
                presentation.failureCategory = "confirmation-required";
                presentation.successCategory = undefined;
            }
        }
        if (plainTextUpgrade && !succeeded && typeof presentationEnvelope?.data === "string") {
            presentation.data = presentationEnvelope.data;
            const errorContent = presentation.content[0];
            if (errorContent?.type === "text" && presentationEnvelope.data)
                errorContent.text += `\n\n${presentationEnvelope.data}`;
            presentation = await compactLargePresentationOutput({ artifactManifest, commandInfo: prepared.executionPlan.commandInfo, data: presentation.data, persistentArtifactStore, presentation });
        }
        if (electronHandoff?.error && electronHandoff.failureCategory)
            presentation.failureCategory = electronHandoff.failureCategory;
        networkRoutesBySession = applyBatchNetworkRouteState({ data: presentationEnvelope?.data, routesBySession: networkRoutesBySession, sessionName: sessionStateKey, succeeded });
        // local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7) — finalize checkpoint runs.
        // Additive only: this block executes exclusively for kind === "checkpoint"; the settle-retry
        // ladder and the P24 diagnostics buffer below are untouched. The finalizer encrypts/stores the
        // captured state (save), grades the post-restore health check (restore), deletes the decrypted
        // temp file, and registers the ciphertext path so the P12 scrub covers any accidental echo.
        let checkpointDetails;
        if (prepared.kind === "checkpoint" && prepared.compiledCheckpoint) {
            const finalizedCheckpoint = await finalizeCheckpointRun({
                compiledCheckpoint: prepared.compiledCheckpoint,
                presentation,
                presentationEnvelope,
                processSucceeded,
                succeeded,
            });
            succeeded = finalizedCheckpoint.succeeded;
            presentation = finalizedCheckpoint.presentation;
            presentationEnvelope = finalizedCheckpoint.presentationEnvelope;
            checkpointDetails = finalizedCheckpoint.checkpoint;
        }
        if (presentation.resultCategory === "failure" && succeeded) {
            succeeded = false;
            presentationEnvelope = { ...(presentationEnvelope ?? {}), error: presentation.summary, success: false };
        }
        if (scrollNoopDiagnostic) {
            succeeded = false;
            presentation.resultCategory = "failure";
            presentation.failureCategory = "upstream-error";
            presentationEnvelope = { ...(presentationEnvelope ?? {}), error: "Scroll completed with no observed movement.", success: false };
            presentation.summary = "Scroll completed with no observed movement.";
            if (isRecord(presentation.data))
                presentation.data = { ...presentation.data, noMovement: true, scrolled: false };
            if (presentation.content[0]?.type === "text") {
                const details = isRecord(presentation.data) ? JSON.stringify(omitUpstreamLifecycle(presentation.data), null, 2) : presentation.content[0].text;
                presentation.content[0] = { ...presentation.content[0], text: `Scroll completed with no observed movement.\n\n${details}` };
            }
            else {
                presentation.content.unshift({ type: "text", text: "Scroll completed with no observed movement." });
            }
        }
        if (parseFailureOutput.artifactManifest) {
            presentation.artifactManifest = parseFailureOutput.artifactManifest;
            presentation.artifactRetentionSummary = parseFailureOutput.artifactRetentionSummary;
        }
        if (parseFailureOutput.fullOutputPath || parseFailureOutput.fullOutputUnavailable) {
            const existingText = presentation.content[0]?.type === "text" ? presentation.content[0].text : "";
            const noticeLines = [parseFailureOutput.fullOutputPath ? `Full output path: ${parseFailureOutput.fullOutputPath}` : `Full raw output unavailable: ${parseFailureOutput.fullOutputUnavailable}`, parseFailureOutput.artifactRetentionSummary].filter((item) => item !== undefined);
            const notice = noticeLines.join("\n");
            presentation.content[0] = { type: "text", text: existingText.length > 0 ? `${existingText}\n\n${notice}` : notice };
        }
        if (presentation.artifactManifest)
            artifactManifest = presentation.artifactManifest;
        const qaPreset = prepared.compiledQaPreset
            ? (processResult.timedOut ? analyzeQaPresetTimeout(prepared.compiledQaPreset) ?? analyzeQaPresetResults(presentationEnvelope?.data, prepared.compiledQaPreset) : analyzeQaPresetResults(presentationEnvelope?.data, prepared.compiledQaPreset))
            : undefined;
        // FINAL-DESIGN.md pillar A reshape item 2 (§5 step 4): per-step verification receipts for job
        // mode (kind-gated: qa runs alias into compiledJob too). Probe rows are ordinary batch rows,
        // so a failed probe already fails the job through the existing batch verdict path; receipts
        // are additive evidence, not a license for blind execution.
        const jobReceipts = prepared.kind === "job" && prepared.compiledJob ? analyzeJobReceipts(prepared.compiledJob.steps, presentation?.batchSteps, presentation) : undefined;
        let qaAttachedTarget = prepared.compiledQaPreset?.checks.attached
            ? await collectQaAttachedTarget({ currentTarget: currentSessionTabTarget ?? prepared.priorSessionTabTarget, cwd, namespace: prepared.executionPlan.namespace, sessionName: prepared.executionPlan.sessionName, signal })
            : undefined;
        const sourceLookupElectronContext = prepared.compiledSourceLookup ? getSourceLookupElectronContext({ currentTarget: currentSessionTabTarget, electronLaunchRecords, namespace: prepared.executionPlan.namespace, priorTarget: prepared.priorSessionTabTarget, sessionName: prepared.executionPlan.sessionName }) : undefined;
        const sourceLookup = prepared.compiledSourceLookup ? await analyzeSourceLookupResults(presentationEnvelope?.data, prepared.compiledSourceLookup, cwd, { electronContext: sourceLookupElectronContext, workspaceRoot: cwd }) : undefined;
        const networkSourceLookup = prepared.compiledNetworkSourceLookup ? redactNetworkSourceLookupAnalysis(await analyzeNetworkSourceLookupResults(presentationEnvelope?.data, prepared.compiledNetworkSourceLookup, cwd)) : undefined;
        if (networkSourceLookup && presentation.content[0]?.type === "text")
            presentation.content[0] = { ...presentation.content[0], text: `${networkSourceLookup.summary}\n\n${presentation.content[0].text}` };
        else if (networkSourceLookup)
            presentation.content.unshift({ type: "text", text: networkSourceLookup.summary });
        if (sourceLookup && presentation.content[0]?.type === "text")
            presentation.content[0] = { ...presentation.content[0], text: `${sourceLookup.summary}\n\n${presentation.content[0].text}` };
        else if (sourceLookup)
            presentation.content.unshift({ type: "text", text: sourceLookup.summary });
        if (qaPreset && !qaPreset.passed && prepared.compiledQaPreset && presentation.failureCategory !== "artifact-missing") {
            succeeded = false;
            presentation.failureCategory = "qa-failure";
            presentation.summary = qaPreset.summary;
            const compactText = buildQaCompactFailureText({
                batchStepCount: presentation.batchSteps?.length ?? prepared.compiledQaPreset.steps.length,
                checks: prepared.compiledQaPreset.checks,
                page: extractQaPageContext({
                    attachedTarget: qaAttachedTarget,
                    batchData: presentationEnvelope?.data,
                    compiled: prepared.compiledQaPreset,
                }),
                qaPreset,
            });
            const nonTextContent = presentation.content.filter((item) => item.type !== "text");
            presentation.content = [{ type: "text", text: compactText }, ...nonTextContent];
        }
        else if (qaPreset?.passed && prepared.compiledQaPreset && succeeded) {
            const compactText = buildQaCompactPassText({
                artifactVerification: presentation.artifactVerification,
                batchStepCount: presentation.batchSteps?.length ?? prepared.compiledQaPreset.steps.length,
                checks: prepared.compiledQaPreset.checks,
                page: extractQaPageContext({
                    attachedTarget: qaAttachedTarget,
                    batchData: presentationEnvelope?.data,
                    compiled: prepared.compiledQaPreset,
                }),
                qaPreset,
            });
            presentation.summary = qaPreset.summary;
            const nonTextContent = presentation.content.filter((item) => item.type !== "text");
            presentation.content = [{ type: "text", text: compactText }, ...nonTextContent];
        }
        const qaAttachedTargetText = formatQaAttachedTargetText(qaAttachedTarget);
        const qaAttachedDiagnosticsText = prepared.compiledQaPreset?.checks.attached && prepared.compiledQaPreset.checks.diagnosticsResetAtStart === false && (prepared.compiledQaPreset.checks.checkNetwork || prepared.compiledQaPreset.checks.checkConsole || prepared.compiledQaPreset.checks.checkErrors)
            ? "Attached diagnostics: existing upstream session console/network/error buffers were preserved; rows may include events from before qa.attached started."
            : undefined;
        const qaAttachedBannerText = [qaAttachedTargetText, qaAttachedDiagnosticsText].filter((part) => typeof part === "string" && part.length > 0).join("\n");
        const skipAttachedTargetBanner = qaPreset?.passed && prepared.compiledQaPreset?.checks.attached;
        if (!skipAttachedTargetBanner && qaAttachedBannerText && presentation.content[0]?.type === "text")
            presentation.content[0] = { ...presentation.content[0], text: `${qaAttachedBannerText}\n\n${presentation.content[0].text}` };
        else if (!skipAttachedTargetBanner && qaAttachedBannerText)
            presentation.content.unshift({ type: "text", text: qaAttachedBannerText });
        if (managedSessionOutcome && managedSessionOutcome.succeeded !== succeeded)
            managedSessionOutcome = { ...managedSessionOutcome, succeeded };
        const evalNavigationSummary = navigationSummary ?? extractNavigationSummaryFromData(presentationEnvelope?.data);
        const evalSessionTabUrl = sessionStateKey ? sessionPageState.get(sessionStateKey).tabTarget?.url : undefined;
        const evalPageUrl = evalNavigationSummary?.url ?? currentSessionTabTarget?.url ?? prepared.priorSessionTabTarget?.url ?? evalSessionTabUrl;
        const evalStdinHint = getEvalStdinHint({ command: prepared.executionPlan.commandInfo.command, data: presentationEnvelope?.data, stdin: prepared.runtimeToolStdin });
        const evalResultWarning = getEvalResultWarning({ command: prepared.executionPlan.commandInfo.command, data: presentationEnvelope?.data, navigationSummary: evalNavigationSummary, pageUrl: evalPageUrl, stdin: prepared.runtimeToolStdin });
        if (readConfirmationEvent)
            state.sessionPageState.applyReadConfirmation(readConfirmationEvent, sessionPageStateUpdate);
        const resultArtifactManifest = presentation.artifactManifest ?? artifactManifest;
        const artifactCleanup = await getArtifactCleanupGuidance({ command: prepared.executionPlan.commandInfo.command, cwd, manifest: resultArtifactManifest, succeeded });
        const recordingTransitionReached = prepared.executionPlan.commandInfo.command === "batch"
            ? presentation.batchSteps?.some((step) => isRecordPageTransitionCommand(extractUpstreamCommandTokens(step.command ?? [])))
            : isRecordPageTransitionCommand(prepared.commandTokens);
        const recordingPageWarning = processResult.agentBrowserStarted && !prepared.executionPlan.plainTextInspection && recordingTransitionReached
            ? "Page state: this wrapper conservatively invalidates earlier refs after recording starts and URL-bearing restarts. Take a fresh snapshot before continuing; this does not prove the page changed."
            : undefined;
        const sessionWarning = electronPostCommandHealth ? formatElectronPostCommandHealthText(electronPostCommandHealth) : electronSessionMismatch ? formatElectronSessionMismatchText(electronSessionMismatch) : aboutBlankSessionMismatch ? buildAboutBlankWarning(aboutBlankSessionMismatch) : undefined;
        const warningText = [sessionWarning, recordingPageWarning].filter(Boolean).join("\n\n") || undefined;
        const redactedContent = buildRedactedPresentationContent({ exactSensitiveValues: prepared.exactSensitiveValues, plainTextInspection, presentation, presentationEnvelope, succeeded, userRequestedJson: prepared.userRequestedJson, warningText });
        const finalRecoveryState = await prepareFinalResultRecoveryState({ aboutBlankSessionMismatch, batchRefSnapshotState, commandTokens: prepared.commandTokens, compiledSemanticAction: prepared.compiledSemanticAction, currentRefSnapshot, currentRefSnapshotInvalidation, currentSessionTabTarget, cwd, electronPostCommandHealth, errorText, executionPlan: prepared.executionPlan, parseError, plainTextInspection, presentation, processResult, redactedProcessArgs: prepared.redactedProcessArgs, runtimeToolArgs: prepared.runtimeToolArgs, sessionPageState, sessionPageStateUpdate, sessionTabCorrection, signal, succeeded });
        currentRefSnapshot = finalRecoveryState.currentRefSnapshot;
        currentRefSnapshotInvalidation = finalRecoveryState.currentRefSnapshotInvalidation;
        const authoritativePageState = sessionStateKey ? sessionPageState.get(sessionStateKey) : undefined;
        if (sessionStateKey)
            currentSessionTabTarget = authoritativePageState?.tabTarget;
        // FINAL-DESIGN.md pillar A reshape item 1 (F1): auto-settle-retry ladder ①. For failure classes
        // that provably dispatched nothing (stale-ref, selector-not-found), wait 300ms and re-execute the
        // identical prepared process args once — no model round-trip. The re-run re-enters this same
        // pipeline with settleRetry.attempted set, which caps the ladder at a single retry; on retry
        // failure the fresher retried result is returned with a one-line note.
        const settleRetryOutcome = input.settleRetry?.attempted === true ? { attempted: true, recovered: succeeded === true } : undefined;
        const settleRetryElapsedMs = Math.max(0, Date.now() - input.artifactRunStartedAtMs);
        const settleRetryEligible = settleRetryOutcome === undefined
            && succeeded !== true
            && signal?.aborted !== true
            && !isAgentBrowserScriptSessionName(prepared.executionPlan.sessionName)
            // Review round 1 (batch double-dispatch): a batch presentation's run-level failureCategory
            // is the failed STEP's category, so shouldRetrySettle alone cannot prove nothing dispatched
            // — refuse any presentation carrying batchFailure, whatever its shape.
            && presentation.batchFailure == null
            && shouldRetrySettle({ commandInfo: prepared.executionPlan.commandInfo, failureCategory: finalRecoveryState.categoryDetails.failureCategory })
            && hasSettleRetryTimeBudget({ startedAtMs: input.artifactRunStartedAtMs, timeoutMs: prepared.processTimeoutMs });
        if (settleRetryEligible) {
            await sleepMs(SETTLE_RETRY_DELAY_MS);
            if (signal?.aborted !== true) {
                const settleRetryProcessResult = await withChromeStartupArgs(prepared.chromeStartupArgs, () => runAgentBrowserProcess({
                    args: prepared.processArgs,
                    browserIndependentReadConfirmation: prepared.readConfirmation !== undefined,
                    cwd,
                    env: prepared.ownedManagedSessionContext ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: input.implicitSessionIdleTimeoutMs } : undefined,
                    managedSessionRestoreState: state.managedSessionRestoreState,
                    managedStateCurrentPageUrl: prepared.priorSessionTabTarget?.url,
                    managedStatePageUrlUnknown: prepared.priorSessionTabTargetUnknown === true,
                    ownedManagedSession: prepared.ownedManagedSessionContext !== undefined,
                    signal,
                    stdin: prepared.processStdin,
                    // Review round 1 (budget floor-not-cap): the retried run gets the remaining wall
                    // clock minus the settle delay, never the full prepared timeout again.
                    timeoutMs: computeRetryTimeoutMs({ timeoutMs: prepared.processTimeoutMs, elapsedMs: settleRetryElapsedMs, delayMs: SETTLE_RETRY_DELAY_MS }),
                }));
                return await processBrowserOutput({ ...input, processResult: settleRetryProcessResult, settleRetry: { attempted: true } });
            }
        }
        // local patch: analyze the new modes' payloads for their `details.*Report` fields (PATCHES.md P16-P19).
        const debugReport = prepared.compiledDebug ? analyzeDebugPresetResults(presentation?.batchSteps ?? [], prepared.compiledDebug).report : undefined;
        const settleReport = prepared.compiledSettle ? analyzeSettleResult(presentation?.data) : undefined;
        const networkBodyResult = prepared.compiledNetworkBody ? extractNetworkBodies(presentation?.data, prepared.compiledNetworkBody) : undefined;
        const revealSecretsMatchedRows = prepared.revealSecrets ? countRevealedSecretRows(presentation?.data, prepared.revealSecrets) : 0;
        // local patch: the revealed values must be appended AFTER the string redaction pass, otherwise
        // `redactSensitiveText` rewrites `Bearer <token>` back to a placeholder (P13).
        const revealedHeaderLines = collectRevealedHeaderLines(presentation?.data, prepared.revealSecrets);
        const currentSessionTabTargetUnknown = authoritativePageState?.tabTargetUnknown === true ? true : undefined;
        const resultRetainsPreparedManagedSession = !managedSessionOutcome || (managedSessionOutcome.activeAfter
            && managedSessionOutcome.attemptedSessionName === managedSessionOutcome.currentSessionName);
        const resultHeadedManagedAutosaveDisabled = prepared.ownedManagedSessionContext?.headedManagedAutosaveDisabled === true
            && !prepared.ownedManagedSessionContext.reuseOnly
            && resultRetainsPreparedManagedSession
            && !(commandClosesSession && succeeded);
        const resultHeadedManagedAutosaveInterval = resultRetainsPreparedManagedSession && !prepared.ownedManagedSessionContext?.reuseOnly && !(commandClosesSession && succeeded)
            ? prepared.ownedManagedSessionContext?.headedManagedAutosaveInterval
            : undefined;
        const result = buildFinalAgentBrowserToolResult({ aboutBlankSessionMismatch, artifactCleanup, categoryDetails: finalRecoveryState.categoryDetails, clickDispatchDiagnostic, commandTokens: prepared.commandTokens, comboboxFocusDiagnostic, compiledDebug: prepared.compiledDebug, compiledLogin: prepared.compiledLogin, compiledNetworkBody: prepared.compiledNetworkBody, compiledNetworkSourceLookup: prepared.compiledNetworkSourceLookup, compiledScript: prepared.compiledScript, compiledSemanticAction: prepared.compiledSemanticAction, compiledSettle: prepared.compiledSettle, compiledVault: prepared.compiledVault, compatibilityWorkaround: prepared.compatibilityWorkaround, currentRefSnapshot, currentRefSnapshotInvalidation, currentSessionTabTarget, currentSessionTabTargetUnknown, debugReport, electronBroadGetTextScopeDiagnostics, electronFailedConnectCleanup, electronHandoff, electronLaunch: prepared.electronLaunch, electronLaunchRecord, electronLaunchRecords, electronPostCommandHealth, electronProfileIsolationDetails: input.electronProfileIsolationDetails, electronRefFreshnessDiagnostic, electronSessionMismatch, errorText, evalResultWarning, evalStdinHint, exactSensitiveValues: prepared.exactSensitiveValues, executionPlan: prepared.executionPlan, fillVerificationDiagnostic, geolocationStubNote, headedLaunch: prepared.headedLaunch, inspectionText, jobReceipts, preserveAttachedBrowserSession: input.preserveAttachedBrowserSession === true, providerLaunch: prepared.providerLaunch, managedSessionHeadedAutosaveDisabled: resultHeadedManagedAutosaveDisabled || undefined, managedSessionHeadedAutosaveInterval: resultHeadedManagedAutosaveInterval, managedSessionOutcome, managedSessionRestoreDisabled: state.managedSessionRestoreState.isDisabled(prepared.executionPlan.sessionName, prepared.executionPlan.namespace), navigationSummary, networkBody: networkBodyResult, networkSourceLookup, noActivePageSnapshotFailure: finalRecoveryState.noActivePageSnapshotFailure, openResultTabCorrection, overlayBlockerDiagnostic, parseError, parseFailureOutput, parseSucceeded, plainTextInspection, presentation, presentationEnvelope, priorSessionTabTarget: prepared.priorSessionTabTarget, processResult, qaAttachedTarget, qaPreset, recoveredBy: settleRetryOutcome?.recovered === true ? "settle-retry" : undefined, settleRetryOutcome: settleRetryOutcome === undefined ? undefined : settleRetryOutcome.recovered ? "recovered" : "attempted-failed", recordingDependencyWarning, redactedArgs: prepared.redactedArgs, redactedCompiledElectron: prepared.redactedCompiledElectron, redactedCompiledJob: prepared.redactedCompiledJob, redactedCompiledNetworkSourceLookup: prepared.redactedCompiledNetworkSourceLookup, redactedCompiledQaPreset: prepared.redactedCompiledQaPreset, redactedCompiledSemanticAction: prepared.redactedCompiledSemanticAction, redactedCompiledSourceLookup: prepared.redactedCompiledSourceLookup, redactedContent, redactedProcessArgs: prepared.redactedProcessArgs, redactedRecoveryHint: prepared.redactedRecoveryHint, resultArtifactManifest, revealSecrets: prepared.revealSecrets, revealSecretsMatchedRows, revealedHeaderLines, richInputRecoveryDiagnostic: finalRecoveryState.richInputRecoveryDiagnostic, scrollNoopDiagnostic, selectorTextVisibilityDiagnostics, sessionMode: prepared.sessionMode, sessionTabCorrection, settleReport, settleRetryNote: settleRetryOutcome === undefined ? undefined : settleRetryOutcome.recovered ? "Recovered by settle-retry (1 automatic retry after 300ms)" : "Settle-retry attempted and failed; the fresher retried failure is returned.", sourceLookup, succeeded, timeoutPartialProgress, unsettledWebMcpMutation, userRequestedJson: prepared.userRequestedJson, verbosity: prepared.verbosity, visibleRefFallbackDiagnostic: finalRecoveryState.visibleRefFallbackDiagnostic, visibleRefFallbackSessionName: finalRecoveryState.visibleRefFallbackSessionName });
        // local patch: checkpoint details merge — additive, secret-free by construction (ids, byte
        // counts, labels only; no paths, no decrypted content).
        const resultWithCheckpoint = checkpointDetails
            ? { ...result, details: { ...(isRecord(result.details) ? result.details : {}), checkpoint: checkpointDetails } }
            : result;
        const resultWithCloseAll = closeAllApplied
            ? { ...resultWithCheckpoint, details: { ...(isRecord(resultWithCheckpoint.details) ? resultWithCheckpoint.details : {}), closeAllApplied: true } }
            : resultWithCheckpoint;
        // local patch: annotate console/errors/network reads with a reliable "since last read" window (P24).
        const bufferedResult = applyDiagnosticsBufferDedup({
            command: prepared.executionPlan.commandInfo.command,
            data: presentation?.data,
            result: resultWithCloseAll,
            sessionKey: sessionStateKey,
            jsonLane: prepared.userRequestedJson === true && !plainTextInspection,
        });
        const statePatch = { artifactManifest, freshSessionOrdinal, managedSessionActive, managedSessionCompatibilityWorkaround, managedSessionHeadedAutosaveDisabled, managedSessionHeadedAutosaveInterval, managedSessionCwd, managedSessionName, managedSessionNamespace, networkRoutesBySession };
        return { result: bufferedResult ?? resultWithCloseAll, statePatch };
    }
    finally {
        if (processResult.stdoutSpillPath)
            await rm(processResult.stdoutSpillPath, { force: true }).catch(() => undefined);
    }
}
