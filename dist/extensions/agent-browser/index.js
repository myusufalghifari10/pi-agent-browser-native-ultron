import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Text } from "@earendil-works/pi-tui";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "./lib/batch-lifecycle.js";
import { PROJECT_RULE_PROMPT, buildBrowserDefaultProfileGuideline, buildBrowserExecutablePathGuideline, buildToolPromptGuidelines, } from "./lib/playbook.js";
import { SessionPageState } from "./lib/session-page-state.js";
import { buildExecutionPlan, canUseHeadlessCompatibilityUserAgent, createEphemeralSessionSeed, createFreshSessionName, createImplicitSessionName, extractUpstreamCommandTokens, getImplicitSessionCloseTimeoutMs, getImplicitSessionIdleTimeoutMs, isRestorableManagedSessionName, restoreManagedSessionStateFromBranch, validateToolArgs, redactSensitiveText, redactSensitiveValue, isPlainTextInspectionArgs, } from "./lib/runtime.js";
import { deleteIdentityKeysInNamespace, extractExplicitNamespace, extractExplicitSessionName, getAgentBrowserSessionIdentityKey, isAgentBrowserSessionIdentityKeyInNamespace, isUpstreamEnvFlagEnabled, resolveAgentBrowserNamespace } from "./lib/argv-grammar.js";
import { parseArgvDescriptor } from "./lib/argv-descriptor.js";
import { needsManagedSession } from "./lib/command-policy.js";
import { ManagedSessionRestoreState } from "./lib/managed-session-restore.js";
import { isRecord } from "./lib/parsing.js";
import { runAgentBrowserProcess } from "./lib/process.js";
import { getAgentBrowserProcessEnvironment, withIsolatedAgentBrowserEnvironment } from "./lib/process-environment.js";
import { withNativeSessionDefaults } from "./lib/orchestration/native-session-defaults.js";
import { MINIMUM_AGENT_BROWSER_VERSION, SUPPORTED_AGENT_BROWSER_VERSION_LABEL, TARGET_AGENT_BROWSER_VERSION, getAgentBrowserVersionValidationError, parseAgentBrowserVersionOutput, } from "./lib/upstream-version.js";
import { buildPromptPolicy, getLatestUserPrompt, shouldAppendBrowserSystemPrompt } from "./lib/prompt-policy.js";
import { isCloseAllCommand, isCloseCommand } from "./lib/command-taxonomy.js";
import { hasLaunchScopedFlagToken } from "./lib/launch-scoped-flags.js";
import { cleanupSecureTempArtifacts } from "./lib/temp.js";
import { AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS, AGENT_BROWSER_SCRIPT_NAMESPACE, createAgentBrowserScriptSessionName, isAgentBrowserScriptSessionName, runAgentBrowserScript, } from "./lib/input-modes/script.js";
import { closeManagedSession, getSessionContextKey, runAgentBrowserTool } from "./lib/orchestration/browser-run/index.js";
import { canonicalizeExplicitArtifactDestination, getExplicitArtifactDestination } from "./lib/orchestration/browser-run/artifact-paths.js";
import { findElectronLaunchRecordForSession, getActiveElectronRecords } from "./lib/orchestration/browser-run/session-state.js";
import { parseBatchCommandArgument, parseUserBatchStdin } from "./lib/orchestration/batch-stdin.js";
import { ELECTRON_POST_COMMAND_STATUS_SETTLE_MS, ELECTRON_PROFILE_ISOLATION_DETAILS, cleanupActiveElectronHostLaunches, handleElectronHostInput, restoreElectronLaunchRecordsFromBranch, } from "./lib/orchestration/electron-host/index.js";
import { buildValidationFailureResult, resolveAgentBrowserInput } from "./lib/orchestration/input-plan.js";
import { applyAgentBrowserOutputPath, canWriteAgentBrowserOutput, normalizeRequestedOutputPath } from "./lib/orchestration/output-file.js";
import { appendScriptSessionLease, buildScriptBrowserEnvelope, buildScriptToolResult, getScriptSessionLeasesFromBranch } from "./lib/orchestration/script-mode.js";
import { handleDevServerHostInput, stopAllDevServers } from "./lib/orchestration/dev-server-host/handler.js";
import { handleLoginHostInput } from "./lib/orchestration/login-host/index.js";
import { clearVaultUnlockSession, handleVaultHostInput } from "./lib/orchestration/vault-host/index.js";
// local patch (wave14): the raw CDP escape hatch. It is host-only like vault/login/devServer, so it
// runs inline in the tool executor and reuses hostDispatch for the one spawn it needs (`get cdp-url`),
// which keeps session handling, redaction and the patch ledger on that path.
import { handleCdpHostInput } from "./lib/orchestration/cdp-host/index.js";
import { clearVaultSecrets } from "./lib/vault/secret-registry.js";
import { formatSessionArtifactRetentionSummary, getSessionArtifactManifestEntryKey, isPendingRecordingCommand, isSessionArtifactManifest, mergeSessionArtifactManifest, retirePendingRecordingManifestEntries } from "./lib/results/artifact-manifest.js";
import { appendUniqueAgentBrowserNextActions, applyNamespaceToNextActions, applySessionToNextActions, buildNextToolAction } from "./lib/results/next-actions.js";
import { canRegisterWebSearchTool, loadAgentBrowserConfigSync } from "./lib/config.js";
import { appendRecordingReservationTransition, applyRecordingArtifactsToReservations, restoreRecordingReservationStateFromBranch, retireRecordingReservation, } from "./lib/recording-reservations.js";
import { createAgentBrowserWebSearchTool } from "./lib/web-search.js";
import { scopeReadConfirmationArgs } from "./lib/read-confirmation.js";
import { isDirectAgentBrowserBashAllowed, isHarmlessAgentBrowserInspectionCommand, looksLikeDirectAgentBrowserBash, } from "./lib/bash-guard.js";
import { AgentBrowserResultComponent, buildAgentBrowserToolResultPatch, formatAgentBrowserRenderCall, formatAgentBrowserRenderResult, } from "./lib/pi-tool-rendering.js";
function isBashToolCallEvent(event) {
    if (!isRecord(event) || event.toolName !== "bash" || !isRecord(event.input))
        return false;
    return typeof event.input.command === "string";
}
function getArtifactCommandSteps(args, stdin) {
    const commandTokens = extractUpstreamCommandTokens(args);
    const batch = commandTokens[0] === "batch";
    if (!batch)
        return { batch, steps: commandTokens.length > 0 ? [commandTokens] : [] };
    const steps = [];
    for (const command of commandTokens.slice(1)) {
        if (command === "--bail")
            continue;
        const parsed = parseBatchCommandArgument(command);
        if (parsed.error || !parsed.step)
            return { batch, error: `Unsupported batch step ${steps.length + 1}: ${parsed.error ?? "command could not be parsed safely"}`, steps };
        steps.push(parsed.step);
    }
    // Upstream executes raw argument steps exclusively when any exist, so ignored
    // stdin must not add artifact/lifecycle steps or fail this preflight.
    if (steps.length > 0)
        return { batch, steps };
    const parsed = parseUserBatchStdin(stdin);
    return parsed.error ? { batch, error: parsed.error, steps } : { batch, steps: parsed.steps ?? [] };
}
function getArtifactPreflightValidationError(options) {
    const { batch, error, steps } = getArtifactCommandSteps(options.args, options.stdin);
    if (error)
        return error;
    const activeRecordingDestinations = new Set();
    const cleanupOnly = steps.length > 0 && steps.every((step) => {
        const [command, subcommand] = step;
        return isCloseCommand(command) || (command === "record" && subcommand === "stop");
    });
    for (const reservation of options.activeRecordingReservations ?? []) {
        try {
            activeRecordingDestinations.add(canonicalizeExplicitArtifactDestination(reservation.cwd, reservation.absolutePath));
        }
        catch (canonicalizationError) {
            if (!cleanupOnly)
                return canonicalizationError instanceof Error ? canonicalizationError.message : "An active recording destination could not be resolved safely.";
        }
    }
    let canonicalOutputPath;
    if (options.outputPath) {
        try {
            canonicalOutputPath = canonicalizeExplicitArtifactDestination(options.cwd, normalizeRequestedOutputPath(options.outputPath));
            if (activeRecordingDestinations.has(canonicalOutputPath)) {
                return `Unsupported outputPath: ${options.outputPath} is reserved by an active recording. Stop that recording first or use a distinct path.`;
            }
        }
        catch (canonicalizationError) {
            return canonicalizationError instanceof Error ? canonicalizationError.message : `outputPath ${options.outputPath} could not be resolved safely.`;
        }
    }
    const artifactDestinations = new Map();
    let sawBatchClose = false;
    for (const [index, commandStep] of steps.entries()) {
        if (batch) {
            const stepValidationError = validateToolArgs(commandStep, { batchStep: true });
            if (stepValidationError)
                return `Unsupported batch step ${index + 1}: ${stepValidationError}`;
            if (sawBatchClose && commandStep[0] === "record" && (commandStep[1] === "start" || commandStep[1] === "restart")) {
                return `Unsupported batch step ${index + 1}: record ${commandStep[1]} cannot follow close, quit, or exit in one upstream batch because upstream can report success without starting a recording. Split the close and recording into separate agent_browser calls.`;
            }
            if (isCloseCommand(commandStep[0]))
                sawBatchClose = true;
        }
        const artifactDestination = getExplicitArtifactDestination(commandStep);
        if (artifactDestination) {
            let canonicalDestination;
            try {
                canonicalDestination = canonicalizeExplicitArtifactDestination(options.cwd, artifactDestination);
            }
            catch (canonicalizationError) {
                return canonicalizationError instanceof Error ? canonicalizationError.message : `Artifact destination ${artifactDestination} could not be resolved safely.`;
            }
            if (canonicalOutputPath === canonicalDestination) {
                return `Unsupported outputPath: ${options.outputPath} resolves to the same destination as artifact path ${artifactDestination}. Use distinct paths so the tool-result JSON cannot overwrite the browser artifact.`;
            }
            if (activeRecordingDestinations.has(canonicalDestination)) {
                const prefix = batch ? `Unsupported batch artifact destination in step ${index + 1}` : "Unsupported artifact destination";
                return `${prefix}: ${artifactDestination} is reserved by an active recording. Stop that recording first or use a distinct path.`;
            }
            const priorStep = artifactDestinations.get(canonicalDestination);
            if (priorStep !== undefined) {
                return `Unsupported batch artifact destination in step ${index + 1}: ${artifactDestination} is already written by step ${priorStep + 1}. Use distinct paths or split the batch so each artifact can be verified independently.`;
            }
            artifactDestinations.set(canonicalDestination, index);
        }
        if (batch && commandStep[0] === "screenshot" && commandStep.includes("--annotate")) {
            return [
                `Unsupported batch screenshot annotation in step ${index + 1}: put --annotate in top-level args, not inside the batch step.`,
                `Use: { "args": ["--annotate", "batch"], "stdin": "[[\\"screenshot\\",\\"/path/to/image.png\\"]]" }`,
            ].join("\n");
        }
    }
    return undefined;
}
function commandClosesAllSessions(args, stdin) {
    const parsed = getArtifactCommandSteps(args, stdin);
    return !parsed.error && parsed.steps.some(isCloseAllCommand);
}
function commandTouchesArtifactLifecycle(args, stdin, outputPath) {
    if (outputPath)
        return true;
    const parsed = getArtifactCommandSteps(args, stdin);
    if (parsed.error)
        return true;
    return parsed.steps.some((step) => getExplicitArtifactDestination(step) !== undefined || step[0] === "record" || step[0] === "screenshot" || isCloseCommand(step[0]));
}
function isResultFileArtifact(artifact) {
    return isRecord(artifact)
        && typeof artifact.absolutePath === "string"
        && typeof artifact.kind === "string"
        && typeof artifact.path === "string";
}
function getResultFileArtifacts(result) {
    const details = isRecord(result.details) ? result.details : undefined;
    return Array.isArray(details?.artifacts) ? details.artifacts.filter(isResultFileArtifact) : [];
}
function restoreArtifactManifestFromBranch(branch) {
    let restoredManifest;
    for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== "message")
            continue;
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message || message.toolName !== "agent_browser")
            continue;
        const details = isRecord(message.details) ? message.details : undefined;
        if (isSessionArtifactManifest(details?.artifactManifest) && (!restoredManifest || details.artifactManifest.updatedAtMs >= restoredManifest.updatedAtMs)) {
            restoredManifest = details.artifactManifest;
        }
    }
    return restoredManifest;
}
function getRecognizedCompatibilityWorkaround(value) {
    const workaround = isRecord(value) ? value : undefined;
    return (workaround?.id === "chatgpt-headless-user-agent" || workaround?.id === "cloudflare-headless-user-agent") && typeof workaround.reason === "string"
        ? { id: workaround.id, reason: workaround.reason }
        : undefined;
}
function restoreManagedSessionCompatibilityWorkaroundFromBranch(branch, sessionName, namespace) {
    let restored;
    const targetKey = getSessionContextKey(sessionName, namespace);
    for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== "message")
            continue;
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message || message.toolName !== "agent_browser")
            continue;
        const details = isRecord(message.details) ? message.details : undefined;
        if (!details)
            continue;
        if (getSessionContextKey(typeof details.sessionName === "string" ? details.sessionName : undefined, typeof details.namespace === "string" ? details.namespace : undefined) !== targetKey)
            continue;
        const recognizedWorkaround = getRecognizedCompatibilityWorkaround(details.compatibilityWorkaround);
        const succeeded = getSuccessfulToolResult(details, message);
        const outcome = getManagedSessionOutcome(details);
        const activeAfterFailure = recognizedWorkaround
            && outcome?.activeAfter === true
            && typeof outcome.currentSessionName === "string"
            && getSessionContextKey(outcome.currentSessionName, typeof outcome.currentSessionNamespace === "string" ? outcome.currentSessionNamespace : undefined) === targetKey
            && (outcome.status === "created" || outcome.status === "replaced" || outcome.status === "unchanged");
        if (!succeeded && !activeAfterFailure)
            continue;
        if (recognizedWorkaround) {
            restored = recognizedWorkaround;
        }
        else if (!canUseHeadlessCompatibilityUserAgent(getToolResultArgs(details))) {
            restored = undefined;
        }
    }
    return restored;
}
function restoreManagedSessionHeadedAutosaveDisabledFromBranch(branch, sessionName, namespace) {
    let restored = false;
    const targetKey = getSessionContextKey(sessionName, namespace);
    for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== "message")
            continue;
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message || message.toolName !== "agent_browser")
            continue;
        const details = isRecord(message.details) ? message.details : undefined;
        if (!details)
            continue;
        if (getSessionContextKey(typeof details.sessionName === "string" ? details.sessionName : undefined, typeof details.namespace === "string" ? details.namespace : undefined) !== targetKey)
            continue;
        const outcome = getManagedSessionOutcome(details);
        const activeAfterFailure = outcome?.activeAfter === true
            && typeof outcome.currentSessionName === "string"
            && getSessionContextKey(outcome.currentSessionName, typeof outcome.currentSessionNamespace === "string" ? outcome.currentSessionNamespace : undefined) === targetKey;
        if ((getSuccessfulToolResult(details, message) || activeAfterFailure) && typeof details.managedSessionHeadedAutosaveDisabled === "boolean") {
            restored = details.managedSessionHeadedAutosaveDisabled;
        }
    }
    return restored;
}
function restoreManagedSessionHeadedAutosaveIntervalFromBranch(branch, sessionName, namespace) {
    let restored;
    const targetKey = getSessionContextKey(sessionName, namespace);
    for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== "message")
            continue;
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message || message.toolName !== "agent_browser")
            continue;
        const details = isRecord(message.details) ? message.details : undefined;
        if (!details)
            continue;
        if (getSessionContextKey(typeof details.sessionName === "string" ? details.sessionName : undefined, typeof details.namespace === "string" ? details.namespace : undefined) !== targetKey)
            continue;
        const outcome = getManagedSessionOutcome(details);
        const activeAfterFailure = outcome?.activeAfter === true
            && typeof outcome.currentSessionName === "string"
            && getSessionContextKey(outcome.currentSessionName, typeof outcome.currentSessionNamespace === "string" ? outcome.currentSessionNamespace : undefined) === targetKey;
        if (!getSuccessfulToolResult(details, message) && !activeAfterFailure)
            continue;
        if (typeof details.managedSessionHeadedAutosaveInterval === "string")
            restored = details.managedSessionHeadedAutosaveInterval;
        else if (details.managedSessionHeadedAutosaveDisabled === true)
            restored = "0";
    }
    return restored;
}
function getToolResultArgs(details) {
    if (Array.isArray(details.args) && details.args.every((arg) => typeof arg === "string"))
        return details.args;
    if (Array.isArray(details.effectiveArgs) && details.effectiveArgs.every((arg) => typeof arg === "string"))
        return details.effectiveArgs;
    return [];
}
function detailsReportCloseAllApplied(details, succeeded) {
    const args = getToolResultArgs(details);
    return details.closeAllApplied === true
        || (succeeded && isCloseAllCommand(extractUpstreamCommandTokens(args)))
        || batchHasSuccessfulCloseAll(details.batchSteps);
}
function isAttachedBrowserInvocation(args, env = getAgentBrowserProcessEnvironment()) {
    const autoConnectEnv = env.AGENT_BROWSER_AUTO_CONNECT;
    return extractUpstreamCommandTokens(args)[0] === "connect"
        || hasLaunchScopedFlagToken(args, "--cdp")
        || hasLaunchScopedFlagToken(args, "--auto-connect")
        || env.AGENT_BROWSER_CDP !== undefined
        || isUpstreamEnvFlagEnabled(autoConnectEnv);
}
function restoreAttachedSessionKeysFromBranch(branch) {
    const attachedSessionKeys = new Set();
    for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== "message")
            continue;
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message || message.toolName !== "agent_browser")
            continue;
        const details = isRecord(message.details) ? message.details : undefined;
        if (!details)
            continue;
        const managedSessionOutcome = isRecord(details.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
        const retainedFailedAttachment = details.attachedBrowserSession === true && managedSessionOutcome?.activeAfter === true;
        const succeeded = getSuccessfulToolResult(details, message);
        const batchCloseLifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
        const terminalBatchClose = batchCloseLifecycle?.endsClosed === true;
        const args = getToolResultArgs(details);
        const namespace = typeof details.namespace === "string" ? details.namespace : extractExplicitNamespace(args);
        const sessionName = typeof details.sessionName === "string" ? details.sessionName : extractExplicitSessionName(args);
        const electron = isRecord(details.electron) ? details.electron : undefined;
        const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
        for (const cleanupResult of Array.isArray(cleanup?.results) ? cleanup.results : []) {
            for (const identity of getCleanupResultClosedManagedSessionIdentities(cleanupResult, namespace)) {
                attachedSessionKeys.delete(getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName);
            }
        }
        if (detailsReportCloseAllApplied(details, succeeded)) {
            deleteIdentityKeysInNamespace(attachedSessionKeys, namespace);
            if (sessionName && details.attachedBrowserSession === true && batchCloseLifecycle?.endsClosed === false) {
                attachedSessionKeys.add(getSessionContextKey(sessionName, namespace) ?? sessionName);
            }
            continue;
        }
        if (!succeeded && !retainedFailedAttachment && !terminalBatchClose)
            continue;
        if (!sessionName)
            continue;
        const sessionKey = getSessionContextKey(sessionName, namespace) ?? sessionName;
        if ((succeeded && isCloseCommand(extractUpstreamCommandTokens(args)[0])) || terminalBatchClose)
            attachedSessionKeys.delete(sessionKey);
        else if (details.attachedBrowserSession === true || isAttachedBrowserInvocation(args, {}))
            attachedSessionKeys.add(sessionKey);
    }
    return attachedSessionKeys;
}
function trackOwnedManagedSession(sessions, sessionName, cwd, options = {}) {
    if (!sessionName)
        return;
    const key = getSessionContextKey(sessionName, options.namespace) ?? sessionName;
    const existing = sessions.get(key);
    const branchOwned = existing && !existing.branchOwned ? false : options.branchOwned === true;
    const compatibilityWorkaround = Object.hasOwn(options, "compatibilityWorkaround")
        ? options.compatibilityWorkaround
        : existing?.compatibilityWorkaround;
    const headedManagedAutosaveDisabled = options.headedManagedAutosaveDisabled ?? existing?.headedManagedAutosaveDisabled;
    const headedManagedAutosaveInterval = options.headedManagedAutosaveInterval ?? existing?.headedManagedAutosaveInterval;
    sessions.set(key, { branchOwned, compatibilityWorkaround, cwd, headedManagedAutosaveDisabled, headedManagedAutosaveInterval, namespace: options.namespace, sessionName });
}
function untrackOwnedManagedSession(sessions, sessionName, namespace) {
    if (!sessionName)
        return;
    if (sessionName.includes("\u0000"))
        sessions.delete(sessionName);
    else
        sessions.delete(getSessionContextKey(sessionName, namespace) ?? sessionName);
}
function untrackOwnedManagedSessionFromBranchClose(sessions, sessionName, activeBranchRank, closeBranchRank) {
    if (!sessionName || closeBranchRank === undefined)
        return;
    const ownedSession = sessions.get(sessionName);
    if (!ownedSession?.branchOwned)
        return;
    if (activeBranchRank !== undefined && closeBranchRank <= activeBranchRank)
        return;
    sessions.delete(sessionName);
}
function syncOwnedManagedSessionsFromResult(sessions, result, cwd) {
    const details = isRecord(result.details) ? result.details : undefined;
    const outcome = isRecord(details?.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
    if (!outcome)
        return;
    const succeeded = outcome.succeeded === true;
    const status = typeof outcome.status === "string" ? outcome.status : undefined;
    const currentSessionName = typeof outcome.currentSessionName === "string" ? outcome.currentSessionName : undefined;
    const attemptedSessionName = typeof outcome.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
    const namespace = isRecord(details) && typeof details.namespace === "string" ? details.namespace : undefined;
    if (outcome.activeAfter === true && (status === "created" || status === "replaced" || status === "unchanged")) {
        trackOwnedManagedSession(sessions, currentSessionName, cwd, {
            compatibilityWorkaround: getRecognizedCompatibilityWorkaround(details?.compatibilityWorkaround),
            headedManagedAutosaveDisabled: details?.managedSessionHeadedAutosaveDisabled === true,
            headedManagedAutosaveInterval: typeof details?.managedSessionHeadedAutosaveInterval === "string" ? details.managedSessionHeadedAutosaveInterval : undefined,
            namespace,
        });
    }
    if (succeeded && status === "closed") {
        untrackOwnedManagedSession(sessions, attemptedSessionName ?? currentSessionName, namespace);
    }
}
function getTouchedElectronLaunchIds(sessionName, records, namespace) {
    const record = findElectronLaunchRecordForSession(sessionName, records, namespace);
    return record ? new Set([record.launchId]) : undefined;
}
function mergeActiveElectronLaunchRecords(target, source, options = {}) {
    for (const record of getActiveElectronRecords(source)) {
        const alreadyRuntimeOwned = target.has(record.launchId) && options.branchOwnedLaunchIds?.has(record.launchId) === false;
        target.set(record.launchId, record);
        if (options.branchOwnedLaunchIds) {
            if (alreadyRuntimeOwned) {
                // Already runtime-owned from a prior live result; keep it that way.
            }
            else if (options.markBranchOwned === true) {
                options.branchOwnedLaunchIds.add(record.launchId);
            }
            else if (options.touchedLaunchIds?.has(record.launchId)) {
                options.branchOwnedLaunchIds.delete(record.launchId);
            }
        }
    }
}
function removeInactiveOwnedElectronLaunchRecords(target, branchOwnedLaunchIds, source, activeBranchRanks, cleanupBranchRanks) {
    const activeLaunchIds = new Set(getActiveElectronRecords(source).map((record) => record.launchId));
    const launchIds = new Set([...source.keys(), ...cleanupBranchRanks.keys()]);
    for (const launchId of launchIds) {
        if (!target.has(launchId) || !branchOwnedLaunchIds.has(launchId))
            continue;
        const activeBranchRank = activeBranchRanks.get(launchId);
        const cleanupBranchRank = cleanupBranchRanks.get(launchId);
        const restoredInactiveRecord = source.has(launchId) && !activeLaunchIds.has(launchId);
        const cleanupIsLatest = cleanupBranchRank !== undefined && (activeBranchRank === undefined || cleanupBranchRank > activeBranchRank);
        if (!restoredInactiveRecord && !cleanupIsLatest)
            continue;
        target.delete(launchId);
        branchOwnedLaunchIds.delete(launchId);
    }
}
function mergeElectronLaunchRecordMaps(...maps) {
    const merged = new Map();
    for (const map of maps) {
        for (const [launchId, record] of map)
            merged.set(launchId, record);
    }
    return merged;
}
function replaceWithActiveElectronLaunchRecords(target, source, branchOwnedLaunchIds, cleanedLaunchIds) {
    target.clear();
    if (branchOwnedLaunchIds) {
        if (cleanedLaunchIds) {
            for (const launchId of cleanedLaunchIds)
                branchOwnedLaunchIds.delete(launchId);
        }
        else {
            branchOwnedLaunchIds.clear();
        }
    }
    mergeActiveElectronLaunchRecords(target, source, branchOwnedLaunchIds ? { branchOwnedLaunchIds } : {});
}
function shouldSerializeElectronHostInput(compiledElectron) {
    return compiledElectron?.action === "status" || compiledElectron?.action === "probe" || compiledElectron?.action === "cleanup";
}
function getElectronHostLaunchRecordsForInput(options) {
    if (options.compiledElectron?.action === "status" ||
        options.compiledElectron?.action === "cleanup" ||
        (options.compiledElectron?.action === "probe" && options.compiledElectron.launchId)) {
        return mergeElectronLaunchRecordMaps(options.branchRecords, options.ownedRecords);
    }
    return options.branchRecords;
}
function getCleanupResultClosedManagedSessionIdentities(result, fallbackNamespace) {
    if (!isRecord(result) || !Array.isArray(result.steps))
        return [];
    const identities = new Map();
    const record = isRecord(result.record) ? result.record : undefined;
    for (const step of result.steps) {
        if (!isRecord(step) || step.resource !== "managed-session")
            continue;
        if (step.state !== "removed" && step.state !== "already-gone")
            continue;
        const sessionName = typeof step.sessionName === "string"
            ? step.sessionName
            : typeof record?.sessionName === "string" ? record.sessionName : undefined;
        const namespace = typeof step.namespace === "string"
            ? step.namespace
            : typeof record?.namespace === "string" ? record.namespace : fallbackNamespace;
        if (sessionName)
            identities.set(getSessionContextKey(sessionName, namespace) ?? sessionName, { namespace, sessionName });
    }
    return [...identities.values()];
}
function getCleanupResultsClosedManagedSessionIdentities(cleanupResults, fallbackNamespace) {
    const identities = new Map();
    for (const result of cleanupResults) {
        for (const identity of getCleanupResultClosedManagedSessionIdentities(result, fallbackNamespace)) {
            identities.set(getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName, identity);
        }
    }
    return [...identities.values()];
}
function isElectronLaunchRecord(value) {
    if (!isRecord(value))
        return false;
    return value.version === 1
        && value.launchedByWrapper === true
        && (value.namespace === undefined || typeof value.namespace === "string")
        && typeof value.launchId === "string"
        && typeof value.appName === "string"
        && typeof value.executablePath === "string"
        && typeof value.userDataDir === "string"
        && typeof value.port === "number"
        && typeof value.createdAtMs === "number";
}
function getCleanupResultsElectronRecords(cleanupResults) {
    return cleanupResults
        .map((result) => isRecord(result) ? result.record : undefined)
        .filter(isElectronLaunchRecord);
}
function mergeElectronCleanupRecords(target, cleanupResults) {
    for (const record of getCleanupResultsElectronRecords(cleanupResults)) {
        target.set(record.launchId, record);
    }
}
function getManagedSessionOutcome(details) {
    return isRecord(details.managedSessionOutcome) ? details.managedSessionOutcome : undefined;
}
function getSuccessfulToolResult(details, message) {
    const messageIsError = typeof message.isError === "boolean" ? message.isError : undefined;
    const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
    return messageIsError === undefined ? exitCode === undefined || exitCode === 0 : !messageIsError;
}
function setBranchRankForString(map, value, rank) {
    if (typeof value === "string" && value.length > 0)
        map.set(value, rank);
}
function setBranchManagedSessionActive(events, sessionName, namespace, rank) {
    if (typeof sessionName !== "string" || sessionName.length === 0)
        return;
    const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
    events.managedSessionActiveIdentities.set(key, { namespace, sessionName });
    events.managedSessionActiveRanks.set(key, rank);
}
function collectBranchManagedResourceEvents(branch) {
    const events = {
        electronLaunchActiveRanks: new Map(),
        electronLaunchCleanupRanks: new Map(),
        managedSessionActiveIdentities: new Map(),
        managedSessionActiveRanks: new Map(),
        managedSessionCloseRanks: new Map(),
    };
    let eventRank = 0;
    for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== "message")
            continue;
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message || message.toolName !== "agent_browser")
            continue;
        const details = isRecord(message.details) ? message.details : undefined;
        if (!details)
            continue;
        eventRank += 1;
        const succeeded = getSuccessfulToolResult(details, message);
        const args = Array.isArray(details.args) && details.args.every((arg) => typeof arg === "string") ? details.args : [];
        const command = typeof details.command === "string" ? details.command : extractUpstreamCommandTokens(args)[0];
        const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
        const namespace = typeof details.namespace === "string" ? details.namespace : undefined;
        const sessionMode = details.sessionMode === "fresh" || details.sessionMode === "auto" ? details.sessionMode : undefined;
        const usedImplicitSession = details.usedImplicitSession === true;
        const explicitSessionName = extractExplicitSessionName(args);
        const batchCloseLifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
        const closeAllApplied = detailsReportCloseAllApplied(details, succeeded);
        const outcome = getManagedSessionOutcome(details);
        const outcomeSucceeded = outcome?.succeeded === true;
        const outcomeStatus = typeof outcome?.status === "string" ? outcome.status : undefined;
        const outcomeCurrentSessionName = typeof outcome?.currentSessionName === "string" ? outcome.currentSessionName : undefined;
        const outcomeAttemptedSessionName = typeof outcome?.attemptedSessionName === "string" ? outcome.attemptedSessionName : undefined;
        if (outcome?.activeAfter === true && (outcomeStatus === "created" || outcomeStatus === "replaced" || outcomeStatus === "unchanged")) {
            setBranchManagedSessionActive(events, outcomeCurrentSessionName, namespace, eventRank);
        }
        if (outcomeSucceeded && outcomeStatus === "closed") {
            setBranchRankForString(events.managedSessionCloseRanks, getSessionContextKey(outcomeAttemptedSessionName ?? outcomeCurrentSessionName ?? sessionName, namespace), eventRank);
        }
        if (outcome && outcomeStatus === "replaced" && outcome.replacedSessionClosed !== false) {
            const replacedSessionNamespace = typeof outcome.replacedSessionNamespace === "string" ? outcome.replacedSessionNamespace : namespace;
            setBranchRankForString(events.managedSessionCloseRanks, getSessionContextKey(typeof outcome.replacedSessionName === "string" ? outcome.replacedSessionName : undefined, replacedSessionNamespace), eventRank);
        }
        if (succeeded && !isCloseCommand(command) && sessionName && (usedImplicitSession || sessionMode === "fresh" || details.managedSessionHeadedAutosaveDisabled === true || typeof details.managedSessionHeadedAutosaveInterval === "string")) {
            setBranchManagedSessionActive(events, sessionName, namespace, eventRank);
        }
        if (succeeded && isCloseCommand(command)) {
            setBranchRankForString(events.managedSessionCloseRanks, getSessionContextKey(explicitSessionName ?? sessionName ?? outcomeAttemptedSessionName ?? outcomeCurrentSessionName, namespace), eventRank);
        }
        if (closeAllApplied) {
            const retainedSessionKey = batchCloseLifecycle?.endsClosed === false ? getSessionContextKey(sessionName, namespace) : undefined;
            for (const sessionKey of events.managedSessionActiveIdentities.keys()) {
                if (sessionKey !== retainedSessionKey && isAgentBrowserSessionIdentityKeyInNamespace(sessionKey, namespace)) {
                    events.managedSessionCloseRanks.set(sessionKey, eventRank);
                }
            }
        }
        const electron = isRecord(details.electron) ? details.electron : undefined;
        const launch = electron && isElectronLaunchRecord(electron.launch) ? electron.launch : undefined;
        if (launch && getActiveElectronRecords(new Map([[launch.launchId, launch]])).length > 0) {
            events.electronLaunchActiveRanks.set(launch.launchId, eventRank);
        }
        const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
        const cleanupRecords = Array.isArray(cleanup?.records) ? cleanup.records : [];
        for (const cleanupRecord of cleanupRecords) {
            if (isElectronLaunchRecord(cleanupRecord))
                events.electronLaunchCleanupRanks.set(cleanupRecord.launchId, eventRank);
        }
        const cleanupResults = Array.isArray(cleanup?.results) ? cleanup.results : [];
        for (const cleanupResult of cleanupResults) {
            if (isRecord(cleanupResult) && isElectronLaunchRecord(cleanupResult.record)) {
                events.electronLaunchCleanupRanks.set(cleanupResult.record.launchId, eventRank);
            }
            for (const identity of getCleanupResultClosedManagedSessionIdentities(cleanupResult, namespace)) {
                events.managedSessionCloseRanks.set(getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName, eventRank);
            }
        }
    }
    return events;
}
function getCleanupResultsPreservedUserDataDirs(cleanupResults) {
    const userDataDirs = new Set();
    for (const result of cleanupResults) {
        if (!isRecord(result) || !Array.isArray(result.steps) || !isElectronLaunchRecord(result.record))
            continue;
        const userDataDirStep = result.steps.find((step) => isRecord(step) && step.resource === "user-data-dir");
        if (!isRecord(userDataDirStep))
            continue;
        if (userDataDirStep.state === "skipped" || userDataDirStep.state === "failed")
            userDataDirs.add(result.record.userDataDir);
    }
    return [...userDataDirs];
}
function syncElectronCleanupManagedSessions(sessions, cleanupResults, fallbackNamespace) {
    for (const identity of getCleanupResultsClosedManagedSessionIdentities(cleanupResults, fallbackNamespace)) {
        untrackOwnedManagedSession(sessions, identity.sessionName, identity.namespace);
    }
}
async function closeOwnedManagedSessionsExcept(sessions, restoreState, keepSessionName, timeoutMs, attachedSessionKeys, keepNamespace, onClosed) {
    const keepKey = getSessionContextKey(keepSessionName, keepNamespace);
    for (const [key, owner] of [...sessions]) {
        if (key === keepKey)
            continue;
        const error = await closeManagedSession({ cwd: owner.cwd, headedManagedAutosaveInterval: owner.headedManagedAutosaveInterval, namespace: owner.namespace, preserveAttachedBrowserSession: attachedSessionKeys.has(key), restoreState, sessionName: owner.sessionName, timeoutMs });
        if (!error) {
            sessions.delete(key);
            onClosed?.(owner);
        }
    }
}
function getOffBranchOwnedElectronLaunchRecords(ownedRecords, branchRecords) {
    const activeBranchLaunchIds = new Set(getActiveElectronRecords(branchRecords).map((record) => record.launchId));
    const offBranchRecords = new Map();
    for (const record of getActiveElectronRecords(ownedRecords)) {
        if (!activeBranchLaunchIds.has(record.launchId))
            offBranchRecords.set(record.launchId, record);
    }
    return offBranchRecords;
}
function shouldSerializeBrowserCommand(options) {
    if (!options.explicitSessionName)
        return true;
    if (options.explicitSessionName === options.managedSessionName)
        return true;
    if (options.ownedManagedSessions.has(getSessionContextKey(options.explicitSessionName, options.namespace) ?? options.explicitSessionName))
        return true;
    return getActiveElectronRecords(options.ownedElectronLaunchRecords).some((record) => record.sessionName === options.explicitSessionName);
}
// Serializes managed-session read/modify/write work so overlapping tool calls cannot promote stale state or close an in-use session.
class AsyncExecutionQueue {
    tail = Promise.resolve();
    run(work) {
        const previous = this.tail;
        let release;
        this.tail = new Promise((resolve) => {
            release = resolve;
        });
        return (async () => {
            await previous;
            try {
                return await work();
            }
            finally {
                release();
            }
        })();
    }
}
export class KeyedAsyncExecutionQueue {
    barriers = new Map();
    entries = new Map();
    async run(key, namespace, work) {
        const entry = this.entries.get(key) ?? { queue: new AsyncExecutionQueue(), users: 0 };
        const barrier = this.barriers.get(getAgentBrowserSessionIdentityKey("", namespace)) ?? Promise.resolve();
        entry.users += 1;
        this.entries.set(key, entry);
        try {
            return await entry.queue.run(async () => {
                await barrier;
                return await work();
            });
        }
        finally {
            entry.users -= 1;
            if (entry.users === 0 && this.entries.get(key) === entry)
                this.entries.delete(key);
        }
    }
    async runExclusive(namespace, work) {
        const namespaceKey = getAgentBrowserSessionIdentityKey("", namespace);
        const previous = this.barriers.get(namespaceKey) ?? Promise.resolve();
        let release;
        const blocked = new Promise((resolve) => {
            release = resolve;
        });
        const barrier = previous.then(() => blocked);
        this.barriers.set(namespaceKey, barrier);
        const drains = [...this.entries]
            .filter(([key]) => isAgentBrowserSessionIdentityKeyInNamespace(key, namespace))
            .map(([, { queue }]) => queue.run(async () => undefined));
        await previous;
        await Promise.all(drains);
        try {
            return await work();
        }
        finally {
            release();
            if (this.barriers.get(namespaceKey) === barrier)
                this.barriers.delete(namespaceKey);
        }
    }
}
function mergeBrowserRunMap(current, initial, updated) {
    if (updated === initial)
        return current;
    const merged = new Map(current);
    for (const [key, value] of updated) {
        if (!initial.has(key) || initial.get(key) !== value)
            merged.set(key, value);
    }
    for (const key of initial.keys()) {
        if (!updated.has(key))
            merged.delete(key);
    }
    return merged;
}
export function mergeBrowserRunArtifactManifest(current, initial, updated) {
    if (!updated || updated === initial)
        return current;
    if (current === initial)
        return updated;
    const initialEntries = new Map((initial?.entries ?? []).map((entry) => [getSessionArtifactManifestEntryKey(entry), entry]));
    const changedEntries = updated.entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => initialEntries.get(getSessionArtifactManifestEntryKey(entry)) !== entry)
        .sort((left, right) => left.entry.createdAtMs - right.entry.createdAtMs
        || Number(isPendingRecordingCommand(left.entry.command, left.entry.subcommand, left.entry.kind)) - Number(isPendingRecordingCommand(right.entry.command, right.entry.subcommand, right.entry.kind))
        || left.index - right.index)
        .map(({ entry }) => entry);
    return changedEntries.length === 0
        ? current
        : mergeSessionArtifactManifest({
            base: current,
            entries: changedEntries,
            nowMs: Math.max(Date.now(), (current?.updatedAtMs ?? 0) + 1, updated.updatedAtMs),
        });
}
function findPackageRoot(startDir) {
    let currentDir = startDir;
    while (true) {
        const packageJsonPath = join(currentDir, "package.json");
        if (existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
            if (packageJson.name === "pi-agent-browser-native")
                return currentDir;
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir)
            return startDir;
        currentDir = parentDir;
    }
}
function getInstalledDocsPaths() {
    const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
    return {
        readmePath: join(packageRoot, "README.md"),
        commandReferencePath: join(packageRoot, "docs", "COMMAND_REFERENCE.md"),
        toolContractPath: join(packageRoot, "docs", "TOOL_CONTRACT.md"),
    };
}
function hasArgvFlag(argv, longFlag, shortFlag) {
    return argv.includes(longFlag) || argv.includes(shortFlag);
}
function shouldIncludeProjectConfig(ctx, argv = process.argv) {
    if (hasArgvFlag(argv, "--no-approve", "-na"))
        return false;
    return ctx?.isProjectTrusted?.() ?? true;
}
export default function agentBrowserExtension(pi, { beforeExecute } = {}) {
    const ephemeralSessionSeed = createEphemeralSessionSeed();
    const agentBrowserConfig = loadAgentBrowserConfigSync({
        cwd: process.cwd(),
        includeProjectConfig: false,
    });
    // local patch: slim promptGuidelines — canonical Tier A built by buildToolPromptGuidelines (lib/playbook.js):
    // 4 invariants + gate map + docs/COMMAND_REFERENCE.md guide-gate pointer, plus config-driven
    // lines ("agent_browser config sets …") when configured. Everything else is failure-driven
    // teaching via details.nextActions or guide-gate docs.
    const toolPromptGuidelines = buildToolPromptGuidelines({
        browserDefaultProfile: agentBrowserConfig.trustedBrowserDefaultProfile,
        browserExecutablePath: agentBrowserConfig.trustedBrowserExecutablePath,
        docs: getInstalledDocsPaths(),
    });
    const implicitSessionIdleTimeoutMs = String(getImplicitSessionIdleTimeoutMs());
    const implicitSessionCloseTimeoutMs = getImplicitSessionCloseTimeoutMs();
    let webSearchToolRegistered = false;
    let managedSessionActive = false;
    let managedSessionBaseName = createImplicitSessionName(undefined, process.cwd(), ephemeralSessionSeed);
    let managedSessionCompatibilityWorkaround;
    let managedSessionHeadedAutosaveDisabled = false;
    let managedSessionHeadedAutosaveInterval;
    let managedSessionName = managedSessionBaseName;
    let managedSessionCwd = process.cwd();
    let managedSessionNamespace;
    let freshSessionOrdinal = 0;
    let sessionPageState = new SessionPageState();
    let traceOwners = new Map();
    let artifactManifest;
    let activeRecordingReservations = new Map();
    let recordingSessionTombstones = new Map();
    let recordingReservationsDirty = false;
    let attachedSessionKeys = new Set();
    let networkRoutesBySession = new Map();
    let electronLaunchRecords = new Map();
    let ownedElectronLaunchRecords = new Map();
    let branchOwnedElectronLaunchIds = new Set();
    let electronChildProcesses = new Map();
    const managedSessionRestoreState = new ManagedSessionRestoreState();
    const ownedManagedSessions = new Map();
    const managedSessionExecutionQueue = new AsyncExecutionQueue();
    const artifactExecutionQueue = new AsyncExecutionQueue();
    const callerOwnedSessionExecutionQueues = new KeyedAsyncExecutionQueue();
    const activeScriptControllers = new Set();
    const activeScriptExecutions = new Set();
    let branchRestoreGeneration = 0;
    let branchStateGeneration = 0;
    const validatedUpstreamPathKeys = new Set();
    const recordingPersistenceWarning = "Recording persistence warning: recording protection could not be saved to the Pi journal. Restart protection is not yet durable; keep recording destinations untouched until exact stop or close. The next browser operation retries journal persistence; cleanup remains available.";
    const flushRecordingReservations = () => {
        if (!recordingReservationsDirty)
            return;
        try {
            // Pi updates branch memory before writing. One failed append can hide an earlier
            // durable reservation after reopen, so republish all current state, not just the failed row.
            for (const reservation of recordingSessionTombstones.values())
                appendRecordingReservationTransition(pi, { reservation, state: "closed" });
            for (const reservation of activeRecordingReservations.values())
                appendRecordingReservationTransition(pi, { reservation, state: "active" });
            recordingReservationsDirty = false;
        }
        catch { }
    };
    const warnRecordingPersistence = (result) => {
        if (!recordingReservationsDirty)
            return result;
        const content = [...result.content];
        const first = content[0];
        let json;
        if (first?.type === "text") {
            try {
                json = JSON.parse(first.text);
            }
            catch { }
        }
        if (isRecord(json) && typeof json.success === "boolean") {
            content[0] = { type: "text", text: JSON.stringify({ ...json, warnings: [...(Array.isArray(json.warnings) ? json.warnings : []), recordingPersistenceWarning] }, null, 2) };
        }
        else if (first?.type === "text")
            content[0] = { ...first, text: `${first.text}\n\n${recordingPersistenceWarning}` };
        else
            content.push({ type: "text", text: recordingPersistenceWarning });
        return { ...result, content, details: { ...(isRecord(result.details) ? result.details : {}), recordingPersistenceWarning } };
    };
    const notifyRecordingPersistence = (ctx) => {
        if (!recordingReservationsDirty)
            return;
        if (ctx.hasUI)
            ctx.ui.notify(recordingPersistenceWarning, "warning");
        else
            console.warn(recordingPersistenceWarning);
    };
    const appendRecordingTransitions = (transitions) => {
        for (const transition of transitions) {
            const key = getAgentBrowserSessionIdentityKey(transition.reservation.sessionName, transition.reservation.namespace);
            if (transition.state === "active")
                recordingSessionTombstones.delete(key);
            else
                recordingSessionTombstones.set(key, transition.reservation);
            if (recordingReservationsDirty)
                continue;
            try {
                appendRecordingReservationTransition(pi, transition);
            }
            catch {
                recordingReservationsDirty = true;
            }
        }
    };
    const appendActiveRecordingCleanupAction = (result, reservation) => {
        if (result.isError !== true)
            return result;
        const details = isRecord(result.details) ? result.details : {};
        if (details.recordingRecovery)
            return result;
        const cleanupOnly = details.managedSessionCleanupOnlyReason === "restore-disabled-daemon-without-provenance";
        const nextActions = (Array.isArray(details.nextActions) ? details.nextActions : [])
            .filter((action) => !cleanupOnly || action.id !== "stop-pending-recording");
        const actionId = cleanupOnly ? "close-pending-recording" : "stop-pending-recording";
        if (nextActions.some((action) => action.id === actionId))
            return result;
        const stopActions = applyNamespaceToNextActions(applySessionToNextActions([
            buildNextToolAction({
                args: cleanupOnly ? ["close"] : ["record", "stop"],
                id: actionId,
                reason: cleanupOnly
                    ? "Close this exact session to abandon the recording; its live daemon lacks current-instance provenance."
                    : "Stop the active recording so the requested video can be finalized and verified on disk.",
                safety: cleanupOnly
                    ? "Close does not verify the WebM. The recording is abandoned/unverified, even if close leaves a file on disk."
                    : "The file remains pending until record stop succeeds; verify details.artifactVerification afterward.",
            }),
        ], reservation.sessionName), cleanupOnly ? reservation.namespace ?? "" : reservation.namespace);
        appendUniqueAgentBrowserNextActions(nextActions, stopActions);
        const cleanupNotice = cleanupOnly
            ? "This recording cannot be stopped through the unproven daemon. Use the exact close-pending-recording payload in details.nextActions; any WebM left by close is abandoned/unverified."
            : "An active recording remains open. Use the exact stop-pending-recording payload in details.nextActions before leaving this session.";
        let noticeAppended = false;
        const content = result.content.map((item) => {
            if (noticeAppended || item.type !== "text")
                return item;
            noticeAppended = true;
            return { ...item, text: `${item.text}\n\n${cleanupNotice}` };
        });
        if (!noticeAppended)
            content.push({ type: "text", text: cleanupNotice });
        return { ...result, content, details: { ...details, nextActions } };
    };
    const retireRecordingSession = (sessionName, namespace, retireManifest = true) => {
        const reservation = retireRecordingReservation(activeRecordingReservations, sessionName, namespace);
        const previousManifest = artifactManifest;
        if (retireManifest && artifactManifest)
            artifactManifest = retirePendingRecordingManifestEntries(artifactManifest, sessionName, namespace);
        if (!reservation && artifactManifest === previousManifest)
            return;
        const terminalReservation = reservation ?? { absolutePath: "", cwd: managedSessionCwd, namespace, path: "", sessionName };
        appendRecordingTransitions([{ reservation: terminalReservation, state: "closed" }]);
    };
    const syncRecordingReservationsFromResult = (result) => {
        const handledClosedSessionKeys = new Set();
        const details = isRecord(result.details) ? result.details : undefined;
        const batchSteps = Array.isArray(details?.batchSteps) ? details.batchSteps : undefined;
        const resultSessionName = typeof details?.sessionName === "string" ? details.sessionName : undefined;
        const resultNamespace = typeof details?.namespace === "string" ? details.namespace : undefined;
        if (!batchSteps) {
            appendRecordingTransitions(applyRecordingArtifactsToReservations(activeRecordingReservations, getResultFileArtifacts(result)));
            return handledClosedSessionKeys;
        }
        let sessionClosed = false;
        for (const step of batchSteps) {
            if (!isRecord(step))
                continue;
            const command = Array.isArray(step.command) && step.command.every((token) => typeof token === "string") ? step.command : undefined;
            const commandTokens = command ? extractUpstreamCommandTokens(command) : [];
            const commandName = commandTokens[0];
            if (step.success === true && commandName && isCloseCommand(commandName) && resultSessionName) {
                const sessionKey = getAgentBrowserSessionIdentityKey(resultSessionName, resultNamespace);
                retireRecordingSession(resultSessionName, resultNamespace, false);
                handledClosedSessionKeys.add(sessionKey);
                sessionClosed = true;
                continue;
            }
            if (sessionClosed && commandName === "record")
                continue;
            if (step.success === true && sessionClosed)
                sessionClosed = false;
            const artifacts = Array.isArray(step.artifacts) ? step.artifacts.filter(isResultFileArtifact) : [];
            appendRecordingTransitions(applyRecordingArtifactsToReservations(activeRecordingReservations, artifacts));
        }
        for (const sessionKey of handledClosedSessionKeys) {
            if (!activeRecordingReservations.has(sessionKey) && artifactManifest && resultSessionName) {
                artifactManifest = retirePendingRecordingManifestEntries(artifactManifest, resultSessionName, resultNamespace);
            }
        }
        return handledClosedSessionKeys;
    };
    const validateUpstreamVersion = async (cwd, signal) => {
        const processEnvironment = getAgentBrowserProcessEnvironment();
        const pathKey = `${cwd}\0${processEnvironment.PATH ?? processEnvironment.Path ?? ""}`;
        if (validatedUpstreamPathKeys.has(pathKey))
            return undefined;
        const probe = await runAgentBrowserProcess({ args: ["--version"], cwd, signal, timeoutMs: 5_000 });
        if (probe.spawnError?.code === "ENOENT" || probe.exitCode === 127 || probe.aborted)
            return undefined;
        let error;
        let observedVersion;
        if (probe.spawnError || probe.exitCode !== 0) {
            const detail = redactSensitiveText(probe.spawnError?.message ?? (probe.stderr.trim() || `exit ${probe.exitCode}`));
            error = `agent-browser --version could not be validated (${detail}). Run pi-agent-browser-doctor before browser-backed calls.`;
        }
        else {
            observedVersion = parseAgentBrowserVersionOutput(probe.stdout);
            error = getAgentBrowserVersionValidationError(probe.stdout);
        }
        if (!error) {
            validatedUpstreamPathKeys.add(pathKey);
            return undefined;
        }
        return {
            content: [{ type: "text", text: error }],
            details: {
                expectedVersion: TARGET_AGENT_BROWSER_VERSION,
                failureCategory: "validation-error",
                observedVersion,
                resultCategory: "failure",
                minimumSupportedVersion: MINIMUM_AGENT_BROWSER_VERSION,
                versionValidation: { expected: SUPPORTED_AGENT_BROWSER_VERSION_LABEL, observed: observedVersion },
            },
            isError: true,
        };
    };
    const clearSessionScopedBrowserState = (sessionName, namespace) => {
        const key = getSessionContextKey(sessionName, namespace) ?? sessionName;
        attachedSessionKeys.delete(key);
        networkRoutesBySession = new Map(networkRoutesBySession);
        networkRoutesBySession.delete(key);
        traceOwners.delete(key);
        sessionPageState.clearSession(key);
    };
    const closeScriptSessionLeaseWithinQueue = async (sessionName, cwd) => {
        const closeError = await withIsolatedAgentBrowserEnvironment(() => closeManagedSession({
            cwd,
            namespace: AGENT_BROWSER_SCRIPT_NAMESPACE,
            restoreState: managedSessionRestoreState,
            sessionName,
            timeoutMs: implicitSessionCloseTimeoutMs,
        }));
        if (closeError) {
            try {
                appendScriptSessionLease(pi, sessionName, "failed");
            }
            catch { }
            return redactSensitiveText(closeError);
        }
        try {
            appendScriptSessionLease(pi, sessionName, "closed");
        }
        catch {
            managedSessionRestoreState.disable(sessionName);
            return "The isolated session closed, but its durable cleanup record could not be saved.";
        }
        untrackOwnedManagedSession(ownedManagedSessions, sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
        managedSessionRestoreState.clear(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
        retireRecordingSession(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
        clearSessionScopedBrowserState(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
        return undefined;
    };
    const recoverScriptSessionLeasesWithinQueue = async (ctx) => {
        const pendingSessionNames = new Set([...ownedManagedSessions.values()]
            .map((session) => session.sessionName)
            .filter(isAgentBrowserScriptSessionName));
        for (const lease of getScriptSessionLeasesFromBranch(ctx.sessionManager.getBranch()).values()) {
            if (lease.cleanup !== "closed")
                pendingSessionNames.add(lease.sessionName);
        }
        for (const sessionName of pendingSessionNames) {
            trackOwnedManagedSession(ownedManagedSessions, sessionName, ctx.cwd, { branchOwned: true, namespace: AGENT_BROWSER_SCRIPT_NAMESPACE });
            managedSessionRestoreState.disable(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
            await closeScriptSessionLeaseWithinQueue(sessionName, ctx.cwd);
        }
    };
    const restoreBranchBackedState = (ctx, options) => {
        branchRestoreGeneration += 1;
        branchStateGeneration += 1;
        const previousManagedSessionActive = managedSessionActive;
        const previousManagedSessionName = managedSessionName;
        const previousFreshSessionOrdinal = freshSessionOrdinal;
        const previousAttachedSessionKeys = attachedSessionKeys;
        managedSessionBaseName = createImplicitSessionName(ctx.sessionManager.getSessionId(), ctx.cwd, ephemeralSessionSeed);
        const branch = ctx.sessionManager.getBranch();
        const branchResourceEvents = collectBranchManagedResourceEvents(branch);
        const restoredState = restoreManagedSessionStateFromBranch(branch, managedSessionBaseName);
        managedSessionRestoreState.replace(restoredState.managedSessionRestoreDisabledIdentities, {
            preserveDaemonRestoreKeys: !options.resetRuntimeOwnership,
        });
        managedSessionActive = restoredState.active;
        const restoredFreshSessionOrdinal = options.resetRuntimeOwnership
            ? restoredState.freshSessionOrdinal
            : Math.max(previousFreshSessionOrdinal, restoredState.freshSessionOrdinal);
        const shouldReservePostCloseSession = !restoredState.active && restoredState.closedSessionName === restoredState.sessionName;
        const alreadyReservedPostCloseSession = shouldReservePostCloseSession
            && !options.resetRuntimeOwnership
            && !previousManagedSessionActive
            && previousFreshSessionOrdinal > restoredState.freshSessionOrdinal
            && previousFreshSessionOrdinal === restoredFreshSessionOrdinal
            && previousManagedSessionName === createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, restoredFreshSessionOrdinal);
        const nextFreshSessionOrdinal = shouldReservePostCloseSession && !alreadyReservedPostCloseSession
            ? restoredFreshSessionOrdinal + 1
            : restoredFreshSessionOrdinal;
        managedSessionName = shouldReservePostCloseSession
            ? alreadyReservedPostCloseSession
                ? previousManagedSessionName
                : createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, nextFreshSessionOrdinal)
            : restoredState.sessionName;
        managedSessionNamespace = shouldReservePostCloseSession ? undefined : restoredState.namespace;
        managedSessionCompatibilityWorkaround = managedSessionActive
            ? restoreManagedSessionCompatibilityWorkaroundFromBranch(branch, managedSessionName, managedSessionNamespace)
            : undefined;
        managedSessionHeadedAutosaveDisabled = managedSessionActive
            && restoreManagedSessionHeadedAutosaveDisabledFromBranch(branch, managedSessionName, managedSessionNamespace);
        managedSessionHeadedAutosaveInterval = managedSessionActive
            ? restoreManagedSessionHeadedAutosaveIntervalFromBranch(branch, managedSessionName, managedSessionNamespace)
            : undefined;
        managedSessionCwd = ctx.cwd;
        freshSessionOrdinal = nextFreshSessionOrdinal;
        sessionPageState = SessionPageState.fromBranch(branch);
        traceOwners = new Map();
        artifactManifest = restoreArtifactManifestFromBranch(branch);
        const restoredRecordingState = restoreRecordingReservationStateFromBranch(branch);
        for (const key of recordingSessionTombstones.keys()) {
            if (!restoredRecordingState.terminal.has(key))
                recordingReservationsDirty = true;
        }
        for (const [key, reservation] of restoredRecordingState.terminal) {
            if (!activeRecordingReservations.has(key))
                recordingSessionTombstones.set(key, reservation);
        }
        for (const [key, reservation] of recordingSessionTombstones) {
            restoredRecordingState.active.delete(key);
            if (artifactManifest)
                artifactManifest = retirePendingRecordingManifestEntries(artifactManifest, reservation.sessionName, reservation.namespace);
        }
        for (const [key, reservation] of activeRecordingReservations) {
            const restored = restoredRecordingState.active.get(key);
            if (restored?.absolutePath !== reservation.absolutePath || restored.cwd !== reservation.cwd || restored.recordingId !== reservation.recordingId || restored.startedAtMs !== reservation.startedAtMs)
                recordingReservationsDirty = true;
            restoredRecordingState.active.set(key, reservation);
        }
        activeRecordingReservations = restoredRecordingState.active;
        attachedSessionKeys = restoreAttachedSessionKeysFromBranch(branch);
        networkRoutesBySession = new Map();
        electronLaunchRecords = restoreElectronLaunchRecordsFromBranch(branch);
        for (const record of getActiveElectronRecords(electronLaunchRecords)) {
            if (record.sessionName)
                attachedSessionKeys.add(getSessionContextKey(record.sessionName, record.namespace) ?? record.sessionName);
        }
        if (options.resetRuntimeOwnership) {
            ownedManagedSessions.clear();
            ownedElectronLaunchRecords = new Map();
            branchOwnedElectronLaunchIds = new Set();
        }
        else {
            for (const [sessionName, closeRank] of branchResourceEvents.managedSessionCloseRanks) {
                untrackOwnedManagedSessionFromBranchClose(ownedManagedSessions, sessionName, branchResourceEvents.managedSessionActiveRanks.get(sessionName), closeRank);
            }
            removeInactiveOwnedElectronLaunchRecords(ownedElectronLaunchRecords, branchOwnedElectronLaunchIds, electronLaunchRecords, branchResourceEvents.electronLaunchActiveRanks, branchResourceEvents.electronLaunchCleanupRanks);
        }
        for (const [sessionKey, identity] of branchResourceEvents.managedSessionActiveIdentities) {
            const activeRank = branchResourceEvents.managedSessionActiveRanks.get(sessionKey);
            const closeRank = branchResourceEvents.managedSessionCloseRanks.get(sessionKey);
            if (activeRank === undefined || (closeRank !== undefined && closeRank >= activeRank))
                continue;
            if (!isRestorableManagedSessionName(identity.sessionName, managedSessionBaseName))
                continue;
            trackOwnedManagedSession(ownedManagedSessions, identity.sessionName, ctx.cwd, {
                branchOwned: true,
                compatibilityWorkaround: restoreManagedSessionCompatibilityWorkaroundFromBranch(branch, identity.sessionName, identity.namespace),
                headedManagedAutosaveDisabled: restoreManagedSessionHeadedAutosaveDisabledFromBranch(branch, identity.sessionName, identity.namespace),
                headedManagedAutosaveInterval: restoreManagedSessionHeadedAutosaveIntervalFromBranch(branch, identity.sessionName, identity.namespace),
                namespace: identity.namespace,
            });
        }
        if (restoredState.active) {
            trackOwnedManagedSession(ownedManagedSessions, restoredState.sessionName, ctx.cwd, {
                branchOwned: true,
                compatibilityWorkaround: managedSessionCompatibilityWorkaround,
                headedManagedAutosaveDisabled: managedSessionHeadedAutosaveDisabled,
                headedManagedAutosaveInterval: managedSessionHeadedAutosaveInterval,
                namespace: restoredState.namespace,
            });
        }
        for (const record of getActiveElectronRecords(electronLaunchRecords)) {
            if (!record.sessionName || !isRestorableManagedSessionName(record.sessionName, managedSessionBaseName))
                continue;
            const sessionKey = getSessionContextKey(record.sessionName) ?? record.sessionName;
            const activeRank = branchResourceEvents.managedSessionActiveRanks.get(sessionKey);
            const closeRank = branchResourceEvents.managedSessionCloseRanks.get(sessionKey);
            if (activeRank === undefined || (closeRank !== undefined && closeRank >= activeRank))
                continue;
            trackOwnedManagedSession(ownedManagedSessions, record.sessionName, ctx.cwd, {
                branchOwned: true,
                headedManagedAutosaveDisabled: restoreManagedSessionHeadedAutosaveDisabledFromBranch(branch, record.sessionName),
                headedManagedAutosaveInterval: restoreManagedSessionHeadedAutosaveIntervalFromBranch(branch, record.sessionName),
            });
        }
        mergeActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords, {
            branchOwnedLaunchIds: branchOwnedElectronLaunchIds,
            markBranchOwned: true,
        });
        if (!options.resetRuntimeOwnership) {
            for (const sessionKey of previousAttachedSessionKeys) {
                if (ownedManagedSessions.has(sessionKey))
                    attachedSessionKeys.add(sessionKey);
            }
            for (const record of ownedElectronLaunchRecords.values()) {
                const sessionKey = getSessionContextKey(record.sessionName);
                if (sessionKey && previousAttachedSessionKeys.has(sessionKey))
                    attachedSessionKeys.add(sessionKey);
            }
        }
    };
    const registerWebSearchToolIfAvailable = (configState) => {
        if (webSearchToolRegistered || !canRegisterWebSearchTool(configState))
            return;
        pi.registerTool(createAgentBrowserWebSearchTool(configState, {
            loadConfigState(ctx) {
                return loadAgentBrowserConfigSync({
                    cwd: ctx.cwd,
                    includeProjectConfig: shouldIncludeProjectConfig(ctx),
                });
            },
        }));
        webSearchToolRegistered = true;
    };
    pi.on("session_start", async (_event, ctx) => {
        restoreBranchBackedState(ctx, { resetRuntimeOwnership: true });
        electronChildProcesses = new Map();
        registerWebSearchToolIfAvailable(loadAgentBrowserConfigSync({
            cwd: ctx.cwd,
            includeProjectConfig: shouldIncludeProjectConfig(ctx),
        }));
        await artifactExecutionQueue.run(() => managedSessionExecutionQueue.run(async () => {
            await recoverScriptSessionLeasesWithinQueue(ctx);
            flushRecordingReservations();
            notifyRecordingPersistence(ctx);
        }));
    });
    pi.on("session_tree", async (_event, ctx) => {
        for (const controller of activeScriptControllers)
            controller.abort();
        await Promise.allSettled([...activeScriptExecutions]);
        await artifactExecutionQueue.run(() => managedSessionExecutionQueue.run(async () => {
            restoreBranchBackedState(ctx, { resetRuntimeOwnership: false });
            await recoverScriptSessionLeasesWithinQueue(ctx);
            flushRecordingReservations();
            notifyRecordingPersistence(ctx);
        }));
    });
    pi.on("session_shutdown", async (event, ctx) => {
        for (const controller of activeScriptControllers)
            controller.abort();
        await Promise.allSettled([...activeScriptExecutions]);
        branchRestoreGeneration += 1;
        branchStateGeneration += 1;
        let preservedElectronProfileDirs = [];
        await artifactExecutionQueue.run(() => managedSessionExecutionQueue.run(async () => {
            const shutdownCwd = ctx?.cwd ?? managedSessionCwd;
            const quitting = event?.reason === "quit";
            preservedElectronProfileDirs = quitting
                ? []
                : getActiveElectronRecords(electronLaunchRecords).map((record) => record.userDataDir);
            const electronRecordsToCleanup = quitting
                ? ownedElectronLaunchRecords
                : getOffBranchOwnedElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords);
            const electronCleanupResults = await cleanupActiveElectronHostLaunches({
                attachedSessionKeys,
                cwd: shutdownCwd,
                electronChildProcesses,
                electronLaunchRecords: electronRecordsToCleanup,
                managedSessionRestoreState,
                ownedManagedSessions,
                timeoutMs: implicitSessionCloseTimeoutMs,
            });
            preservedElectronProfileDirs = [...new Set([
                    ...preservedElectronProfileDirs,
                    ...getCleanupResultsPreservedUserDataDirs(electronCleanupResults),
                ])];
            syncElectronCleanupManagedSessions(ownedManagedSessions, electronCleanupResults);
            for (const identity of getCleanupResultsClosedManagedSessionIdentities(electronCleanupResults))
                retireRecordingSession(identity.sessionName, identity.namespace);
            if (quitting) {
                await closeOwnedManagedSessionsExcept(ownedManagedSessions, managedSessionRestoreState, undefined, implicitSessionCloseTimeoutMs, attachedSessionKeys, undefined, (owner) => retireRecordingSession(owner.sessionName, owner.namespace));
            }
            else {
                await closeOwnedManagedSessionsExcept(ownedManagedSessions, managedSessionRestoreState, managedSessionActive ? managedSessionName : undefined, implicitSessionCloseTimeoutMs, attachedSessionKeys, managedSessionActive ? managedSessionNamespace : undefined, (owner) => retireRecordingSession(owner.sessionName, owner.namespace));
            }
            flushRecordingReservations();
            notifyRecordingPersistence(ctx);
        }));
        managedSessionActive = false;
        managedSessionCompatibilityWorkaround = undefined;
        managedSessionHeadedAutosaveDisabled = false;
        managedSessionHeadedAutosaveInterval = undefined;
        managedSessionNamespace = undefined;
        sessionPageState.reset();
        traceOwners = new Map();
        artifactManifest = undefined;
        if (!recordingReservationsDirty) {
            activeRecordingReservations = new Map();
            recordingSessionTombstones = new Map();
        }
        attachedSessionKeys = new Set();
        networkRoutesBySession = new Map();
        electronLaunchRecords = new Map();
        ownedElectronLaunchRecords = new Map();
        branchOwnedElectronLaunchIds = new Set();
        electronChildProcesses = new Map();
        ownedManagedSessions.clear();
        // local patch: vault + dev-server cleanup on shutdown (PATCHES.md P11, P20).
        clearVaultSecrets();
        clearVaultUnlockSession();
        await stopAllDevServers({});
        await cleanupSecureTempArtifacts({ preservePaths: preservedElectronProfileDirs });
    });
    pi.on("before_agent_start", async (event, ctx) => {
        if (!shouldAppendBrowserSystemPrompt(event.prompt)) {
            return undefined;
        }
        const runtimeConfig = loadAgentBrowserConfigSync({
            cwd: ctx.cwd,
            includeProjectConfig: shouldIncludeProjectConfig(ctx),
        });
        const browserGuidance = [
            runtimeConfig.browserExecutablePathScope === "project"
                ? buildBrowserExecutablePathGuideline(runtimeConfig.browserExecutablePath)
                : undefined,
            runtimeConfig.browserDefaultProfileScope === "project"
                ? buildBrowserDefaultProfileGuideline(runtimeConfig.browserDefaultProfile)
                : undefined,
        ].filter((line) => typeof line === "string" && line.length > 0);
        const runtimeConfigPrompt = browserGuidance.length > 0
            ? `\n\nProject agent_browser config guidance:\n${browserGuidance.map((line) => `- ${line}`).join("\n")}`
            : "";
        return {
            systemPrompt: `${event.systemPrompt}\n\n${PROJECT_RULE_PROMPT}${runtimeConfigPrompt}`,
        };
    });
    pi.on("tool_call", async (event, ctx) => {
        const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
        if (isBashToolCallEvent(event) &&
            !promptPolicy.allowLegacyAgentBrowserBash &&
            looksLikeDirectAgentBrowserBash(event.input.command) &&
            !isHarmlessAgentBrowserInspectionCommand(event.input.command) &&
            !(await isDirectAgentBrowserBashAllowed(ctx.cwd))) {
            return {
                block: true,
                reason: "Use the native agent_browser tool instead of bash for agent-browser in this environment.",
            };
        }
    });
    pi.on("tool_result", async (event) => buildAgentBrowserToolResultPatch(event));
    // local patch: slim schema — mode names only, no per-field docs; real validation stays in resolveAgentBrowserInput + CLI errors. Guide: docs/COMMAND_REFERENCE.md.
    const AGENT_BROWSER_PARAMS_SLIM = {
        type: "object",
        properties: Object.fromEntries([
            "script", "args", "semanticAction", "qa", "job", "electron", "debug", "settle", "networkBody",
            "vault", "checkpoint", "devServer", "login", "sourceLookup", "networkSourceLookup", "revealSecrets", "verbosity",
            "stdin", "outputPath", "timeoutMs", "sessionMode",
        ].map((k) => [k, {}])),
        additionalProperties: true,
    };
    // wave4 (live-sweep W-N1/W-N1b): the Pi runtime hands raw model params straight to execute and
    // only some hosts invoke prepareArguments, so normalization must live at module scope and run in
    // execute too. Providers stringify numeric companion params — a JSON-numeric "20000" reached the
    // timeoutMs validation as a string and failed; JSON-string args/stdin/mode-object forms are
    // parsed as documented. Idempotent: already-parsed values pass through unchanged.
    function normalizeAgentBrowserParams(input) {
        if (!input || typeof input !== "object" || Array.isArray(input)) return input;
        const out = { ...input };
        for (const key of ["args", "stdin"]) {
            // Some hosts JSON-decode param values and re-coerce arrays (comma-join); a caller can
            // survive that by double-encoding. Parse repeatedly (bounded) while the value is a
            // JSON-encoded string, stopping at the first array.
            for (let pass = 0; pass < 2 && typeof out[key] === "string"; pass += 1) {
                try {
                    const parsed = JSON.parse(out[key]);
                    if (Array.isArray(parsed) || typeof parsed === "string") out[key] = parsed;
                } catch {}
            }
        }
        if (typeof out.timeoutMs === "string" && out.timeoutMs.trim() !== "" && Number.isFinite(Number(out.timeoutMs))) {
            out.timeoutMs = Number(out.timeoutMs);
        }
        for (const key of ["semanticAction", "job", "qa", "electron", "debug", "settle", "networkBody", "vault", "checkpoint", "devServer", "login", "sourceLookup", "networkSourceLookup"]) {
            const value = out[key];
            if (typeof value === "string") {
                try {
                    const parsed = JSON.parse(value);
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out[key] = parsed;
                } catch {}
            }
        }
        return out;
    }
    const agentBrowserTool = {
        name: "agent_browser",
        prepareArguments: normalizeAgentBrowserParams,
        label: "Agent Browser",
        description: "Browser automation via agent-browser. Input modes (choose ONE per call): script (one-shot JS), args (raw argv), semanticAction, job (multi-step batch), qa, electron (desktop apps), debug, settle, networkBody, vault, checkpoint (auth-snapshot save/restore/list), devServer, login, sourceLookup, networkSourceLookup, revealSecrets, verbosity. Use for ALL browser work (always available). Full guide — READ before first use in a session: /home/yusuf/.pi/agent/extensions/pi-agent-browser-native/docs/COMMAND_REFERENCE.md",
        promptSnippet: "Browser automation: open/click/fill/scrape live pages; use for ALL browser work, guide in docs/COMMAND_REFERENCE.md.",
        promptGuidelines: toolPromptGuidelines,
        // local patch P28: some model providers/harnesses deliver array/object tool params as JSON strings
        // (pi core's own edit tool compensates for exactly this via prepareEditArguments). Without this,
        // `args` arrives as a string, Array.isArray fails, and every args-mode call reports
        // "Provide exactly one input mode" (zero modes supplied). JSON-parse stringified mode fields only.
        parameters: AGENT_BROWSER_PARAMS_SLIM,
        renderCall(args, theme, context) {
            const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
            text.setText(formatAgentBrowserRenderCall(args, theme, context.expanded));
            return text;
        },
        renderResult(result, options, theme, context) {
            const component = context.lastComponent instanceof AgentBrowserResultComponent
                ? context.lastComponent
                : new AgentBrowserResultComponent();
            component.setState(formatAgentBrowserRenderResult(result, options, theme, context.isError), options.expanded, theme);
            return component;
        },
        async execute(toolCallId, params, signal, onUpdate, ctx, nativeToolCallId = toolCallId) {
            // wave4 (W-N1b): normalize raw runtime params here too (see module note above).
            params = normalizeAgentBrowserParams(params);
            const promptPolicy = buildPromptPolicy(getLatestUserPrompt(ctx.sessionManager.getBranch()));
            const outputPath = isRecord(params) && typeof params.outputPath === "string" ? params.outputPath : undefined;
            const resolvedInput = resolveAgentBrowserInput({
                getBatchPreflightValidationError: (args, stdin) => getArtifactPreflightValidationError({ args, cwd: ctx.cwd, outputPath, stdin }),
                params,
            });
            if (resolvedInput.status === "invalid") {
                return buildValidationFailureResult(resolvedInput);
            }
            if (resolvedInput.kind !== "script")
                await beforeExecute?.(nativeToolCallId, { ...ctx, signal });
            const runtimeBrowserConfig = loadAgentBrowserConfigSync({ cwd: ctx.cwd, includeProjectConfig: shouldIncludeProjectConfig(ctx) });
            const rootProfile = runtimeBrowserConfig.trustedBrowserDefaultProfile;
            const pendingReadConfirmation = sessionPageState.findReadConfirmation(resolvedInput.toolArgs, resolveAgentBrowserNamespace(resolvedInput.toolArgs, getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE));
            const rootSessionId = process.env.PI_SUBAGENT_CHILD === "1" && process.env.PI_SUBAGENT_ROOT_SESSION_ID
                ? process.env.PI_SUBAGENT_ROOT_SESSION_ID : ctx.sessionManager.getSessionId();
            return withNativeSessionDefaults(resolvedInput, ctx.cwd, signal, async (resolvedInput, withLaunchDefaults) => {
                const readConfirmation = sessionPageState.findReadConfirmation(resolvedInput.toolArgs, resolveAgentBrowserNamespace(resolvedInput.toolArgs, getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE));
                if (readConfirmation)
                    resolvedInput = { ...resolvedInput, toolArgs: scopeReadConfirmationArgs(resolvedInput.toolArgs, readConfirmation) };
                if (resolvedInput.kind === "qa" && resolvedInput.compiledQaPreset.checks.attached && !managedSessionActive && !extractExplicitSessionName(resolvedInput.toolArgs)) {
                    return buildValidationFailureResult({ ...resolvedInput, attemptedKind: "qa", kind: "invalid", status: "invalid", validationError: "qa.attached requires an active attached session. Run electron.launch or connect to an Electron debug port first, or configure a native shared session." });
                }
                const applyUnserializedOutputPath = async (result, preserveTextContent = false) => {
                    if (!outputPath || !canWriteAgentBrowserOutput(result))
                        return warnRecordingPersistence(result);
                    return artifactExecutionQueue.run(async () => {
                        flushRecordingReservations();
                        const reservationError = getArtifactPreflightValidationError({
                            activeRecordingReservations: activeRecordingReservations.values(),
                            args: [],
                            cwd: ctx.cwd,
                            outputPath,
                        });
                        if (reservationError) {
                            return warnRecordingPersistence(buildValidationFailureResult({ attemptedKind: resolvedInput.kind, kind: "invalid", redactedArgs: resolvedInput.redactedArgs, status: "invalid", toolArgs: resolvedInput.toolArgs, toolStdin: resolvedInput.toolStdin, validationError: reservationError }));
                        }
                        return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, preserveTextContent, result: warnRecordingPersistence(result) });
                    });
                };
                const versionCheckCommand = extractUpstreamCommandTokens(resolvedInput.toolArgs)[0];
                const electronHostOnlyAction = resolvedInput.kind === "electron" && ["cleanup", "list", "status"].includes(resolvedInput.compiledElectron.action);
                const browserlessHostInput = resolvedInput.kind === "vault" || resolvedInput.kind === "devServer";
                const browserBackedVersionCheck = readConfirmation?.capabilities?.readRequiresConfirmation !== true && needsManagedSession(parseArgvDescriptor(resolvedInput.toolArgs), resolvedInput.toolStdin);
                if (resolvedInput.kind !== "script" && !electronHostOnlyAction && !browserlessHostInput && browserBackedVersionCheck && !isPlainTextInspectionArgs(resolvedInput.toolArgs) && !isCloseCommand(versionCheckCommand) && signal?.aborted !== true) {
                    const versionFailure = await validateUpstreamVersion(ctx.cwd, signal);
                    if (versionFailure)
                        return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, result: versionFailure });
                }
                if (resolvedInput.kind === "script") {
                    if (!ctx.sessionManager.getSessionFile()) {
                        return buildValidationFailureResult({
                            attemptedKind: "script",
                            kind: "invalid",
                            redactedArgs: [],
                            status: "invalid",
                            toolArgs: [],
                            validationError: "script requires a persisted Pi session so its isolated browser-session cleanup lease survives restart; relaunch Pi without --no-session.",
                        });
                    }
                    const sessionName = createAgentBrowserScriptSessionName();
                    const innerResults = [];
                    const scriptTimeoutMs = params.timeoutMs ?? AGENT_BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS;
                    const deadline = Date.now() + scriptTimeoutMs;
                    let leased = false;
                    let cleanupError;
                    let run = {
                        callCount: 0,
                        emitCount: 0,
                        error: "Script sandbox execution failed.",
                        failureCategory: "upstream-error",
                        ok: false,
                        rejectedCallCount: 0,
                        steps: [],
                    };
                    const scriptController = new AbortController();
                    const abortScript = () => scriptController.abort();
                    signal?.addEventListener("abort", abortScript, { once: true });
                    if (signal?.aborted)
                        scriptController.abort();
                    activeScriptControllers.add(scriptController);
                    let finishScriptExecution;
                    const scriptExecution = new Promise((resolve) => {
                        finishScriptExecution = resolve;
                    });
                    activeScriptExecutions.add(scriptExecution);
                    try {
                        // Keep preflight inside shutdown tracking so quit cannot race into starting the sandbox afterward.
                        const versionFailure = await withIsolatedAgentBrowserEnvironment(() => validateUpstreamVersion(ctx.cwd, scriptController.signal));
                        if (versionFailure)
                            return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, result: versionFailure });
                        const pendingRun = runAgentBrowserScript({
                            beforeFirstCall() {
                                appendScriptSessionLease(pi, sessionName, "active");
                                trackOwnedManagedSession(ownedManagedSessions, sessionName, ctx.cwd, { namespace: AGENT_BROWSER_SCRIPT_NAMESPACE });
                                managedSessionRestoreState.disable(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE);
                                // This fresh, unselectable lease owns any daemon its first read starts.
                                managedSessionRestoreState.recordDaemonRestoreKey(sessionName, AGENT_BROWSER_SCRIPT_NAMESPACE, null);
                                leased = true;
                            },
                            code: resolvedInput.compiledScript.code,
                            dispatch: async (innerParams, innerSignal) => {
                                const remainingMs = Math.max(1, deadline - Date.now());
                                const innerTimeoutMs = Math.min(innerParams.timeoutMs ?? remainingMs, remainingMs);
                                const innerResult = await withIsolatedAgentBrowserEnvironment(() => agentBrowserTool.execute(`${toolCallId}:script:${innerResults.length + 1}`, {
                                    args: ["--namespace", AGENT_BROWSER_SCRIPT_NAMESPACE, "--session", sessionName, ...innerParams.args],
                                    stdin: innerParams.stdin,
                                    timeoutMs: innerTimeoutMs,
                                }, innerSignal, undefined, ctx, nativeToolCallId));
                                innerResults.push(innerResult);
                                return await buildScriptBrowserEnvelope(innerResult, innerParams.args, sessionName);
                            },
                            signal: scriptController.signal,
                            timeoutMs: scriptTimeoutMs,
                        });
                        run = await pendingRun;
                    }
                    catch { }
                    finally {
                        activeScriptControllers.delete(scriptController);
                        signal?.removeEventListener("abort", abortScript);
                        if (leased) {
                            try {
                                cleanupError = await artifactExecutionQueue.run(() => managedSessionExecutionQueue.run(() => {
                                    flushRecordingReservations();
                                    return closeScriptSessionLeaseWithinQueue(sessionName, ctx.cwd);
                                }));
                            }
                            catch {
                                cleanupError = "The isolated script session cleanup operation failed.";
                                try {
                                    appendScriptSessionLease(pi, sessionName, "failed");
                                }
                                catch { }
                            }
                        }
                        activeScriptExecutions.delete(scriptExecution);
                        finishScriptExecution();
                    }
                    let scriptResult = buildScriptToolResult({ cleanupError, innerResults, run, sessionName: leased ? sessionName : undefined });
                    if (artifactManifest) {
                        scriptResult = {
                            ...scriptResult,
                            details: {
                                ...(isRecord(scriptResult.details) ? scriptResult.details : {}),
                                artifactManifest: redactSensitiveValue(artifactManifest),
                                artifactRetentionSummary: formatSessionArtifactRetentionSummary(artifactManifest),
                            },
                        };
                    }
                    return applyUnserializedOutputPath(scriptResult);
                }
                const { toolArgs } = resolvedInput;
                const compiledElectron = resolvedInput.kind === "electron" ? resolvedInput.compiledElectron : undefined;
                const redactedCompiledElectron = resolvedInput.kind === "electron" ? resolvedInput.redactedCompiledElectron : undefined;
                const runElectronHostInput = async () => {
                    const electronHostLaunchRecords = getElectronHostLaunchRecordsForInput({
                        branchRecords: electronLaunchRecords,
                        compiledElectron,
                        ownedRecords: ownedElectronLaunchRecords,
                    });
                    let electronHostResult = await handleElectronHostInput({
                        attachedSessionKeys,
                        compiledElectron,
                        cwd: ctx.cwd,
                        electronChildProcesses,
                        electronLaunchRecords: electronHostLaunchRecords,
                        implicitSessionCloseTimeoutMs,
                        managedSessionActive,
                        managedSessionName,
                        managedSessionNamespace,
                        managedSessionRestoreState,
                        ownedManagedSessions,
                        redactedCompiledElectron,
                        sessionPageState,
                        signal,
                    });
                    if (electronHostResult && compiledElectron?.action === "cleanup") {
                        branchStateGeneration += 1;
                        const cleanupRecords = isRecord(electronHostResult.details)
                            && isRecord(electronHostResult.details.electron)
                            && isRecord(electronHostResult.details.electron.cleanup)
                            && Array.isArray(electronHostResult.details.electron.cleanup.results)
                            ? electronHostResult.details.electron.cleanup.results
                            : [];
                        const cleanedLaunchIds = new Set();
                        for (const cleanupResult of cleanupRecords) {
                            if (isRecord(cleanupResult) && isElectronLaunchRecord(cleanupResult.record)) {
                                cleanedLaunchIds.add(cleanupResult.record.launchId);
                            }
                        }
                        replaceWithActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronHostLaunchRecords, branchOwnedElectronLaunchIds, cleanedLaunchIds);
                        mergeElectronCleanupRecords(electronLaunchRecords, cleanupRecords);
                        const cleanupNamespace = isRecord(electronHostResult.details) && typeof electronHostResult.details.namespace === "string"
                            ? electronHostResult.details.namespace
                            : undefined;
                        const closedSessionIdentities = getCleanupResultsClosedManagedSessionIdentities(cleanupRecords, cleanupNamespace);
                        syncElectronCleanupManagedSessions(ownedManagedSessions, cleanupRecords, cleanupNamespace);
                        for (const identity of closedSessionIdentities) {
                            retireRecordingSession(identity.sessionName, identity.namespace);
                            const closedSessionKey = getSessionContextKey(identity.sessionName, identity.namespace) ?? identity.sessionName;
                            clearSessionScopedBrowserState(closedSessionKey);
                            if (closedSessionKey === (getSessionContextKey(managedSessionName, managedSessionNamespace) ?? managedSessionName)) {
                                managedSessionActive = false;
                                managedSessionCompatibilityWorkaround = undefined;
                                managedSessionHeadedAutosaveDisabled = false;
                                managedSessionHeadedAutosaveInterval = undefined;
                                managedSessionNamespace = undefined;
                                freshSessionOrdinal += 1;
                                managedSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal);
                            }
                        }
                        if (artifactManifest) {
                            electronHostResult = {
                                ...electronHostResult,
                                details: {
                                    ...(isRecord(electronHostResult.details) ? electronHostResult.details : {}),
                                    artifactManifest: redactSensitiveValue(artifactManifest),
                                    artifactRetentionSummary: formatSessionArtifactRetentionSummary(artifactManifest),
                                },
                            };
                        }
                    }
                    return electronHostResult;
                };
                const runSerializedElectronHostInput = () => shouldSerializeElectronHostInput(compiledElectron)
                    ? managedSessionExecutionQueue.run(runElectronHostInput)
                    : runElectronHostInput();
                const electronHostResult = compiledElectron?.action === "cleanup"
                    ? await artifactExecutionQueue.run(async () => {
                        flushRecordingReservations();
                        const reservationError = outputPath ? getArtifactPreflightValidationError({
                            activeRecordingReservations: activeRecordingReservations.values(),
                            args: [],
                            cwd: ctx.cwd,
                            outputPath,
                        }) : undefined;
                        if (reservationError) {
                            return warnRecordingPersistence(buildValidationFailureResult({ attemptedKind: resolvedInput.kind, kind: "invalid", redactedArgs: resolvedInput.redactedArgs, status: "invalid", toolArgs: resolvedInput.toolArgs, toolStdin: resolvedInput.toolStdin, validationError: reservationError }));
                        }
                        const result = await runSerializedElectronHostInput();
                        return result ? applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, result: warnRecordingPersistence(result) }) : result;
                    })
                    : await runSerializedElectronHostInput();
                if (electronHostResult) {
                    return compiledElectron?.action === "cleanup" ? electronHostResult : applyUnserializedOutputPath(electronHostResult);
                }
                // local patch: vault, login preset, and dev-server are host inputs - they run here instead of
                // going through the browser argv pipeline, and each browser call they need is dispatched back
                // through this same tool executor so normal session handling, guards and redaction still apply
                // (PATCHES.md P11, P20, P22).
                if (resolvedInput.kind === "vault" || resolvedInput.kind === "devServer" || resolvedInput.kind === "login" || resolvedInput.kind === "cdp") {
                    let hostCallCount = 0;
                    const hostDispatch = async (params) => {
                        hostCallCount += 1;
                        return await agentBrowserTool.execute(`${toolCallId}:${resolvedInput.kind}:${hostCallCount}`, params, signal, undefined, ctx, nativeToolCallId);
                    };
                    const hostResult = resolvedInput.kind === "vault"
                        ? await handleVaultHostInput({ compiled: resolvedInput.compiledVault, ctx, dispatch: hostDispatch })
                        : resolvedInput.kind === "login"
                            ? await handleLoginHostInput({ compiled: resolvedInput.compiledLogin, dispatch: hostDispatch })
                            : resolvedInput.kind === "cdp"
                                ? await handleCdpHostInput({ compiled: resolvedInput.compiledCdp, dispatch: hostDispatch, signal })
                                : await handleDevServerHostInput({ cwd: ctx.cwd, input: resolvedInput.compiledDevServer });
                    return applyUnserializedOutputPath(hostResult);
                }
                const explicitSessionName = extractExplicitSessionName(toolArgs);
                const callerOwnedSessionNamespace = explicitSessionName
                    ? resolveAgentBrowserNamespace(toolArgs, getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE)
                    : undefined;
                const serializeBrowserCommand = shouldSerializeBrowserCommand({
                    namespace: callerOwnedSessionNamespace,
                    explicitSessionName,
                    managedSessionName,
                    ownedElectronLaunchRecords,
                    ownedManagedSessions,
                });
                const callerOwnedSessionQueueKey = !serializeBrowserCommand && explicitSessionName
                    ? getSessionContextKey(explicitSessionName, callerOwnedSessionNamespace) ?? explicitSessionName
                    : undefined;
                const runBrowserCommand = async (daemonInactive) => {
                    flushRecordingReservations();
                    const branchRestoreGenerationAtStart = branchRestoreGeneration;
                    const generationAtStart = branchStateGeneration;
                    const sessionPageStateUpdate = sessionPageState.beginUpdate();
                    const browserRunState = {
                        activeRecordingReservations,
                        artifactManifest,
                        attachedSessionKeys,
                        closedManagedSessionNames: new Set(),
                        electronChildProcesses,
                        electronLaunchRecords,
                        ephemeralSessionSeed,
                        freshSessionOrdinal,
                        managedSessionActive,
                        managedSessionBaseName,
                        managedSessionCompatibilityWorkaround,
                        managedSessionHeadedAutosaveDisabled,
                        managedSessionHeadedAutosaveInterval,
                        managedSessionCwd,
                        managedSessionName,
                        managedSessionNamespace,
                        managedSessionRestoreState,
                        networkRoutesBySession,
                        ownedManagedSessions,
                        sessionPageState,
                        traceOwners,
                    };
                    const selectedPlan = buildExecutionPlan(toolArgs, {
                        freshSessionName: createFreshSessionName(browserRunState.managedSessionBaseName, browserRunState.ephemeralSessionSeed, browserRunState.freshSessionOrdinal + 1),
                        managedSessionActive: browserRunState.managedSessionActive,
                        managedSessionCompatibilityWorkaround: browserRunState.managedSessionCompatibilityWorkaround,
                        managedSessionName: browserRunState.managedSessionName,
                        managedSessionNamespace: browserRunState.managedSessionNamespace,
                        sessionMode: compiledElectron?.action === "launch" ? "fresh" : params.sessionMode ?? "auto",
                        stdin: resolvedInput.toolStdin,
                        browserIndependentReadConfirmation: readConfirmation?.capabilities?.readRequiresConfirmation === true,
                    });
                    const initialArtifactManifest = browserRunState.artifactManifest;
                    const initialNetworkRoutesBySession = browserRunState.networkRoutesBySession;
                    const attachedSessionRequested = isAttachedBrowserInvocation(toolArgs)
                        || (resolvedInput.kind === "electron" && resolvedInput.compiledElectron.action === "launch");
                    const allocatesFreshManagedSession = explicitSessionName === undefined
                        && (params.sessionMode === "fresh" || (resolvedInput.kind === "electron" && resolvedInput.compiledElectron.action === "launch"));
                    const reusableSessionKey = allocatesFreshManagedSession
                        ? undefined
                        : getSessionContextKey(selectedPlan.sessionName, selectedPlan.namespace)
                            ?? getSessionContextKey(browserRunState.managedSessionName, browserRunState.managedSessionNamespace);
                    const attachedSessionKnown = reusableSessionKey !== undefined && attachedSessionKeys.has(reusableSessionKey);
                    let result = await runAgentBrowserTool({
                        daemonInactive,
                        ctx,
                        cwd: ctx.cwd,
                        electronPostCommandStatusSettleMs: ELECTRON_POST_COMMAND_STATUS_SETTLE_MS,
                        electronProfileIsolationDetails: ELECTRON_PROFILE_ISOLATION_DETAILS,
                        implicitSessionCloseTimeoutMs,
                        implicitSessionIdleTimeoutMs,
                        input: resolvedInput,
                        onUpdate,
                        params,
                        establishAttachedBrowserSession: attachedSessionRequested && !attachedSessionKnown,
                        preserveAttachedBrowserSession: attachedSessionRequested || attachedSessionKnown,
                        promptPolicy,
                        sessionPageStateUpdate,
                        signal,
                        state: browserRunState,
                    });
                    const branchRestoreStillCurrent = branchRestoreGenerationAtStart === branchRestoreGeneration;
                    const resultDetails = isRecord(result.details) ? result.details : undefined;
                    const resultSessionName = typeof resultDetails?.sessionName === "string"
                        ? resultDetails.sessionName
                        : extractExplicitSessionName(toolArgs);
                    const resultNamespace = typeof resultDetails?.namespace === "string"
                        ? resultDetails.namespace
                        : selectedPlan.namespace;
                    if (branchRestoreStillCurrent) {
                        const resultBatchCloseLifecycle = getSuccessfulBatchCloseLifecycle(resultDetails?.batchSteps);
                        const resultSessionKey = getSessionContextKey(resultSessionName, resultNamespace) ?? resultSessionName;
                        const managedSessionOutcome = isRecord(resultDetails?.managedSessionOutcome) ? resultDetails.managedSessionOutcome : undefined;
                        const closeAllApplied = resultDetails?.closeAllApplied === true;
                        const attachedSessionRemainsActive = result.isError !== true
                            || ((attachedSessionRequested || attachedSessionKnown) && managedSessionOutcome?.activeAfter === true);
                        const closesAttachedSession = (result.isError !== true && isCloseCommand(extractUpstreamCommandTokens(toolArgs)[0]))
                            || resultBatchCloseLifecycle?.endsClosed === true;
                        if (closeAllApplied) {
                            deleteIdentityKeysInNamespace(attachedSessionKeys, resultNamespace);
                            if (resultSessionKey && attachedSessionRemainsActive && (attachedSessionRequested || attachedSessionKnown) && resultBatchCloseLifecycle?.endsClosed === false) {
                                attachedSessionKeys.add(resultSessionKey);
                                result = { ...result, details: { ...(resultDetails ?? {}), attachedBrowserSession: true } };
                            }
                        }
                        else if (resultSessionKey && closesAttachedSession)
                            attachedSessionKeys.delete(resultSessionKey);
                        else if (resultSessionKey && attachedSessionRemainsActive && (attachedSessionRequested || attachedSessionKnown)) {
                            attachedSessionKeys.add(resultSessionKey);
                            result = { ...result, details: { ...(resultDetails ?? {}), attachedBrowserSession: true } };
                        }
                    }
                    if (branchRestoreStillCurrent) {
                        networkRoutesBySession = mergeBrowserRunMap(networkRoutesBySession, initialNetworkRoutesBySession, browserRunState.networkRoutesBySession);
                        artifactManifest = mergeBrowserRunArtifactManifest(artifactManifest, initialArtifactManifest, browserRunState.artifactManifest);
                        const handledBatchCloseKeys = syncRecordingReservationsFromResult(result);
                        if (resultDetails?.closeAllApplied === true) {
                            for (const [sessionKey, reservation] of [...activeRecordingReservations]) {
                                if (isAgentBrowserSessionIdentityKeyInNamespace(sessionKey, resultNamespace)) {
                                    retireRecordingSession(reservation.sessionName, reservation.namespace);
                                }
                            }
                        }
                        for (const closedSessionKey of browserRunState.closedManagedSessionNames) {
                            if (handledBatchCloseKeys.has(closedSessionKey))
                                continue;
                            const reservation = activeRecordingReservations.get(closedSessionKey);
                            if (reservation)
                                retireRecordingSession(reservation.sessionName, reservation.namespace);
                        }
                        if (resultSessionName) {
                            const reservation = activeRecordingReservations.get(getAgentBrowserSessionIdentityKey(resultSessionName, resultNamespace));
                            if (reservation)
                                result = appendActiveRecordingCleanupAction(result, reservation);
                        }
                        if (artifactManifest) {
                            result = {
                                ...result,
                                details: {
                                    ...(isRecord(result.details) ? result.details : {}),
                                    artifactManifest: redactSensitiveValue(artifactManifest),
                                    artifactRetentionSummary: formatSessionArtifactRetentionSummary(artifactManifest),
                                },
                            };
                        }
                    }
                    const branchStateStillCurrent = generationAtStart === branchStateGeneration;
                    if (serializeBrowserCommand || branchStateStillCurrent) {
                        freshSessionOrdinal = Math.max(freshSessionOrdinal, browserRunState.freshSessionOrdinal);
                        managedSessionActive = browserRunState.managedSessionActive;
                        managedSessionCompatibilityWorkaround = browserRunState.managedSessionCompatibilityWorkaround;
                        managedSessionHeadedAutosaveDisabled = browserRunState.managedSessionHeadedAutosaveDisabled === true;
                        managedSessionHeadedAutosaveInterval = browserRunState.managedSessionHeadedAutosaveInterval;
                        managedSessionCwd = browserRunState.managedSessionCwd;
                        managedSessionName = browserRunState.managedSessionName;
                        managedSessionNamespace = browserRunState.managedSessionNamespace;
                        for (const closedSessionName of browserRunState.closedManagedSessionNames) {
                            untrackOwnedManagedSession(ownedManagedSessions, closedSessionName);
                        }
                        syncOwnedManagedSessionsFromResult(ownedManagedSessions, result, browserRunState.managedSessionCwd);
                        mergeActiveElectronLaunchRecords(ownedElectronLaunchRecords, electronLaunchRecords, {
                            branchOwnedLaunchIds: branchOwnedElectronLaunchIds,
                            touchedLaunchIds: !result.isError
                                ? getTouchedElectronLaunchIds(explicitSessionName ?? browserRunState.managedSessionName, electronLaunchRecords, resultNamespace)
                                : undefined,
                        });
                        if (serializeBrowserCommand)
                            branchStateGeneration += 1;
                    }
                    return applyAgentBrowserOutputPath({ cwd: ctx.cwd, outputPath, preserveTextContent: Array.isArray(params.args) && params.args.includes("--json"), result: warnRecordingPersistence(result) });
                };
                const closesAllSessions = commandClosesAllSessions(toolArgs, resolvedInput.toolStdin);
                const runWithLaunchDefaults = () => withLaunchDefaults ? withLaunchDefaults(runBrowserCommand) : runBrowserCommand();
                const runWithinSessionQueue = () => {
                    if (closesAllSessions)
                        return managedSessionExecutionQueue.run(() => {
                            const plan = buildExecutionPlan(toolArgs, {
                                freshSessionName: createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1),
                                managedSessionActive,
                                managedSessionCompatibilityWorkaround,
                                managedSessionName,
                                managedSessionNamespace,
                                sessionMode: params.sessionMode ?? "auto",
                                stdin: resolvedInput.toolStdin,
                            });
                            return callerOwnedSessionExecutionQueues.runExclusive(plan.namespace, runWithLaunchDefaults);
                        });
                    if (serializeBrowserCommand)
                        return managedSessionExecutionQueue.run(runWithLaunchDefaults);
                    return callerOwnedSessionQueueKey
                        ? callerOwnedSessionExecutionQueues.run(callerOwnedSessionQueueKey, callerOwnedSessionNamespace, runWithLaunchDefaults)
                        : runWithLaunchDefaults();
                };
                if (!commandTouchesArtifactLifecycle(toolArgs, resolvedInput.toolStdin, outputPath))
                    return runWithinSessionQueue();
                return artifactExecutionQueue.run(async () => {
                    const artifactValidationError = getArtifactPreflightValidationError({
                        activeRecordingReservations: activeRecordingReservations.values(),
                        args: toolArgs,
                        cwd: ctx.cwd,
                        outputPath,
                        stdin: resolvedInput.toolStdin,
                    });
                    if (!artifactValidationError)
                        return runWithinSessionQueue();
                    flushRecordingReservations();
                    return warnRecordingPersistence(buildValidationFailureResult({
                        attemptedKind: resolvedInput.kind,
                        kind: "invalid",
                        redactedArgs: resolvedInput.redactedArgs,
                        status: "invalid",
                        toolArgs: resolvedInput.toolArgs,
                        toolStdin: resolvedInput.toolStdin,
                        validationError: artifactValidationError,
                    }));
                });
            }, managedSessionActive || freshSessionOrdinal > 0 || params.sessionMode === "fresh" || pendingReadConfirmation ? undefined : {
                id: rootSessionId,
                profile: rootProfile?.policy === "always" && !/[\\/~]/.test(rootProfile.name) ? rootProfile.name : undefined,
                executablePath: runtimeBrowserConfig.trustedBrowserExecutablePath,
            });
        },
    };
    // local patch: opt-in tool activation gate (PATCHES.md P21).
    // The tool's schema plus guidelines are present in the system prompt on every turn, which is wasted in
    // sessions that never browse. Default stays "always" so existing workflows (and AGENTS.md rules that
    // require agent_browser) keep working; setting PI_AGENT_BROWSER_TOOL_ACTIVATION=opt-in makes the tools
    // inactive until /agentbrowser on, and the choice is persisted per session through a custom entry.
    const ACTIVATION_ENTRY_TYPE = "agent-browser-tools";
    const AGENT_BROWSER_TOOL_NAMES = ["agent_browser", "agent_browser_web_search"];
    const toolActivationMode = String(process.env.PI_AGENT_BROWSER_TOOL_ACTIVATION ?? "always").trim().toLowerCase();
    const toolActivationOptIn = toolActivationMode === "opt-in" || toolActivationMode === "off" || toolActivationMode === "manual";
    const applyToolActivation = (enabled) => {
        try {
            if (typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
                const active = new Set(pi.getActiveTools());
                for (const name of AGENT_BROWSER_TOOL_NAMES) {
                    if (enabled)
                        active.add(name);
                    else
                        active.delete(name);
                }
                pi.setActiveTools([...active]);
            }
        }
        catch {
            // Hosts that do not expose tool activation simply keep the tools active.
        }
    };
    const readToolActivationFromBranch = (ctx) => {
        let enabled = false;
        try {
            for (const entry of ctx?.sessionManager?.getEntries?.() ?? []) {
                if (entry.type === "custom" && entry.customType === ACTIVATION_ENTRY_TYPE) {
                    const data = entry.data;
                    if (data && typeof data.on === "boolean")
                        enabled = data.on;
                }
            }
        }
        catch { /* unavailable session manager: default to inactive */ }
        return enabled;
    };
    pi.on("session_start", async (_event, ctx) => {
        if (!toolActivationOptIn)
            return;
        applyToolActivation(readToolActivationFromBranch(ctx));
    });
    if (typeof pi.registerCommand === "function") {
        pi.registerCommand("agentbrowser", {
            description: "Browser tools: '/agentbrowser on' to activate, '/agentbrowser off' to deactivate, bare for status",
            handler: async (args, ctx) => {
                const command = String(args ?? "").trim().toLowerCase();
                if (command === "on" || command === "enable") {
                    applyToolActivation(true);
                    pi.appendEntry?.(ACTIVATION_ENTRY_TYPE, { on: true });
                    ctx?.ui?.notify?.("agent_browser tools activated for this session", "info");
                    return;
                }
                if (command === "off" || command === "disable") {
                    applyToolActivation(false);
                    pi.appendEntry?.(ACTIVATION_ENTRY_TYPE, { on: false });
                    ctx?.ui?.notify?.("agent_browser tools deactivated (the managed browser keeps running until Pi exits or you close it)", "info");
                    return;
                }
                const state = toolActivationOptIn
                    ? (readToolActivationFromBranch(ctx) ? "active" : "inactive (run /agentbrowser on)")
                    : `always active (PI_AGENT_BROWSER_TOOL_ACTIVATION=${toolActivationMode})`;
                ctx?.ui?.notify?.(`agent_browser tools: ${state}`, "info");
            },
        });
    }
    pi.registerTool(beforeExecute ? { ...agentBrowserTool, executionMode: "sequential" } : agentBrowserTool);
    registerWebSearchToolIfAvailable(agentBrowserConfig);
}
