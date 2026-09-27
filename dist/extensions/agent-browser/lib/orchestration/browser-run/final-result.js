import { cleanupElectronLaunchResources } from "../../electron/cleanup.js";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { scrubVaultSecrets, scrubVaultSecretValues } from "../../vault/secret-registry.js";
import { buildRevealSecretsWarning, describeRevealSecrets } from "./reveal-secrets.js";
import { shouldAppendDetailedSections, shouldAppendDiagnosticBlocks, shouldAppendNextActionText } from "./verbosity.js";
import { getCompiledSemanticActionCommandIndex, getCompiledSemanticActionSessionPrefix, isCompiledSemanticActionFindCommand } from "../../input-modes/semantic-action.js";
import { redactNetworkSourceLookupSurface } from "../../input-modes/lookups.js";
import { buildAgentBrowserNextActions } from "../../results/action-recommendations.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { extractAgentBrowserLifecycle } from "../../results/presentation/common.js";
import { formatSessionArtifactRetentionSummary } from "../../results/artifact-manifest.js";
import { alignPageChangeSummaryNextActionIds, appendUniqueAgentBrowserNextActions, applyNamespaceToNextActions, isStandaloneSnapshotNextAction, withOptionalSessionArgs, } from "../../results/next-actions.js";
import { buildConnectedSessionNextActions, buildNoActivePageNextActions, buildPendingWebMcpNextActions, buildSessionAwareStaleRefNextActions, buildSessionTabRecoveryNextActions, } from "../../results/recovery-next-actions.js";
import { buildRichInputRecoveryDiagnostic, buildRichInputRecoveryNextActions, buildVisibleRefFallbackNextActions, formatRichInputRecoveryText, formatVisibleRefFallbackText, sanitizeVisibleRefFallbackDiagnostic, } from "../../results/selector-recovery.js";
import { buildNoActivePageRefSnapshotInvalidation, isNoActivePageSnapshotFailure, } from "../../session-page-state.js";
import { extractExplicitSessionName } from "../../argv-grammar.js";
import { redactInvocationArgs, redactSensitiveText, redactSensitiveValue } from "../../runtime.js";
import { isRecord } from "../../parsing.js";
import { buildClickDispatchNextActions, formatClickDispatchDiagnosticText } from "./click-dispatch.js";
import { buildComboboxFocusNextActions, buildElectronBroadGetTextScopeNextActions, buildFillVerificationNextActions, buildOverlayBlockerNextActions, buildScrollNoopNextActions, buildSelectorTextVisibilityNextActions, buildSourceLookupElectronNextActions, collectVisibleRefFallbackDiagnostic, formatArtifactCleanupGuidanceText, formatComboboxFocusDiagnosticText, formatElectronBroadGetTextScopeText, formatEvalResultWarningText, formatEvalStdinHintText, formatFillVerificationText, formatOverlayBlockerText, formatRecordingDependencyWarningText, formatScrollNoopDiagnosticText, formatSelectorTextVisibilityText, formatTimeoutPartialProgressText, } from "./diagnostics.js";
import { buildElectronIdentifiers, buildElectronLifecycleNextActions, buildElectronMismatchNextActions, buildElectronRefFreshnessNextActions, buildManagedSessionFreshFailureNextActions, buildManagedSessionOutcome, buildSessionDetailFields, getSessionContextKey, formatElectronRefFreshnessText, formatManagedSessionOutcomeText, } from "./session-state.js";
export function buildMissingBinaryMessage() {
    return [
        "agent-browser is required but was not found on PATH.",
        "This project does not bundle agent-browser.",
        "Run `pi-agent-browser-doctor` for package/PATH diagnostics, then install agent-browser using the upstream docs:",
        "- https://agent-browser.dev/",
        "- https://github.com/vercel-labs/agent-browser",
    ].join("\n");
}
const SEMANTIC_ACTION_CANDIDATE_ACTION_IDS = new Set(["try-button-name-candidate", "try-link-name-candidate"]);
export function formatSemanticActionCandidateText(actions) {
    const candidateActions = actions.filter((action) => SEMANTIC_ACTION_CANDIDATE_ACTION_IDS.has(action.id) && action.params?.args);
    if (candidateActions.length === 0)
        return undefined;
    return ["Agent-browser candidate fallbacks:", ...candidateActions.map((action) => `- ${action.id}: agent_browser ${JSON.stringify({ args: action.params?.args })} — ${action.reason}`)].join("\n");
}
export function buildSemanticActionCandidateActions(compiled) {
    const commandIndex = getCompiledSemanticActionCommandIndex(compiled);
    if (commandIndex < 0 || compiled.args[commandIndex] !== "find")
        return [];
    const locator = compiled.args[commandIndex + 1];
    const value = compiled.args[commandIndex + 2];
    if (!locator || !value)
        return [];
    const sessionPrefix = getCompiledSemanticActionSessionPrefix(compiled);
    const buildRoleCandidate = (role, id, reason) => {
        const args = [...sessionPrefix, "find", "role", role, compiled.action];
        args.push("--name", value);
        return { id, params: { args: redactInvocationArgs(args) }, reason, safety: "Candidate locator fallback only; inspect the page if multiple elements could match the same accessible name.", tool: "agent_browser" };
    };
    if (locator === "text" && compiled.action === "click") {
        return [
            buildRoleCandidate("button", "try-button-name-candidate", "Retry against a button with the same accessible name when text lookup misses."),
            buildRoleCandidate("link", "try-link-name-candidate", "Retry against a link with the same accessible name when text lookup misses."),
        ];
    }
    return [];
}
export function buildWrapperRecoveryHint(options) {
    if (!options.sessionTabCorrection)
        return undefined;
    return "Wrapper recovery hint: this call used session tab correction. Inspect details.effectiveArgs and details.sessionTabCorrection; if the selected tab looks wrong, run tab list for the same session before retrying.";
}
export function redactExactSensitiveText(text, sensitiveValues) {
    let redacted = text;
    for (const value of sensitiveValues)
        redacted = redacted.split(value).join("[REDACTED]");
    return redacted;
}
export function redactExactSensitiveValue(value, sensitiveValues) {
    if (sensitiveValues.length === 0)
        return value;
    if (typeof value === "string")
        return redactExactSensitiveText(value, sensitiveValues);
    if (Array.isArray(value))
        return value.map((item) => redactExactSensitiveValue(item, sensitiveValues));
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, redactExactSensitiveValue(entryValue, sensitiveValues)]));
}
export function redactToolDetails(details, sensitiveValues) {
    return redactSensitiveValue(redactExactSensitiveValue(details, sensitiveValues));
}
export function redactRecoveryHint(recoveryHint) {
    if (!recoveryHint)
        return undefined;
    const exampleArgs = redactInvocationArgs(recoveryHint.exampleArgs);
    return { ...recoveryHint, exampleArgs, exampleParams: { ...recoveryHint.exampleParams, args: exampleArgs } };
}
export function buildJsonVisibleContent(options) {
    const { error, presentation, succeeded, warnings } = options;
    const payload = redactSensitiveValue({ artifacts: presentation.artifacts, data: presentation.data, error, recordingRecovery: presentation.recordingRecovery, readConfirmation: presentation.readConfirmation, success: succeeded, warnings: warnings && warnings.length > 0 ? warnings : undefined });
    if (isRecord(payload) && isRecord(payload.data) && isRecord(presentation.data) && typeof presentation.data.wsUrl === "string")
        payload.data.wsUrl = presentation.data.wsUrl;
    const images = presentation.content.filter((item) => item.type === "image");
    return [{ type: "text", text: JSON.stringify(payload, null, 2) }, ...images];
}
export function getElectronLaunchFailureCategory(failure) {
    if (failure.reason === "aborted")
        return "aborted";
    if (failure.reason === "policy-blocked")
        return "policy-blocked";
    if (failure.reason === "timeout")
        return "timeout";
    if (failure.reason === "non-electron-target")
        return "validation-error";
    return "upstream-error";
}
function formatElectronLaunchFailureDiagnostics(failure) {
    const diagnostics = failure?.diagnostics;
    if (!diagnostics)
        return undefined;
    const lines = ["Electron launch diagnostics:"];
    if (diagnostics.pid !== undefined)
        lines.push(`- PID: ${diagnostics.pid} (${diagnostics.pidAlive === undefined ? "state unknown" : diagnostics.pidAlive ? "alive before cleanup" : "not alive before cleanup"}).`);
    if (diagnostics.exitCode !== undefined || diagnostics.exitSignal !== undefined) {
        const exitParts = [diagnostics.exitCode !== undefined ? `code ${diagnostics.exitCode}` : undefined, diagnostics.exitSignal ? `signal ${diagnostics.exitSignal}` : undefined].filter(Boolean).join(", ");
        lines.push(`- Process exit: ${exitParts || "not observed before cleanup"}.`);
    }
    if (diagnostics.userDataDir)
        lines.push(`- Wrapper profile: ${diagnostics.userDataDir}`);
    if (diagnostics.devToolsActivePort) {
        const activePort = diagnostics.devToolsActivePort;
        const state = activePort.port ? `found port ${activePort.port}` : activePort.found ? `found but invalid${activePort.error ? ` (${activePort.error})` : ""}` : `missing${activePort.error ? ` (${activePort.error})` : ""}`;
        lines.push(`- DevToolsActivePort: ${state} at ${activePort.path}.`);
    }
    if (diagnostics.cdpVersionReached === false)
        lines.push("- CDP /json/version: did not return a valid payload before timeout.");
    if (diagnostics.timeoutMs !== undefined || diagnostics.elapsedMs !== undefined)
        lines.push(`- Timing: ${diagnostics.elapsedMs ?? "unknown"}ms elapsed${diagnostics.timeoutMs !== undefined ? ` of ${diagnostics.timeoutMs}ms timeout` : ""}.`);
    if (diagnostics.outputCaptured === false)
        lines.push("- App stdout/stderr: not captured by this wrapper launch path.");
    if (failure?.reason !== "aborted")
        lines.push("Retry guidance: increase electron.timeoutMs, try targetType:'any', pass an explicit appPath/executablePath, quit any already-running singleton instance, then retry launch.");
    return lines.join("\n");
}
export function buildElectronHostFailureResult(options) {
    const text = [options.errorText, formatElectronLaunchFailureDiagnostics(options.launchFailure), options.launchFailure?.cleanupError ? `Electron launch cleanup warning: ${options.launchFailure.cleanupError}` : undefined].filter((item) => item !== undefined && item.length > 0).join("\n");
    const details = { args: [], compiledElectron: options.compiledElectron, electron: { action: options.compiledElectron.action, error: options.errorText, failure: options.launchFailure, status: options.status ?? "failed" }, managedSessionOutcome: options.managedSessionOutcome, ...buildAgentBrowserResultCategoryDetails({ args: [], errorText: options.errorText, failureCategory: options.failureCategory, succeeded: false, timedOut: options.failureCategory === "timeout" }), summary: options.errorText };
    return { content: [{ type: "text", text: redactSensitiveText(text) }], details: redactToolDetails(details, []), isError: true };
}
export function formatElectronTargetLines(targets, limit = 8) {
    const shownTargets = targets.slice(0, limit);
    const lines = shownTargets.map((target) => {
        const label = [target.type, target.title].filter(Boolean).join(" ") || target.id || "target";
        return `- ${label}${target.url ? ` — ${target.url}` : ""}`;
    });
    if (targets.length > shownTargets.length)
        lines.push(`- ... ${targets.length - shownTargets.length} more target(s) omitted`);
    return lines;
}
const ELECTRON_PROFILE_ISOLATION_NOTE = "Profile note: electron.launch starts an isolated temporary profile; it does not reuse the app's normal signed-in profile or attach to an already-running authenticated app.";
const ELECTRON_EXISTING_AUTH_GUIDANCE = "For already-authenticated desktop app content, do not stop here: if host tools are allowed and the app is not running, launch the normal app with --remote-debugging-port=<port>, verify the port, then run agent_browser connect <port>; if it is already running without a debug port, ask before relaunching it.";
export function formatElectronLaunchText(options) {
    const lines = [`Electron launch: ${options.record.appName} attached as ${options.record.sessionName ?? "managed session"} (launchId ${options.record.launchId}, port ${options.record.port}).`, `Identifiers: launchId ${options.record.launchId} for electron.status/electron.cleanup/electron.probe; sessionName ${options.record.sessionName ?? "not attached"} for browser snapshot/tab commands.`, ELECTRON_PROFILE_ISOLATION_NOTE, ELECTRON_EXISTING_AUTH_GUIDANCE, ...formatElectronTargetLines(options.targets)];
    if (options.handoff?.handoff === "snapshot")
        lines.push(options.handoff.refSnapshot && options.handoff.refSnapshot.refIds.length > 0 ? `Snapshot handoff: ${options.handoff.refSnapshot.refIds.length} interactive ref(s)${options.handoff.snapshotRetryCount ? ` after ${options.handoff.snapshotRetryCount} retry attempt(s)` : ""}.` : "Snapshot handoff: no interactive refs returned after a short readiness retry; run snapshot -i once more before assuming the Electron UI is unusable.");
    else if (options.handoff?.handoff === "tabs")
        lines.push("Tabs handoff completed: safer diagnostic starting point; no interactive refs were captured.");
    else if (options.handoff?.handoff === "connect")
        lines.push("Connect handoff completed: run snapshot -i before using interactive refs.");
    lines.push(`Cleanup: use details.nextActions cleanup-electron-launch or call electron.cleanup with launchId ${options.record.launchId} when finished.`);
    if (options.handoff?.error)
        lines.push(`Handoff warning: ${options.handoff.error}`);
    if (options.upstreamText.trim().length > 0)
        lines.push("", options.upstreamText.trim());
    return lines.join("\n");
}
export function buildRedactedPresentationContent(options) {
    const { exactSensitiveValues, plainTextInspection, presentation, presentationEnvelope, succeeded, userRequestedJson, warningText } = options;
    const contentWithSessionWarnings = userRequestedJson && !plainTextInspection ? buildJsonVisibleContent({ error: presentationEnvelope?.error, presentation, succeeded, warnings: warningText ? [warningText] : undefined }) : warningText ? [...presentation.content] : presentation.content;
    if (warningText && !userRequestedJson) {
        if (contentWithSessionWarnings[0]?.type === "text")
            contentWithSessionWarnings[0] = { ...contentWithSessionWarnings[0], text: `${warningText}\n\n${contentWithSessionWarnings[0].text}` };
        else
            contentWithSessionWarnings.unshift({ type: "text", text: warningText });
    }
    return contentWithSessionWarnings.map((item) => {
        if (item.type !== "text")
            return item;
        const exactRedactedText = redactExactSensitiveText(item.text, exactSensitiveValues);
        return userRequestedJson && !plainTextInspection ? { ...item, text: exactRedactedText } : { ...item, text: redactSensitiveText(exactRedactedText) };
    });
}
export async function prepareFinalResultRecoveryState(options) {
    let { currentRefSnapshot, currentRefSnapshotInvalidation } = options;
    const categoryDetails = buildAgentBrowserResultCategoryDetails({ artifacts: options.presentation.artifacts, args: options.redactedProcessArgs, command: options.executionPlan.commandInfo.command, confirmationRequired: options.presentation.summary.startsWith("Confirmation required"), errorText: options.errorText ?? options.presentation.summary, failureCategory: options.presentation.failureCategory ?? options.presentation.batchFailure?.failedStep.failureCategory ?? (options.electronPostCommandHealth ? "tab-drift" : undefined), inspection: options.plainTextInspection, parseError: options.parseError, savedFile: options.presentation.savedFile, spawnError: options.processResult.spawnError?.message, succeeded: options.succeeded, tabDrift: !options.succeeded && (options.aboutBlankSessionMismatch !== undefined || options.electronPostCommandHealth !== undefined || options.sessionTabCorrection !== undefined), timedOut: options.processResult.timedOut, validationError: undefined });
    let visibleRefFallbackDiagnostic;
    const visibleRefFallbackSessionName = options.executionPlan.sessionName ?? extractExplicitSessionName(options.runtimeToolArgs);
    if (categoryDetails.failureCategory === "selector-not-found") {
        const selectorRecoveryCommandTokens = options.presentation.batchFailure?.failedStep.command ?? options.commandTokens;
        visibleRefFallbackDiagnostic = await collectVisibleRefFallbackDiagnostic({ commandTokens: selectorRecoveryCommandTokens, compiledSemanticAction: options.compiledSemanticAction, cwd: options.cwd, namespace: options.executionPlan.namespace, sessionName: visibleRefFallbackSessionName, signal: options.signal });
        const visibleRefFallbackSessionKey = getSessionContextKey(visibleRefFallbackSessionName, options.executionPlan.namespace);
        if (visibleRefFallbackDiagnostic && visibleRefFallbackSessionKey) {
            const refUpdate = options.sessionPageState.applyRefSnapshot({ fallbackTarget: options.currentSessionTabTarget, sessionName: visibleRefFallbackSessionKey, snapshot: visibleRefFallbackDiagnostic.snapshot, update: options.sessionPageStateUpdate });
            currentRefSnapshot = refUpdate.refSnapshot;
            currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
        }
    }
    const richInputRecoveryDiagnostic = buildRichInputRecoveryDiagnostic(visibleRefFallbackDiagnostic);
    const noActivePageSnapshotFailure = categoryDetails.resultCategory === "failure" && (isNoActivePageSnapshotFailure(options.executionPlan.commandInfo.command, options.errorText ?? options.presentation.summary) || options.batchRefSnapshotState?.invalidation?.reason === "no-active-page");
    const executionSessionKey = getSessionContextKey(options.executionPlan.sessionName, options.executionPlan.namespace);
    if (noActivePageSnapshotFailure && executionSessionKey) {
        const refUpdate = options.sessionPageState.applyRefSnapshotInvalidation({ invalidation: buildNoActivePageRefSnapshotInvalidation(), sessionName: executionSessionKey, update: options.sessionPageStateUpdate });
        currentRefSnapshot = refUpdate.refSnapshot;
        currentRefSnapshotInvalidation = refUpdate.refSnapshotInvalidation;
    }
    return { categoryDetails, currentRefSnapshot, currentRefSnapshotInvalidation, noActivePageSnapshotFailure, richInputRecoveryDiagnostic, visibleRefFallbackDiagnostic, visibleRefFallbackSessionName };
}
function buildTimeoutPartialProgressNextActions(options) {
    if (options.executionPlan.commandInfo.command === "session" && options.executionPlan.commandInfo.subcommand === "info")
        return [];
    const retry = options.timeoutPartialProgress?.retryStep?.retry;
    const stepIndex = options.timeoutPartialProgress?.retryStep?.index;
    const freshSessionAbandoned = options.sessionMode === "fresh" && options.timeoutPartialProgress?.liveUrlRecovered !== true;
    if (options.currentSessionTabTargetUnknown && !freshSessionAbandoned && options.executionPlan.sessionName) {
        return [{
                id: "verify-page-target-after-timeout",
                params: {
                    args: withOptionalSessionArgs(options.executionPlan.sessionName, ["batch", "--bail"]),
                    stdin: JSON.stringify([["get", "url"], ["snapshot", "-i"]]),
                },
                reason: `Verify the current URL, then inspect the page after timeout${stepIndex === undefined ? "" : ` before resuming from incomplete step ${stepIndex}`}.`,
                safety: "Fail-fast read-only recovery: snapshot runs only after get url succeeds, satisfying the wrapper page-target guard without trusting the planned URL.",
                tool: "agent_browser",
            }];
    }
    if (retry) {
        return [{
                id: "retry-timeout-step",
                params: freshSessionAbandoned
                    ? { ...retry, sessionMode: "fresh" }
                    : { ...retry, args: withOptionalSessionArgs(options.executionPlan.sessionName, retry.args) },
                reason: freshSessionAbandoned
                    ? `Retry the first incomplete timed-out step${stepIndex === undefined ? "" : ` ${stepIndex}`} in a fresh browser session because the timed-out fresh session was not proven live.`
                    : `Retry the first incomplete timed-out step${stepIndex === undefined ? "" : ` ${stepIndex}`} against the current browser session.`,
                safety: "Only read-only or idempotent timeout steps get executable retry args; inspect current page/artifact state before using the action.",
                tool: "agent_browser",
            }];
    }
    if (!options.timeoutPartialProgress || freshSessionAbandoned || !options.executionPlan.sessionName)
        return [];
    return [{
            id: "inspect-current-page-after-timeout",
            params: { args: withOptionalSessionArgs(options.executionPlan.sessionName, ["snapshot", "-i"]) },
            reason: `Inspect the current page after timeout before deciding how to resume${stepIndex === undefined ? "" : ` from incomplete step ${stepIndex}`}.`,
            safety: "Read details.timeoutPartialProgress first. Do not blindly retry mutating steps such as clicks, fills, key presses, selects, or checks; split the remaining flow into shorter batches around the next navigation or DOM mutation boundary.",
            tool: "agent_browser",
        }];
}
function buildDialogTimeoutNextActions(options) {
    if (options.command !== "dialog" && options.command !== "click" && options.command !== "tap" && options.command !== "find" && options.command !== "eval")
        return [];
    return [
        {
            id: "inspect-dialog-after-timeout",
            params: { args: withOptionalSessionArgs(options.sessionName, ["dialog", "status"]) },
            reason: "Check whether a blocking JavaScript dialog is pending after the timed-out interaction.",
            safety: "Read-only dialog status; this wrapper bounds dialog commands so recovery attempts do not wait for the full default watchdog.",
            tool: "agent_browser",
        },
        {
            id: "dismiss-dialog-after-timeout",
            params: { args: withOptionalSessionArgs(options.sessionName, ["dialog", "dismiss"]) },
            reason: "Dismiss a pending alert/confirm/prompt when the workflow can safely abandon the dialog.",
            safety: "Only run when dismissing/canceling the dialog is acceptable for the user flow.",
            tool: "agent_browser",
        },
        {
            id: "recover-fresh-session-after-dialog-timeout",
            params: { args: ["open", "about:blank"], sessionMode: "fresh" },
            reason: "Start a clean browser session if the current session remains blocked behind a JavaScript dialog.",
            safety: "Replace about:blank with the intended recovery URL; this abandons the blocked managed session.",
            tool: "agent_browser",
        },
    ];
}
function buildResultNextActions(options) {
    if (options.presentation.recordingRecovery || options.presentation.readConfirmation)
        return options.presentation.nextActions;
    let nextActions = options.presentation.nextActions ? [...options.presentation.nextActions] : [];
    const append = (actions) => {
        if (actions && actions.length > 0)
            nextActions.push(...actions);
    };
    const appendUnique = (actions) => {
        appendUniqueAgentBrowserNextActions(nextActions, actions);
    };
    if (options.unsettledWebMcpMutation && options.currentSessionTabTargetUnknown) {
        nextActions = nextActions.filter((action) => !isStandaloneSnapshotNextAction(action));
        appendUnique(buildPendingWebMcpNextActions(options.executionPlan.sessionName));
    }
    if (options.categoryDetails.resultCategory === "success" && options.executionPlan.commandInfo.command === "connect" && !options.electronLaunchRecord)
        appendUnique(buildConnectedSessionNextActions(options.executionPlan.sessionName));
    if (options.noActivePageSnapshotFailure)
        appendUnique(buildNoActivePageNextActions(options.executionPlan.sessionName));
    if (options.aboutBlankSessionMismatch) {
        appendUnique(buildSessionTabRecoveryNextActions({ kind: "about-blank", recoveryApplied: options.aboutBlankSessionMismatch.recoveryApplied, sessionName: options.executionPlan.sessionName, tabCorrection: options.aboutBlankSessionMismatch.recoveryApplied ? options.sessionTabCorrection : undefined, target: { title: options.aboutBlankSessionMismatch.targetTitle, url: options.aboutBlankSessionMismatch.targetUrl } }));
        if (!options.aboutBlankSessionMismatch.recoveryApplied)
            nextActions = nextActions.filter((action) => !isStandaloneSnapshotNextAction(action));
    }
    else if (options.categoryDetails.resultCategory === "success" && (options.sessionTabCorrection || options.openResultTabCorrection))
        appendUnique(buildSessionTabRecoveryNextActions({ kind: "tab-drift", recoveryApplied: true, sessionName: options.executionPlan.sessionName, tabCorrection: options.sessionTabCorrection ?? options.openResultTabCorrection, target: options.currentSessionTabTarget ?? options.priorSessionTabTarget }));
    if (options.categoryDetails.failureCategory === "stale-ref")
        nextActions = [...buildSessionAwareStaleRefNextActions(options.executionPlan.sessionName)];
    if (options.visibleRefFallbackDiagnostic)
        append(buildVisibleRefFallbackNextActions({ diagnostic: options.visibleRefFallbackDiagnostic, sessionName: options.visibleRefFallbackSessionName }));
    if (options.richInputRecoveryDiagnostic)
        append(buildRichInputRecoveryNextActions({ diagnostic: options.richInputRecoveryDiagnostic, sessionName: options.visibleRefFallbackSessionName }));
    if (options.electronPostCommandHealth) {
        const electronRecord = options.electronLaunchRecords.get(options.electronPostCommandHealth.launchId);
        if (electronRecord)
            appendUnique(buildElectronLifecycleNextActions(electronRecord));
    }
    if (options.electronSessionMismatch) {
        const electronRecord = options.electronLaunchRecords.get(options.electronSessionMismatch.launchId);
        if (electronRecord)
            appendUnique(buildElectronMismatchNextActions(electronRecord, options.electronSessionMismatch.liveTarget));
    }
    if (options.categoryDetails.failureCategory === "selector-not-found" && options.redactedCompiledSemanticAction) {
        const candidateActions = buildSemanticActionCandidateActions(options.redactedCompiledSemanticAction);
        if (candidateActions.length > 0)
            append(candidateActions);
    }
    if (options.overlayBlockerDiagnostic)
        append(buildOverlayBlockerNextActions({ diagnostic: options.overlayBlockerDiagnostic, sessionName: options.executionPlan.sessionName }));
    if (options.fillVerificationDiagnostic)
        appendUnique(buildFillVerificationNextActions(options.fillVerificationDiagnostic, options.executionPlan.sessionName));
    if (options.electronRefFreshnessDiagnostic)
        appendUnique(buildElectronRefFreshnessNextActions(options.executionPlan.sessionName));
    if (options.selectorTextVisibilityDiagnostics.length > 0)
        append(buildSelectorTextVisibilityNextActions({ diagnostics: options.selectorTextVisibilityDiagnostics, sessionName: options.executionPlan.sessionName }));
    if (options.electronBroadGetTextScopeDiagnostics.length > 0)
        append(buildElectronBroadGetTextScopeNextActions({ diagnostics: options.electronBroadGetTextScopeDiagnostics, sessionName: options.executionPlan.sessionName }));
    if (options.sourceLookup?.electronContext)
        appendUnique(buildSourceLookupElectronNextActions(options.sourceLookup));
    if (options.clickDispatchDiagnostic)
        append(buildClickDispatchNextActions({ commandTokens: options.commandTokens, diagnostic: options.clickDispatchDiagnostic, sessionName: options.executionPlan.sessionName }));
    if (options.scrollNoopDiagnostic)
        append(buildScrollNoopNextActions(options.executionPlan.sessionName));
    if (options.comboboxFocusDiagnostic)
        append(buildComboboxFocusNextActions(options.executionPlan.sessionName));
    if (options.managedSessionOutcome)
        appendUnique(buildManagedSessionFreshFailureNextActions(options.managedSessionOutcome));
    if (options.categoryDetails.failureCategory === "timeout" && options.processResult.timedOut) {
        if (options.currentSessionTabTargetUnknown)
            nextActions = nextActions.filter((action) => !isStandaloneSnapshotNextAction(action));
        appendUnique(buildTimeoutPartialProgressNextActions(options));
        appendUnique(buildDialogTimeoutNextActions({ command: options.executionPlan.commandInfo.command, sessionName: options.executionPlan.sessionName }));
    }
    if (options.categoryDetails.failureCategory === "stale-ref" && options.redactedCompiledSemanticAction && isCompiledSemanticActionFindCommand(options.compiledSemanticAction))
        append([{ id: "retry-semantic-action-after-stale-ref", params: { args: options.redactedCompiledSemanticAction.args }, reason: "Retry the same semantic target via its compiled find command after the upstream stale-ref failure proves the prior action did not execute.", safety: "Use only for the same intended target; direct stale @refs still require a fresh snapshot or stable locator before retrying.", tool: "agent_browser" }]);
    if (options.electronLaunchRecord)
        append(buildAgentBrowserNextActions({ electron: { launchId: options.electronLaunchRecord.launchId, sessionName: options.electronLaunchRecord.sessionName, status: options.electronLaunchRecord.cleanupState }, failureCategory: options.categoryDetails.failureCategory, resultCategory: options.categoryDetails.resultCategory, successCategory: options.categoryDetails.successCategory }));
    return nextActions.length > 0 ? nextActions : undefined;
}
export function formatAgentBrowserNextActionsText(nextActions, limit = 6) {
    if (!nextActions || nextActions.length === 0)
        return undefined;
    const lines = nextActions.slice(0, limit).map((action) => {
        const params = action.params
            ? { ...action.params, ...(action.params.stdin !== undefined && action.params.stdin.length > 500 ? { stdin: "[omitted; use details.nextActions]" } : {}) }
            : undefined;
        const payload = action.artifactPath ? { artifactPath: action.artifactPath } : params;
        return `- ${action.id}${payload ? ` ${redactSensitiveText(JSON.stringify(payload))}` : ""}: ${redactSensitiveText(action.reason)}`;
    });
    return ["Next actions:", ...lines, "The same redacted payloads are available in details.nextActions."].join("\n");
}
// local patch: render the new modes' reports into model-visible text, not only into `details`
// (PATCHES.md P16-P19). The debug report leads, because for that mode the report *is* the answer.
function formatDebugReportText(report) {
    if (!report || typeof report !== "object") {
        return undefined;
    }
    const lines = ["Debug report:"];
    if (report.summary)
        lines.push(`- ${report.summary}`);
    if (report.url)
        lines.push(`- url: ${report.url}`);
    if (report.title)
        lines.push(`- title: ${report.title}`);
    if (report.counts && typeof report.counts === "object")
        lines.push(`- counts: ${Object.entries(report.counts).map(([key, value]) => `${key}=${value}`).join(", ")}`);
    if (Array.isArray(report.failedRequests) && report.failedRequests.length > 0) {
        lines.push(`- failed requests (${report.failedRequests.length}): ${report.failedRequests.slice(0, 5).map((row) => `${row?.status ?? "ERR"} ${row?.method ?? ""} ${row?.url ?? ""}`.trim()).join("; ")}`);
    }
    if (report.expectedTextMissing)
        lines.push("- expected text was not found after the requested load state");
    if (report.expectedSelectorMissing)
        lines.push("- expected selector was not found after the requested load state");
    if (report.evalResult !== undefined)
        lines.push(`- eval: ${JSON.stringify(report.evalResult).slice(0, 300)}`);
    return lines.join("\n");
}
function formatSettleReportText(report) {
    return report?.summary ? `Settle: ${report.summary}` : undefined;
}
function formatNetworkBodyText(result) {
    if (!result || typeof result !== "object") {
        return undefined;
    }
    if (Array.isArray(result.bodies) && result.bodies.length > 0) {
        const described = result.bodies.map((body) => `${body.direction ?? "body"} ${body.chars ?? 0} chars${body.truncated ? " (truncated)" : ""}`).join(", ");
        return `Network body: ${described}`;
    }
    return `Network body: ${result.missingReason ?? "no body available for this row"}`;
}

function formatFailureNextActionsText(options, nextActions) {
    if (!shouldAppendNextActionText(options.verbosity)) {
        return undefined;
    }
    // local patch: `verbose` now has one real, testable effect - every suggested action is listed instead
    // of the default six (P14).
    const limit = shouldAppendDetailedSections(options.verbosity) ? 25 : 6;
    return options.categoryDetails.resultCategory === "failure" ? formatAgentBrowserNextActionsText(nextActions, limit) : undefined;
}
// local patch: bounded audit echo for script mode (PATCHES.md P18). The wrapper previously stored no
// trace of the most powerful input mode, so a transcript could not be audited for what actually ran.
function buildCompiledScriptSummary(compiledScript) {
    if (!compiledScript || typeof compiledScript.code !== "string") {
        return undefined;
    }
    const code = compiledScript.code;
    return {
        bytes: Buffer.byteLength(code, "utf8"),
        lineCount: code.split("\n").length,
        preview: code.slice(0, 500),
        previewTruncated: code.length > 500,
        sha256: createHash("sha256").update(code, "utf8").digest("hex"),
    };
}
// local patch: when revealSecrets is active, the wrapper must not retain a spill file that could contain
// the revealed header value (PATCHES.md P13).
function suppressRevealedSpills(details) {
    const paths = [];
    for (const key of ["fullOutputPath", "fullOutputPaths"]) {
        const value = details[key];
        if (typeof value === "string") {
            paths.push(value);
        }
        else if (Array.isArray(value)) {
            paths.push(...value.filter((item) => typeof item === "string"));
        }
    }
    for (const path of paths) {
        try {
            rmSync(path, { force: true });
        }
        catch { /* best effort: the model-visible reference is removed either way */ }
    }
    if (paths.length > 0) {
        delete details.fullOutputPath;
        delete details.fullOutputPaths;
        return true;
    }
    return false;
}
function getReadSource(options) {
    return options.executionPlan.commandInfo.command === "read" && isRecord(options.presentationEnvelope?.data) && typeof options.presentationEnvelope.data.source === "string"
        ? options.presentationEnvelope.data.source
        : undefined;
}
function formatReadExecutionText(options, lifecycle) {
    const source = getReadSource(options);
    if (!source)
        return undefined;
    return `Read execution: source ${source}; CLI started: ${options.processResult.agentBrowserStarted ? "yes" : "no"}; reported browserLaunched: ${lifecycle ? String(lifecycle.effectiveLaunch.browserLaunched) : "unknown"}; managed session outcome: ${options.managedSessionOutcome?.status ?? "not managed"}. An HTTP read does not establish shared-browser liveness; use session info for that.`;
}
function buildBrowserWindowStatus(options, lifecycle) {
    if (!options.headedLaunch || options.preserveAttachedBrowserSession || options.providerLaunch || !options.succeeded || lifecycle?.effectiveLaunch.browserLaunched !== true || !options.executionPlan.managedSessionName || !options.managedSessionOutcome || !["created", "replaced"].includes(options.managedSessionOutcome.status))
        return undefined;
    return { mode: "headed", ownership: "wrapper-managed", sessionName: options.executionPlan.managedSessionName, visibility: "unverified" };
}
function formatBrowserWindowText(browserWindow) {
    if (!browserWindow)
        return undefined;
    return "Headed browser handoff: wrapper-managed headed window requested; desktop visibility unverified. If login is needed, ask the user to confirm they can see the window and finish signing in there, then continue with sessionMode auto.";
}
function buildAgentBrowserResultDetails(options, nextActions) {
    const lifecycle = extractAgentBrowserLifecycle(options.presentationEnvelope?.data);
    const browserWindow = buildBrowserWindowStatus(options, lifecycle);
    const publicVisibleRefFallbackDiagnostic = options.visibleRefFallbackDiagnostic ? sanitizeVisibleRefFallbackDiagnostic(options.visibleRefFallbackDiagnostic) : undefined;
    const rawPageChangeSummary = (options.scrollNoopDiagnostic || options.comboboxFocusDiagnostic) && options.presentation.pageChangeSummary ? { ...options.presentation.pageChangeSummary, nextActionIds: nextActions?.map((action) => action.id) } : options.presentation.pageChangeSummary;
    const pageChangeSummary = alignPageChangeSummaryNextActionIds(rawPageChangeSummary, nextActions);
    return {
        args: options.redactedArgs,
        compiledElectron: options.redactedCompiledElectron,
        compiledJob: options.redactedCompiledJob,
        compiledQaPreset: options.redactedCompiledQaPreset,
        compiledSourceLookup: options.redactedCompiledSourceLookup,
        compiledNetworkSourceLookup: options.redactedCompiledNetworkSourceLookup,
        artifactManifest: options.resultArtifactManifest,
        artifactRetentionSummary: options.presentation.artifactRetentionSummary ?? (options.resultArtifactManifest ? formatSessionArtifactRetentionSummary(options.resultArtifactManifest) : undefined),
        artifactCleanup: options.artifactCleanup,
        artifactVerification: options.presentation.artifactVerification,
        artifacts: options.presentation.artifacts,
        batchFailure: options.presentation.batchFailure,
        batchSteps: options.presentation.batchSteps,
        command: options.executionPlan.commandInfo.command,
        compiledSemanticAction: options.redactedCompiledSemanticAction,
        compatibilityWorkaround: options.compatibilityWorkaround,
        subcommand: options.executionPlan.commandInfo.subcommand,
        data: options.presentation.data,
        error: options.plainTextInspection ? undefined : options.presentationEnvelope?.error,
        inspection: options.plainTextInspection || undefined,
        navigationSummary: options.navigationSummary,
        electron: options.electronLaunchRecord ? { action: "launch", cleanup: options.electronFailedConnectCleanup, handoff: options.electronHandoff, identifiers: buildElectronIdentifiers(options.electronLaunchRecord), launch: options.electronLaunchRecord, profileIsolation: options.electronProfileIsolationDetails, status: options.succeeded ? "succeeded" : "failed", targets: options.electronLaunch?.targets, version: options.electronLaunch?.version } : undefined,
        ...options.categoryDetails,
        agentBrowserStarted: options.processResult.agentBrowserStarted,
        browserWindow,
        lifecycle,
        readSource: getReadSource(options),
        recordingRecovery: options.presentation.recordingRecovery,
        readConfirmation: options.presentation.readConfirmation,
        aboutBlankSessionMismatch: options.aboutBlankSessionMismatch,
        electronPostCommandHealth: options.electronPostCommandHealth,
        electronRefFreshness: options.electronRefFreshnessDiagnostic,
        electronSessionMismatch: options.electronSessionMismatch,
        openResultTabCorrection: options.openResultTabCorrection,
        effectiveArgs: options.redactedProcessArgs,
        exitCode: options.processResult.exitCode,
        fullOutputPath: options.parseFailureOutput.fullOutputPath ?? options.presentation.fullOutputPath,
        fullOutputPaths: options.presentation.fullOutputPaths,
        fullOutputUnavailable: options.parseFailureOutput.fullOutputUnavailable,
        managedSessionHeadedAutosaveDisabled: options.managedSessionHeadedAutosaveDisabled,
        managedSessionHeadedAutosaveInterval: options.managedSessionHeadedAutosaveInterval,
        managedSessionOutcome: options.managedSessionOutcome,
        imagePath: options.presentation.imagePath,
        imagePaths: options.presentation.imagePaths,
        nextActions,
        pageChangeSummary,
        clickDispatch: options.clickDispatchDiagnostic,
        overlayBlockers: options.overlayBlockerDiagnostic,
        fillVerification: options.fillVerificationDiagnostic,
        visibleRefFallback: publicVisibleRefFallbackDiagnostic,
        richInputRecovery: options.richInputRecoveryDiagnostic,
        comboboxFocus: options.comboboxFocusDiagnostic,
        recordingDependencyWarning: options.recordingDependencyWarning,
        geolocationStubNote: options.geolocationStubNote,
        scrollNoop: options.scrollNoopDiagnostic,
        qaPreset: options.qaPreset,
        qaAttachedTarget: options.qaAttachedTarget,
        electronGetTextScopeWarning: options.electronBroadGetTextScopeDiagnostics[0],
        electronGetTextScopeWarnings: options.electronBroadGetTextScopeDiagnostics.length > 1 ? options.electronBroadGetTextScopeDiagnostics : undefined,
        selectorTextVisibility: options.selectorTextVisibilityDiagnostics[0],
        selectorTextVisibilityAll: options.selectorTextVisibilityDiagnostics.length > 1 ? options.selectorTextVisibilityDiagnostics : undefined,
        evalStdinHint: options.evalStdinHint,
        evalResultWarning: options.evalResultWarning,
        timeoutPartialProgress: options.timeoutPartialProgress,
        parseError: options.plainTextInspection ? undefined : options.parseError,
        savedFile: options.presentation.savedFile,
        savedFilePath: options.presentation.savedFilePath,
        sourceLookup: options.sourceLookup,
        networkSourceLookup: options.networkSourceLookup,
        networkRouteDiagnostics: options.presentation.networkRouteDiagnostics,
        sessionMode: options.sessionMode,
        sessionTabCorrection: options.sessionTabCorrection,
        sessionTabTarget: options.currentSessionTabTarget,
        sessionTabTargetUnknown: options.currentSessionTabTargetUnknown,
        refSnapshot: options.currentRefSnapshot,
        refSnapshotInvalidation: options.currentRefSnapshotInvalidation,
        namespace: options.executionPlan.namespace,
        ...buildSessionDetailFields(options.executionPlan.sessionName, options.executionPlan.usedImplicitSession, options.executionPlan.namespace, options.managedSessionRestoreDisabled),
        sessionRecoveryHint: options.redactedRecoveryHint,
        startupScopedFlags: options.executionPlan.startupScopedFlags,
        stderr: options.processResult.stderr,
        stdout: options.plainTextInspection ? options.inspectionText ?? "" : undefined,
        summary: options.presentation.summary,
        timedOut: options.processResult.timedOut || undefined,
        timeoutMs: options.processResult.timeoutMs,
        // local patch: new input-mode echoes + transparency fields (PATCHES.md P13-P22).
        compiledDebug: options.compiledDebug,
        compiledLogin: options.compiledLogin,
        compiledNetworkBody: options.compiledNetworkBody,
        compiledScript: buildCompiledScriptSummary(options.compiledScript),
        compiledSettle: options.compiledSettle ? { args: options.compiledSettle.args, budget: options.compiledSettle.budget } : undefined,
        compiledVault: options.compiledVault,
        debugReport: options.debugReport,
        login: options.login,
        networkBody: options.networkBody,
        revealSecrets: options.revealSecretsApplied,
        settleReport: options.settleReport,
        vault: options.vault,
        verbosity: options.verbosity && options.verbosity !== "normal" ? options.verbosity : undefined,
    };
}
export function buildFinalAgentBrowserToolResult(options) {
    const nextActions = applyNamespaceToNextActions(buildResultNextActions(options), options.executionPlan.namespace);
    const lifecycle = extractAgentBrowserLifecycle(options.presentationEnvelope?.data);
    const browserWindow = buildBrowserWindowStatus(options, lifecycle);
    const details = buildAgentBrowserResultDetails(options, nextActions);
    const visibleRefFallbackText = formatVisibleRefFallbackText(options.visibleRefFallbackDiagnostic);
    const richInputRecoveryText = formatRichInputRecoveryText(options.richInputRecoveryDiagnostic);
    const semanticActionCandidateText = nextActions ? formatSemanticActionCandidateText(nextActions) : undefined;
    const clickDispatchText = options.clickDispatchDiagnostic ? formatClickDispatchDiagnosticText(options.clickDispatchDiagnostic) : undefined;
    const overlayBlockerText = options.overlayBlockerDiagnostic ? formatOverlayBlockerText(options.overlayBlockerDiagnostic) : undefined;
    const fillVerificationText = formatFillVerificationText(options.fillVerificationDiagnostic);
    const electronRefFreshnessText = formatElectronRefFreshnessText(options.electronRefFreshnessDiagnostic);
    const selectorTextVisibilityText = formatSelectorTextVisibilityText(options.selectorTextVisibilityDiagnostics);
    const electronBroadGetTextScopeText = formatElectronBroadGetTextScopeText(options.electronBroadGetTextScopeDiagnostics);
    const scrollNoopDiagnosticText = formatScrollNoopDiagnosticText(options.scrollNoopDiagnostic);
    const comboboxFocusDiagnosticText = formatComboboxFocusDiagnosticText(options.comboboxFocusDiagnostic);
    const recordingDependencyWarningText = formatRecordingDependencyWarningText(options.recordingDependencyWarning);
    // local patch: `set geo` needs a page-level stub to be visible to the page (see geolocation-stub.js).
    const geolocationStubNoteText = typeof options.geolocationStubNote === "string" && options.geolocationStubNote.length > 0 ? options.geolocationStubNote : undefined;
    const evalStdinHintText = formatEvalStdinHintText(options.evalStdinHint);
    const evalResultWarningText = formatEvalResultWarningText(options.evalResultWarning);
    const artifactCleanupText = formatArtifactCleanupGuidanceText(options.artifactCleanup);
    const timeoutPartialProgressText = options.timeoutPartialProgress ? formatTimeoutPartialProgressText(options.timeoutPartialProgress, options.currentSessionTabTargetUnknown === true && !(options.sessionMode === "fresh" && options.timeoutPartialProgress.liveUrlRecovered !== true)) : undefined;
    const managedSessionOutcomeText = formatManagedSessionOutcomeText(options.managedSessionOutcome);
    const readExecutionText = formatReadExecutionText(options, lifecycle);
    const browserWindowText = formatBrowserWindowText(browserWindow);
    const failureNextActionsText = formatFailureNextActionsText(options, nextActions);
    const rawAppendedDiagnosticText = [formatDebugReportText(options.debugReport), formatSettleReportText(options.settleReport), formatNetworkBodyText(options.networkBody), visibleRefFallbackText, richInputRecoveryText, semanticActionCandidateText, clickDispatchText, overlayBlockerText, fillVerificationText, electronRefFreshnessText, selectorTextVisibilityText, electronBroadGetTextScopeText, scrollNoopDiagnosticText, comboboxFocusDiagnosticText, recordingDependencyWarningText, geolocationStubNoteText, evalStdinHintText, evalResultWarningText, artifactCleanupText, timeoutPartialProgressText, managedSessionOutcomeText, readExecutionText, browserWindowText, failureNextActionsText].filter((item) => item !== undefined).join("\n\n");
    const appendedDiagnosticText = redactSensitiveText(redactExactSensitiveText(rawAppendedDiagnosticText, options.exactSensitiveValues));
    // local patch: verbosity gates diagnostic prose only, never structure (PATCHES.md P14).
    const shouldAppendDiagnosticText = appendedDiagnosticText.length > 0 && shouldAppendDiagnosticBlocks(options.verbosity) && (!options.userRequestedJson || options.plainTextInspection);
    let content = shouldAppendDiagnosticText && options.redactedContent[0]?.type === "text" ? [{ ...options.redactedContent[0], text: `${options.redactedContent[0].text}\n\n${appendedDiagnosticText}` }, ...options.redactedContent.slice(1)] : options.redactedContent;
    if (options.electronLaunchRecord && options.succeeded && content[0]?.type === "text") {
        content = [{ ...content[0], text: redactSensitiveText(formatElectronLaunchText({ handoff: options.electronHandoff, record: options.electronLaunchRecord, targets: options.electronLaunch?.targets ?? [], upstreamText: content[0].text })) }, ...content.slice(1)];
    }
    let result = { content, details: redactToolDetails(details, options.exactSensitiveValues), isError: !options.succeeded };
    // local patch: explicit secret reveal (PATCHES.md P13). The warning is appended after the ordinary
    // redaction pass on purpose: it reports what was revealed without re-exposing the value itself.
    if (options.revealSecrets) {
        const spillRemoved = suppressRevealedSpills(result.details);
        const warning = buildRevealSecretsWarning(options.revealSecrets, { matchedRows: options.revealSecretsMatchedRows ?? 0 });
        const revealedLines = Array.isArray(options.revealedHeaderLines) ? options.revealedHeaderLines : [];
        const notice = [warning, spillRemoved ? "A spill file from this call was deleted before the result was returned." : undefined, revealedLines.length > 0 ? "Revealed value(s):" : undefined, ...revealedLines].filter((line) => line !== undefined).join("\n");
        result = {
            ...result,
            content: result.content.length > 0 && result.content[0]?.type === "text"
                ? [{ ...result.content[0], text: `${result.content[0].text}\n\n${notice}` }, ...result.content.slice(1)]
                : [{ type: "text", text: notice }, ...result.content],
            details: {
                ...result.details,
                revealSecrets: describeRevealSecrets(options.revealSecrets, {
                    applied: true,
                    matchedRows: options.revealSecretsMatchedRows ?? 0,
                    spillSuppressed: spillRemoved,
                }),
            },
        };
    }
    // local patch: scrub every registered vault secret by exact value, last, so no path (content, details,
    // spill reference, batch echo) can echo a credential the wrapper itself typed into the page (PATCHES.md P12).
    if (result.details) {
        result = { ...result, details: scrubVaultSecretValues({ ...result.details, ...(result.details.revealSecrets ? { revealSecrets: result.details.revealSecrets } : {}) }) };
    }
    result = { ...result, content: result.content.map((item) => (item.type === "text" ? { ...item, text: scrubVaultSecrets(item.text) } : item)) };
    return options.compiledNetworkSourceLookup ? redactNetworkSourceLookupSurface(result) : result;
}
export function isMissingAgentBrowserBinary(processResult) {
    return processResult.spawnError?.message.includes("ENOENT") === true;
}
export async function buildMissingBinaryFailureResult(options) {
    if (!isMissingAgentBrowserBinary(options.processResult))
        return undefined;
    const spawnError = options.processResult.spawnError.message;
    const errorText = buildMissingBinaryMessage();
    const managedSessionOutcome = buildManagedSessionOutcome({ activeAfter: options.managedSessionActive, activeBefore: options.managedSessionActive, attemptedSessionName: options.executionPlan.managedSessionName, command: options.executionPlan.commandInfo.command, currentSessionName: options.managedSessionName, currentSessionNamespace: options.managedSessionNamespace, previousSessionName: options.managedSessionName, sessionMode: options.sessionMode, succeeded: false });
    const managedSessionOutcomeText = formatManagedSessionOutcomeText(managedSessionOutcome);
    const managedSessionRecoveryNextActions = applyNamespaceToNextActions(buildManagedSessionFreshFailureNextActions(managedSessionOutcome), options.executionPlan.namespace) ?? [];
    let missingBinaryElectronCleanup;
    let missingBinaryElectronRecord;
    if (options.electronLaunch) {
        missingBinaryElectronCleanup = await cleanupElectronLaunchResources({ child: options.electronLaunch.child, record: options.electronLaunch.record, timeoutMs: options.implicitSessionCloseTimeoutMs });
        missingBinaryElectronRecord = missingBinaryElectronCleanup.record;
    }
    const textParts = [errorText, managedSessionOutcomeText, missingBinaryElectronCleanup ? `Electron cleanup after failed attach: ${missingBinaryElectronCleanup.summary}` : undefined].filter((part) => part !== undefined && part.length > 0);
    return { content: [{ type: "text", text: textParts.join("\n\n") }], details: { agentBrowserStarted: options.processResult.agentBrowserStarted, args: options.redactedArgs, compatibilityWorkaround: options.compatibilityWorkaround, effectiveArgs: options.redactedProcessArgs, electron: missingBinaryElectronRecord ? { action: "launch", cleanup: missingBinaryElectronCleanup, launch: missingBinaryElectronRecord, status: "failed", targets: options.electronLaunch?.targets, version: options.electronLaunch?.version } : undefined, managedSessionOutcome, namespace: options.executionPlan.namespace, nextActions: managedSessionRecoveryNextActions.length > 0 ? managedSessionRecoveryNextActions : undefined, sessionMode: options.sessionMode, sessionTabCorrection: options.sessionTabCorrection, ...buildAgentBrowserResultCategoryDetails({ args: options.redactedProcessArgs, command: options.executionPlan.commandInfo.command, errorText, failureCategory: "missing-binary", spawnError, succeeded: false }), spawnError }, isError: true };
}
