import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { extractExplicitSessionName, checkpointSessionNameForId, getBooleanFlagValue, isCheckpointSessionName, isUpstreamEnvFlagEnabled, projectUpstreamGlobalFlags, resolveAgentBrowserNamespace } from "../../argv-grammar.js";
import { isCloseCommand } from "../../command-taxonomy.js";
import { isBrowserIndependentRead, needsManagedSession } from "../../command-policy.js";
import { parseArgvDescriptor } from "../../argv-descriptor.js";
import { prepareAgentBrowserSpawnArgs, withChromeStartupArgs } from "../../process.js";
import { cleanupElectronLaunchResources } from "../../electron/cleanup.js";
import { launchElectronApp } from "../../electron/launch.js";
import { pathExists } from "../../fs-utils.js";
import { getCompiledSemanticActionSessionPrefix } from "../../input-modes/semantic-action.js";
// local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7).
import { resolveCheckpointGateDecision } from "../../input-modes/checkpoint.js";
import { buildRestoreBatchRows, decryptCheckpoint, describeCheckpointEnvelope, getCheckpointTtlDays, isCheckpointExpired, listCheckpoints, readCheckpoint, reapStaleCheckpointTempFiles, writeCheckpointTempFile } from "../../vault/checkpoint-store.js";
import { registerVaultSecret } from "../../vault/secret-registry.js";
import { tryDirectAnchorDownload } from "./prepare/direct-anchor-download.js";
import { tryNetworkRequestsPageFilter } from "./prepare/network-page-filter.js";
import { tryContainerScroll, tryPageScrollTo } from "./prepare/scroll-shims.js";
import { trySnapshotFilter } from "./prepare/snapshot-filter.js";
import { commandTimeoutNeedsActivePageUrl, getCommandAwareProcessTimeoutMs } from "./prepare/wait-timeouts.js";
import { getPersistentSessionArtifactStore } from "./session-state.js";
import { buildAgentBrowserResultCategoryDetails } from "../../results/categories.js";
import { applyNamespaceToNextActions } from "../../results/next-actions.js";
import { buildSessionAwareStaleRefNextActions, buildSessionTabRecoveryNextActions } from "../../results/recovery-next-actions.js";
import { resolveVisibleRefActionFromSnapshot } from "../../results/selector-recovery.js";
import { buildPageTransitionRefSnapshotInvalidation, extractRefSnapshotFromData, normalizeComparableUrl } from "../../session-page-state.js";
import { buildExecutionPlan, canUseHeadlessCompatibilityUserAgent, createFreshSessionName, extractCommandTokens, extractUpstreamCommandTokens, getDefaultHeadlessCompatUserAgent, parseWaitCommandTokens, redactInvocationArgs, redactSensitiveText, } from "../../runtime.js";
import { buildOwnedManagedSessionRestoreContext, resolveExplicitAutosaveInterval, withOwnedManagedSessionContext, } from "../../managed-session-restore.js";
import { getAgentBrowserProcessEnvironment } from "../../process-environment.js";
import { getExplicitSessionPageVerificationRequirement, getPageTargetValidationError, } from "../../page-target-validation.js";
import { acquireOwnedManagedSessionDaemonPolicy, getRunningHeadedAutosavePolicyChangeError, inspectManagedSessionDaemon } from "./managed-session-daemon-policy.js";
import { buildManagedSessionOutcome, buildSessionDetailFields, buildStaleRefPreflight, getSessionContextKey, findElectronLaunchRecordForSession, extractStringResultField, ensureSessionTabTarget, getGuardedRefUsage, getTraceOwnerGuardMessage, runSessionCommandData, shouldPinSessionTabForCommand, } from "./session-state.js";
import { getUpstreamEffectiveBatchSteps, parseBatchStdinJsonArray } from "../batch-stdin.js";
import { buildElectronHostFailureResult, formatAgentBrowserNextActionsText, getElectronLaunchFailureCategory, redactRecoveryHint } from "./final-result.js";
import { prepareClickDispatchProbe } from "./click-dispatch.js";
import { buildUnsupportedScrollIntoViewRecovery, collectScrollPositionSnapshot, validateQaAttachedPrecondition } from "./diagnostics.js";
import { getScreenshotPathTokenIndex } from "./artifact-paths.js";
import { findRequestedArtifactCloseViolation } from "./prompt-guards.js";
export function normalizeRunInput(input) {
    // local patch: carry the new transparent fields and input-mode echoes through the run plan
    // (PATCHES.md P13-P22) so presentation can report verbosity, reveal scope and the compiled plans.
    const base = { compiledCheckpoint: input.compiledCheckpoint, compiledDebug: input.compiledDebug, compiledLogin: input.compiledLogin, compiledNetworkBody: input.compiledNetworkBody, compiledScript: input.compiledScript, compiledSettle: input.compiledSettle, compiledVault: input.compiledVault, kind: input.kind, redactedArgs: input.redactedArgs, revealSecrets: input.revealSecrets, toolArgs: input.toolArgs, toolStdin: input.toolStdin, verbosity: input.verbosity };
    switch (input.kind) {
        case "electron":
            return { ...base, compiledElectron: input.compiledElectron, redactedCompiledElectron: input.redactedCompiledElectron };
        case "job":
            return { ...base, compiledJob: input.compiledJob, redactedCompiledJob: input.redactedCompiledJob };
        case "networkSourceLookup":
            return { ...base, compiledNetworkSourceLookup: input.compiledNetworkSourceLookup, redactedCompiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup };
        case "qa":
            return { ...base, compiledJob: input.compiledJob, compiledQaPreset: input.compiledQaPreset, redactedCompiledJob: input.redactedCompiledJob, redactedCompiledQaPreset: input.redactedCompiledQaPreset };
        case "semanticAction":
            return { ...base, compiledSemanticAction: input.compiledSemanticAction, redactedCompiledSemanticAction: input.redactedCompiledSemanticAction };
        case "sourceLookup":
            return { ...base, compiledSourceLookup: input.compiledSourceLookup, redactedCompiledSourceLookup: input.redactedCompiledSourceLookup };
        case "script":
        case "args":
            return base;
        default:
            // local patch fix (P17-P19): the new compiled kinds (debug, settle, networkBody) have no extra
            // compiled fields here, and a missing case returned undefined, which crashed prepareBrowserRun
            // with "Cannot destructure property 'compiledElectron'".
            return base;
    }
}
export function buildInvocationPreview(effectiveArgs) {
    const preview = effectiveArgs.join(" ");
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}
function getArtifactParentPathTokenIndex(commandTokens) {
    if (commandTokens[0] === "download" && commandTokens.length >= 3)
        return 2;
    if (commandTokens[0] === "pdf" && commandTokens.length >= 2)
        return 1;
    if (commandTokens[0] === "state" && commandTokens[1] === "save" && commandTokens.length >= 3)
        return 2;
    if (commandTokens[0] === "wait")
        return parseWaitCommandTokens(commandTokens).downloadPathIndex;
    return undefined;
}
async function ensureArtifactParentDirectory(commandTokens, cwd) {
    const pathIndex = getArtifactParentPathTokenIndex(commandTokens);
    if (pathIndex === undefined)
        return;
    const requestedPath = commandTokens[pathIndex];
    if (!requestedPath)
        return;
    await mkdir(dirname(resolve(cwd, requestedPath)), { recursive: true });
}
async function normalizeScreenshotPathInTokens(commandTokens, cwd, batchStep = false) {
    // Native batch rows skip outer CLI global-flag cleanup.
    const projection = batchStep ? undefined : projectUpstreamGlobalFlags(commandTokens);
    const pathIndex = getScreenshotPathTokenIndex(projection?.tokens ?? commandTokens);
    const screenshotPathTokenIndex = pathIndex === undefined ? undefined : projection ? projection.indices[pathIndex] : pathIndex;
    if (screenshotPathTokenIndex === undefined)
        return { tokens: commandTokens };
    const requestedPath = commandTokens[screenshotPathTokenIndex];
    const absolutePath = resolve(cwd, requestedPath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const tokens = [...commandTokens];
    tokens[screenshotPathTokenIndex] = absolutePath;
    const terminatorIndex = batchStep ? -1 : tokens.indexOf("--");
    if (terminatorIndex >= 0) {
        tokens.splice(terminatorIndex, 1);
    }
    return {
        request: {
            absolutePath,
            path: requestedPath,
        },
        tokens,
    };
}
async function prepareBatchScreenshotPaths(args, stdin, cwd) {
    const commandTokens = extractUpstreamCommandTokens(args);
    if (commandTokens[0] !== "batch") {
        return undefined;
    }
    const argumentSteps = getUpstreamEffectiveBatchSteps(commandTokens, undefined);
    if (argumentSteps.length > 0) {
        // Upstream executes raw argument steps exclusively and ignores stdin, so
        // prepare parent directories for the rows that will run and skip stdin
        // preparation (no directories for never-executed rows).
        for (const step of argumentSteps) {
            await ensureArtifactParentDirectory(step, cwd);
            if (step[0] === "screenshot") {
                // Reuse the screenshot path resolution for its parent-directory side
                // effect only: raw strings are never rewritten, so the normalized
                // tokens and path request are deliberately discarded.
                await normalizeScreenshotPathInTokens(step, cwd, true);
            }
        }
        return undefined;
    }
    if (stdin === undefined) {
        return undefined;
    }
    const parsed = parseBatchStdinJsonArray(stdin);
    if (parsed.error || parsed.steps === undefined) {
        return undefined;
    }
    let changed = false;
    const batchScreenshotPathRequests = [];
    const preparedSteps = await Promise.all(parsed.steps.map(async (step, index) => {
        if (!Array.isArray(step) || !step.every((item) => typeof item === "string")) {
            return step;
        }
        await ensureArtifactParentDirectory(step, cwd);
        if (step[0] !== "screenshot") {
            return step;
        }
        const normalized = await normalizeScreenshotPathInTokens(step, cwd, true);
        batchScreenshotPathRequests[index] = normalized.request;
        if (normalized.request) {
            changed = true;
        }
        return normalized.tokens;
    }));
    return changed
        ? {
            args,
            batchScreenshotPathRequests,
            stdin: JSON.stringify(preparedSteps),
        }
        : undefined;
}
export async function prepareAgentBrowserArgs(args, stdin, cwd) {
    const preparedBatch = await prepareBatchScreenshotPaths(args, stdin, cwd);
    if (preparedBatch) {
        return preparedBatch;
    }
    const commandTokens = extractCommandTokens(args);
    await ensureArtifactParentDirectory(extractUpstreamCommandTokens(args), cwd);
    const normalized = await normalizeScreenshotPathInTokens(commandTokens, cwd);
    if (!normalized.request) {
        return { args };
    }
    const commandStartIndex = args.length - commandTokens.length;
    return {
        args: [...args.slice(0, commandStartIndex), ...normalized.tokens],
        screenshotPathRequest: normalized.request,
    };
}
async function repairScreenshotData(options) {
    const { cwd, data, request } = options;
    const reportedPath = typeof data.path === "string" ? data.path : undefined;
    const reportedAbsolutePath = reportedPath ? resolve(cwd, reportedPath) : undefined;
    let status = await pathExists(request.absolutePath) ? "saved" : "missing";
    let tempPath;
    if (reportedAbsolutePath && reportedAbsolutePath !== request.absolutePath) {
        tempPath = reportedAbsolutePath;
        if (status === "missing" && await pathExists(reportedAbsolutePath)) {
            await mkdir(dirname(request.absolutePath), { recursive: true });
            await copyFile(reportedAbsolutePath, request.absolutePath);
            status = "repaired-from-temp";
        }
    }
    return {
        data: {
            ...data,
            path: request.absolutePath,
        },
        request: {
            ...request,
            status,
            tempPath,
        },
    };
}
export { repairScreenshotData };
const DIALOG_COMMAND_PROCESS_TIMEOUT_MS = 5_000;
const DIALOG_COMMAND_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_DIALOG_PROCESS_TIMEOUT_MS";
const LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS = 8_000;
const LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV = "PI_AGENT_BROWSER_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS";
const DIALOG_TRIGGER_TEXT_PATTERN = /\b(?:alert|confirm|dialog|prompt)\b/i;
function getPositiveIntegerEnv(name) {
    const value = getAgentBrowserProcessEnvironment()[name];
    if (!value || !/^\d+$/.test(value.trim()))
        return undefined;
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function getRefIdsFromDirectCommand(commandTokens) {
    return [...new Set(getGuardedRefUsage(commandTokens))];
}
function commandTextLooksLikeDialogTrigger(commandTokens, refSnapshot) {
    if (commandTokens.some((token) => DIALOG_TRIGGER_TEXT_PATTERN.test(token)))
        return true;
    for (const refId of getRefIdsFromDirectCommand(commandTokens)) {
        const ref = refSnapshot?.refs?.[refId];
        if (ref && DIALOG_TRIGGER_TEXT_PATTERN.test(`${ref.role} ${ref.name}`))
            return true;
    }
    return false;
}
function getDialogAwareProcessTimeoutMs(commandTokens, refSnapshot, stdin) {
    const command = commandTokens[0];
    if (command === "dialog")
        return getPositiveIntegerEnv(DIALOG_COMMAND_PROCESS_TIMEOUT_ENV) ?? DIALOG_COMMAND_PROCESS_TIMEOUT_MS;
    if (command === "eval" && typeof stdin === "string" && DIALOG_TRIGGER_TEXT_PATTERN.test(stdin))
        return getPositiveIntegerEnv(LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV) ?? LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS;
    if ((command === "click" || command === "tap" || (command === "find" && commandTokens.includes("click"))) && commandTextLooksLikeDialogTrigger(commandTokens, refSnapshot))
        return getPositiveIntegerEnv(LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_ENV) ?? LIKELY_DIALOG_TRIGGER_PROCESS_TIMEOUT_MS;
    return undefined;
}
function describeRef(refSnapshot, refId) {
    const ref = refSnapshot?.refs?.[refId];
    return ref ? `${ref.role} ${JSON.stringify(ref.name)}` : "not present";
}
function getSamePageFreshnessPreflightFailure(options) {
    const { refIds } = options;
    if (refIds.length === 0)
        return undefined;
    const previousUrl = normalizeComparableUrl(options.previousSnapshot.target?.url);
    const currentUrl = normalizeComparableUrl(options.currentSnapshot.target?.url);
    if (!previousUrl || !currentUrl || previousUrl !== currentUrl || currentUrl === "about:blank")
        return undefined;
    const mismatchedRefs = refIds.filter((refId) => {
        const previous = options.previousSnapshot.refs?.[refId];
        const current = options.currentSnapshot.refs?.[refId];
        if (!options.currentSnapshot.refIds.includes(refId))
            return true;
        if (!previous || !current)
            return previous !== current;
        return previous.role !== current.role || previous.name !== current.name;
    });
    if (mismatchedRefs.length === 0)
        return undefined;
    const refText = mismatchedRefs.map((refId) => `@${refId}`).join(", ");
    const evidence = mismatchedRefs.map((refId) => `@${refId}: previous ${describeRef(options.previousSnapshot, refId)}, current ${describeRef(options.currentSnapshot, refId)}`).join("; ");
    return {
        message: `Ref ${refText} no longer matches the latest same-page snapshot. The page likely rerendered after the previous snapshot; run snapshot -i and retry with current refs. Evidence: ${evidence}.`,
        refIds: mismatchedRefs,
    };
}
async function collectSamePageRefFreshnessPreflight(options) {
    const refIds = [...new Set(getGuardedRefUsage(options.commandTokens, options.stdin))];
    if (!options.previousSnapshot || !options.sessionName || refIds.length === 0)
        return undefined;
    const previousUrl = normalizeComparableUrl(options.previousSnapshot.target?.url);
    const currentTargetUrl = normalizeComparableUrl(options.currentTarget?.url);
    if (currentTargetUrl === "about:blank" || (previousUrl && currentTargetUrl && previousUrl !== currentTargetUrl))
        return undefined;
    const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
    const currentSnapshot = extractRefSnapshotFromData(snapshotData);
    if (!currentSnapshot)
        return undefined;
    const snapshotWithTarget = { ...currentSnapshot, target: currentSnapshot.target ?? options.currentTarget };
    const mismatch = getSamePageFreshnessPreflightFailure({ currentSnapshot: snapshotWithTarget, previousSnapshot: options.previousSnapshot, refIds });
    if (!mismatch)
        return undefined;
    return { message: mismatch.message, refIds: mismatch.refIds, snapshot: snapshotWithTarget };
}
function getIdleTimeoutMismatch(args, configuredValue) {
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== "--idle-timeout")
            continue;
        const requestedToken = args[++index];
        if (!requestedToken || !/^\d+$/.test(requestedToken) || Number(requestedToken) === Number(configuredValue))
            continue;
        return `--idle-timeout ${requestedToken} conflicts with this Pi process's managed-session idle timeout (${configuredValue} ms). Restart Pi with PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS=${requestedToken} and omit --idle-timeout; changing the launch value for one call can restart the upstream browser and discard the active tab.`;
    }
    return undefined;
}
function isPasswordStdinAuthSave(options) {
    return options.command === "auth" && options.commandTokens[1] === "save" && options.commandTokens.includes("--password-stdin");
}
export function getExactSensitiveStdinValues(options) {
    if (options.stdin === undefined || !isPasswordStdinAuthSave(options)) {
        return [];
    }
    return [...new Set([options.stdin, options.stdin.trimEnd(), options.stdin.trim()].filter((value) => value.length > 0))];
}
export function validateStdinCommandContract(options) {
    if (options.stdin === undefined) {
        return undefined;
    }
    if (options.command === "batch") {
        return undefined;
    }
    if (options.command === "eval" && options.commandTokens.includes("--stdin")) {
        return undefined;
    }
    if (isPasswordStdinAuthSave(options)) {
        return undefined;
    }
    const commandLabel = options.command ? `\`${options.command}\`` : "the requested command";
    return `agent_browser stdin is only supported for \`batch\`, \`eval --stdin\`, and \`auth save --password-stdin\`; remove stdin from ${commandLabel} or use one of those command forms.`;
}
function canResolveSemanticVisibleRef(compiled) {
    if (!compiled?.locator)
        return false;
    if (compiled.action === "select")
        return true;
    return compiled.locator === "role" && ["check", "click", "fill"].includes(compiled.action);
}
function requiresResolvedSemanticVisibleRef(compiled) {
    return compiled?.action === "select" && compiled.locator !== undefined;
}
function resolveSemanticActionVisibleRefArgsFromSnapshot(compiled, snapshotData) {
    if (!canResolveSemanticVisibleRef(compiled))
        return undefined;
    const resolution = resolveVisibleRefActionFromSnapshot({ allowFill: true, compiledAction: compiled, snapshotData });
    if (!resolution)
        return undefined;
    return { args: [...getCompiledSemanticActionSessionPrefix(compiled), ...resolution.args], snapshot: resolution.snapshot };
}
export async function resolveSemanticActionVisibleRefArgs(options) {
    if (!options.compiled || !options.sessionName)
        return undefined;
    const snapshotData = await runSessionCommandData({ args: ["snapshot", "-i"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal });
    return resolveSemanticActionVisibleRefArgsFromSnapshot(options.compiled, snapshotData);
}
function getStateRenameOperands(commandTokens) {
    if (commandTokens[0] !== "state" || commandTokens[1] !== "rename" || commandTokens.length !== 4)
        return undefined;
    const [, , target, destination] = commandTokens;
    if (typeof target !== "string" || typeof destination !== "string")
        return undefined;
    if (target.startsWith("-") || destination.startsWith("-"))
        return undefined;
    return { destination, target };
}
// local patch: upstream 0.37.0 `state rename` cannot succeed in any documented form. Forwarded sessionless it
// reports "Missing 'path' parameter"; if either operand looks like a path it fails with "Invalid session name"
// (all four operand combinations verified failing). The wrapper therefore performs the rename itself.
async function tryLocalStateRename(options) {
    const operands = getStateRenameOperands(extractUpstreamCommandTokens(options.args));
    if (!operands)
        return undefined;
    const sourcePath = resolve(options.cwd, operands.target);
    const destinationPath = resolve(options.cwd, operands.destination);
    const fail = (validationError) => ({
        content: [{ type: "text", text: validationError }],
        details: {
            args: options.redactedArgs,
            ...buildAgentBrowserResultCategoryDetails({ args: options.redactedArgs, succeeded: false, validationError }),
            validationError,
        },
        isError: true,
    });
    if (sourcePath === destinationPath)
        return fail(`Refusing to rename state file ${sourcePath} onto itself.`);
    let stats;
    try {
        stats = await stat(sourcePath);
    }
    catch {
        return fail(`No state file at ${sourcePath}. The wrapper performs \`state rename\` locally: relative names resolve against ${options.cwd}, \`state save <path>\` writes to exactly the path you pass, and \`state list\` only lists restore states under ~/.agent-browser/sessions.`);
    }
    if (!stats.isFile())
        return fail(`${sourcePath} is not a file, so it cannot be renamed.`);
    if (await pathExists(destinationPath))
        return fail(`Refusing to overwrite the existing file ${destinationPath}. Pick another name or delete that file first.`);
    try {
        await rename(sourcePath, destinationPath);
    }
    catch (error) {
        return fail(`Could not rename ${sourcePath} to ${destinationPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = [`State renamed: ${sourcePath}`, `→ ${destinationPath}`, `Size: ${stats.size} bytes`].join("\n");
    return {
        content: [{ type: "text", text }],
        details: {
            args: options.redactedArgs,
            stateRename: { from: sourcePath, to: destinationPath, sizeBytes: stats.size },
            ...buildAgentBrowserResultCategoryDetails({ args: options.redactedArgs, succeeded: true }),
        },
    };
}

// local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7). Modeled on tryLocalStateRename:
// host-side work ahead of the ordinary pipeline. `list` never spawns; `restore` is TTL/confirmation
// gated and its storage-state written to the pre-named 0600 temp file only after the gate passes;
// `save` needs no gate. Every failure is a discriminated early result with a category.
function buildCheckpointGateFailure(redactedArgs, errorText, failureCategory) {
    return {
        content: [{ type: "text", text: errorText }],
        details: {
            args: redactedArgs,
            ...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, errorText, failureCategory, succeeded: false, validationError: errorText }),
            validationError: errorText,
        },
        isError: true,
    };
}

function formatCheckpointListText(checkpoints) {
    if (checkpoints.length === 0) {
        return "No auth-snapshots saved yet. Log in, then checkpoint save to capture the storage-state (cookies + origins) for bootstrapping later sessions.";
    }
    return [
        `Saved auth-snapshots (${checkpoints.length}, metadata only — decrypted content is never shown):`,
        ...checkpoints.map((row) => `${row.id}  ${row.label ?? row.origin ?? "(unlabeled)"}  created ${typeof row.createdAtMs === "number" ? new Date(row.createdAtMs).toISOString() : "unknown"}  age ${row.ageDays ?? "?"}d`),
    ].join("\n");
}

/**
 * Build the restore batch's stdin with the `open <origin>` row spliced in after `state load`.
 *
 * Returns undefined - never throws - for anything it cannot handle, because a restore that
 * cannot name an origin must still attempt as compiled rather than blow up inside a gate.
 * The gate writes the result into a sink rather than relying on a mutation; see the call site.
 */
export function rewriteCheckpointRestoreStdin(stdin, restoreTarget) {
    if (typeof stdin !== "string" || typeof restoreTarget !== "string" || restoreTarget.length === 0)
        return undefined;
    try {
        const rows = buildRestoreBatchRows(JSON.parse(stdin), restoreTarget);
        return rows ? JSON.stringify(rows) : undefined;
    }
    catch {
        return undefined;
    }
}
async function tryCheckpointPreSpawnGate(options) {
    const compiled = options.compiledCheckpoint;
    if (!compiled) {
        return undefined;
    }
    const { plan } = compiled;
    const agentBrowserProcessEnv = getAgentBrowserProcessEnvironment();
    if (plan.action === "list") {
        const listed = listCheckpoints({ env: agentBrowserProcessEnv });
        if (listed.status !== "ok") {
            return buildCheckpointGateFailure(options.redactedArgs, `Could not list auth-snapshots: ${listed.error}`, "checkpoint-error");
        }
        const text = formatCheckpointListText(listed.checkpoints)
            + (listed.unreadable > 0 ? `\n${listed.unreadable} unreadable snapshot file(s) were skipped (they are never decrypted).` : "");
        return {
            content: [{ type: "text", text }],
            details: {
                args: options.redactedArgs,
                checkpoint: { action: "list", checkpoints: listed.checkpoints, count: listed.checkpoints.length },
                ...buildAgentBrowserResultCategoryDetails({ args: options.redactedArgs, succeeded: true }),
            },
        };
    }
    // save + restore: the upstream result repeats the path it was handed, so register the temp state
    // path with the secret registry (P12) before anything can echo it downstream.
    registerVaultSecret(compiled.tempPath, { source: "checkpoint-temp" });
    if (plan.action === "save") {
        return undefined;
    }
    const sessionName = checkpointSessionNameForId(plan.id);
    if (!isCheckpointSessionName(sessionName)) {
        return buildCheckpointGateFailure(options.redactedArgs, `Refusing to restore: ${sessionName} is not a valid checkpoint session name.`, "validation-error");
    }
    const read = readCheckpoint(plan.id, { env: agentBrowserProcessEnv });
    if (read.status !== "ok") {
        return buildCheckpointGateFailure(options.redactedArgs, `Cannot restore checkpoint ${plan.id}: ${read.error}`, "validation-error");
    }
    const described = describeCheckpointEnvelope(read.envelope);
    const expired = isCheckpointExpired(read.envelope, { env: agentBrowserProcessEnv });
    let targetSessionAlive = false;
    if (!expired || plan.force === true) {
        const daemon = await inspectManagedSessionDaemon({
            cwd: options.cwd,
            namespace: resolveAgentBrowserNamespace(options.args ?? [], agentBrowserProcessEnv.AGENT_BROWSER_NAMESPACE),
            sessionName,
            signal: options.signal,
        });
        // Fail closed: only a clean "inactive" inspection proves there is no live browser to clobber.
        // "active" is alive, and "unknown"/"missing-binary" are not evidence of a dead session, so
        // they are treated as alive and the confirm:true gate is demanded rather than skipped.
        targetSessionAlive = daemon.status !== "inactive";
        // Honest-prose input for the finalizer: "inactive" means the upstream registry knows this
        // session name but no live browser — a prior stopped profile exists and will be reused.
        compiled.priorCheckpointSessionProfile = daemon.status === "inactive";
    }
    const gate = resolveCheckpointGateDecision({
        ageDays: described.ageDays,
        expired,
        plan,
        targetSessionAlive,
        ttlDays: getCheckpointTtlDays(agentBrowserProcessEnv),
    });
    if (gate) {
        return buildCheckpointGateFailure(options.redactedArgs, gate.errorText, gate.failureCategory);
    }
    const decrypted = decryptCheckpoint(plan.id, { env: agentBrowserProcessEnv });
    if (decrypted.status !== "ok") {
        return buildCheckpointGateFailure(options.redactedArgs, `Could not decrypt checkpoint ${plan.id}: ${decrypted.error} The restore is refused — no claim of a working session can be made from an unreadable snapshot.`, "validation-error");
    }
    // Best-effort hygiene before the snapshot directory is ensured again: reap tmp-*.state files
    // older than one hour (crashed restores). The reaper never throws and only touches stale temps.
    reapStaleCheckpointTempFiles({ env: agentBrowserProcessEnv });
    const writeError = writeCheckpointTempFile(compiled.tempPath, decrypted.bytes);
    if (writeError) {
        return buildCheckpointGateFailure(options.redactedArgs, writeError, "validation-error");
    }
    // wave4 (live-sweep W-V1): see buildRestoreBatchRows — navigate to the saved origin/url between
    // the state load and the health-check snapshot. The envelope metadata is only known after the
    // decrypt above, so this is the first point where the restore target exists.
    const checkpointMetadata = decrypted.metadata ?? {};
    const restoreTarget = typeof checkpointMetadata.url === "string" && checkpointMetadata.url.length > 0
        ? checkpointMetadata.url
        : typeof checkpointMetadata.origin === "string" && checkpointMetadata.origin.length > 0 ? checkpointMetadata.origin : undefined;
    if (restoreTarget && typeof compiled.stdin === "string") {
        const rewritten = rewriteCheckpointRestoreStdin(compiled.stdin, restoreTarget);
        if (rewritten) {
            compiled.stdin = rewritten;
            // wave19: the caller needs to be told. Mutating compiled.stdin alone is what made
            // this gate dead code from wave 4 onwards - prepareAgentBrowserArgs had already
            // frozen the string the spawn reads, and nothing downstream ever looked at
            // compiled.stdin again. The sink is the only channel still open at this point.
            if (options.restoreStdinSink)
                options.restoreStdinSink.stdin = rewritten;
        }
    }
    return undefined;
}
export async function prepareBrowserRun(options) {
    const { cwd, onUpdate, params, signal, state } = options;
    const { sessionPageState, traceOwners, managedSessionBaseName, ephemeralSessionSeed } = state;
    const agentBrowserProcessEnv = getAgentBrowserProcessEnvironment();
    let freshSessionOrdinal = state.freshSessionOrdinal;
    const { compiledCheckpoint, compiledDebug, compiledElectron, compiledJob, compiledLogin, compiledNetworkBody, compiledNetworkSourceLookup, compiledQaPreset, compiledScript, compiledSemanticAction, compiledSettle, compiledSourceLookup, compiledVault, kind: resolvedInputKind, redactedArgs, redactedCompiledElectron, redactedCompiledJob, redactedCompiledNetworkSourceLookup, redactedCompiledQaPreset, redactedCompiledSemanticAction, redactedCompiledSourceLookup, revealSecrets, toolArgs, toolStdin, verbosity, } = normalizeRunInput(options.input);
    let runtimeToolArgs = toolArgs;
    let runtimeToolStdin = toolStdin;
    let electronLaunch;
    const sessionMode = compiledElectron?.action === "launch" ? "fresh" : params.sessionMode ?? "auto";
    const freshSessionName = createFreshSessionName(managedSessionBaseName, ephemeralSessionSeed, freshSessionOrdinal + 1);
    const rawPageTargetError = getPageTargetValidationError({
        args: runtimeToolArgs,
        stdin: runtimeToolStdin,
        trustedFirstBatchTabSelection: true,
    });
    if (rawPageTargetError) {
        return {
            kind: "early-result",
            result: {
                content: [{ type: "text", text: rawPageTargetError }],
                details: {
                    args: redactedArgs,
                    ...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, errorText: rawPageTargetError, succeeded: false, validationError: rawPageTargetError }),
                    validationError: rawPageTargetError,
                },
                isError: true,
            },
        };
    }
    if (compiledElectron?.action === "launch") {
        const launchResult = await launchElectronApp({ ...compiledElectron, signal });
        if (!launchResult.ok) {
            const managedSessionOutcome = buildManagedSessionOutcome({
                activeAfter: state.managedSessionActive,
                activeBefore: state.managedSessionActive,
                attemptedSessionName: freshSessionName,
                command: "connect",
                currentSessionName: state.managedSessionName,
                previousSessionName: state.managedSessionName,
                sessionMode: "fresh",
                succeeded: false,
            });
            return { kind: "early-result", result: buildElectronHostFailureResult({
                    compiledElectron: redactedCompiledElectron ?? compiledElectron,
                    errorText: launchResult.failure.error,
                    failureCategory: getElectronLaunchFailureCategory(launchResult.failure),
                    launchFailure: launchResult.failure,
                    managedSessionOutcome,
                    status: launchResult.failure.reason,
                }) };
        }
        electronLaunch = launchResult.value;
        runtimeToolArgs = ["connect", electronLaunch.connectArg];
        runtimeToolStdin = undefined;
    }
    let managedSessionPolicyLock;
    let managedSessionPolicyLockTransferred = false;
    let electronLaunchTransferred = false;
    try {
        let preparedArgs;
        try {
            preparedArgs = await prepareAgentBrowserArgs(runtimeToolArgs, runtimeToolStdin, cwd);
        }
        catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof Error) || !("syscall" in error) || error.syscall !== "mkdir" || !("path" in error) || typeof error.path !== "string")
                throw error;
            const guidance = "Choose a writable artifact path whose parent components are directories. Use absolute paths in raw batch artifact rows.";
            const validationError = redactSensitiveText(`Could not prepare artifact directory ${error.path}: ${error.message}. ${guidance}`);
            const nextActions = [{ artifactPath: redactSensitiveText(error.path), id: "verify-artifact-path", reason: guidance, safety: "The requested browser command did not run; inspect the directory with host file tools before retrying.", tool: "agent_browser" }];
            return { kind: "early-result", result: {
                    content: [{ type: "text", text: validationError }],
                    details: {
                        agentBrowserStarted: false,
                        args: redactedArgs,
                        nextActions,
                        ...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, succeeded: false, validationError }),
                        validationError,
                    },
                    isError: true,
                } };
        }
        const userRequestedJson = runtimeToolArgs.includes("--json");
        const localStateRenameResult = await tryLocalStateRename({ args: preparedArgs.args, cwd, redactedArgs });
        if (localStateRenameResult)
            return { kind: "early-result", result: localStateRenameResult };
        // local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7). The gate runs before the
        // ordinary pipeline: `list` is answered host-side without spawning, `restore` is TTL- and
        // confirmation-gated and only decrypted into the pre-named 0600 temp file once it passes, and
        // the save/restore temp path is registered for exact-value scrubbing (P12) before anything can
        // echo it. Every guard above and below this block is untouched.
        const restoreStdinSink = {};
        const checkpointGateResult = await tryCheckpointPreSpawnGate({ args: preparedArgs.args, compiledCheckpoint, cwd, redactedArgs, restoreStdinSink, signal });
        if (checkpointGateResult)
            return { kind: "early-result", result: checkpointGateResult };
        // wave19: the gate ran AFTER prepareAgentBrowserArgs, so the injected `open <origin>` row
        // has to be pushed back into both places the spawn can read. Assigning only one of them
        // reproduces the original bug, because preparedArgs.stdin takes precedence over
        // runtimeToolStdin at the processStdin line further down.
        const restoreStdin = restoreStdinSink.stdin;
        if (typeof restoreStdin === "string" && restoreStdin.length > 0) {
            runtimeToolStdin = restoreStdin;
            preparedArgs.stdin = restoreStdin;
        }
        const routedReadConfirmation = state.sessionPageState.findReadConfirmation(preparedArgs.args, resolveAgentBrowserNamespace(preparedArgs.args, agentBrowserProcessEnv.AGENT_BROWSER_NAMESPACE));
        const readConfirmation = routedReadConfirmation?.capabilities?.readRequiresConfirmation === true ? routedReadConfirmation : undefined;
        let executionPlan = buildExecutionPlan(preparedArgs.args, {
            freshSessionName,
            managedSessionActive: state.managedSessionActive,
            managedSessionCompatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
            managedSessionName: state.managedSessionName,
            managedSessionNamespace: state.managedSessionNamespace,
            sessionMode,
            stdin: runtimeToolStdin,
            browserIndependentReadConfirmation: readConfirmation !== undefined,
        });
        const browserIndependent = readConfirmation !== undefined || isBrowserIndependentRead(extractUpstreamCommandTokens(preparedArgs.args), runtimeToolStdin)
            || (executionPlan.commandInfo.command === "session" && executionPlan.commandInfo.subcommand === "info");
        const ownedSessionKey = getSessionContextKey(executionPlan.sessionName, executionPlan.namespace);
        const plannedSessionPageState = sessionPageState.get(ownedSessionKey);
        const pageTargetError = readConfirmation ? undefined : getPageTargetValidationError({
            args: executionPlan.effectiveArgs,
            currentPageUrl: plannedSessionPageState.tabTarget?.url,
            pageUrlUnknown: plannedSessionPageState.tabTargetUnknown === true,
            stdin: runtimeToolStdin,
        });
        if (!executionPlan.validationError && pageTargetError)
            executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: pageTargetError };
        const recordedOwnedSession = ownedSessionKey ? state.ownedManagedSessions.get(ownedSessionKey) : undefined;
        const targetsCurrentManagedSession = state.managedSessionActive
            && ownedSessionKey === getSessionContextKey(state.managedSessionName, state.managedSessionNamespace);
        const targetsOffCurrentOwnedSession = recordedOwnedSession !== undefined && !targetsCurrentManagedSession;
        const idleTimeoutMismatch = !browserIndependent && (executionPlan.managedSessionName || recordedOwnedSession || targetsCurrentManagedSession || (state.managedSessionActive && extractExplicitSessionName(preparedArgs.args) === undefined))
            ? getIdleTimeoutMismatch(preparedArgs.args, options.implicitSessionIdleTimeoutMs)
            : undefined;
        if (idleTimeoutMismatch)
            executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: idleTimeoutMismatch };
        const offCurrentLaunchScopedFlags = targetsOffCurrentOwnedSession
            ? executionPlan.startupScopedFlags.filter((flag) => flag !== "--namespace")
            : [];
        const offCurrentCompatibilityUpgrade = targetsOffCurrentOwnedSession
            && executionPlan.compatibilityWorkaround !== undefined
            && recordedOwnedSession.compatibilityWorkaround === undefined;
        if (!browserIndependent && targetsOffCurrentOwnedSession && canUseHeadlessCompatibilityUserAgent(preparedArgs.args, agentBrowserProcessEnv)) {
            const compatibilityWorkaround = executionPlan.compatibilityWorkaround ?? recordedOwnedSession.compatibilityWorkaround;
            if (compatibilityWorkaround) {
                const userAgentIndex = executionPlan.effectiveArgs.indexOf("--user-agent");
                executionPlan = {
                    ...executionPlan,
                    compatibilityWorkaround,
                    effectiveArgs: userAgentIndex < 0
                        ? executionPlan.effectiveArgs
                        : [...executionPlan.effectiveArgs.slice(0, userAgentIndex), ...executionPlan.effectiveArgs.slice(userAgentIndex + 2)],
                };
            }
        }
        const retainedHeadedAutosaveDisabled = recordedOwnedSession?.headedManagedAutosaveDisabled === true
            || (targetsCurrentManagedSession && state.managedSessionHeadedAutosaveDisabled === true);
        const retainedHeadedAutosaveInterval = recordedOwnedSession?.headedManagedAutosaveInterval
            ?? (targetsCurrentManagedSession ? state.managedSessionHeadedAutosaveInterval : undefined);
        const explicitAutosaveInterval = resolveExplicitAutosaveInterval(agentBrowserProcessEnv.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS);
        const autosavePolicyChangeError = getRunningHeadedAutosavePolicyChangeError(retainedHeadedAutosaveInterval, isCloseCommand(executionPlan.commandInfo.command));
        if (!browserIndependent && !executionPlan.validationError && autosavePolicyChangeError) {
            executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: autosavePolicyChangeError };
        }
        const headedLaunch = getBooleanFlagValue(executionPlan.effectiveArgs, "--headed") ?? isUpstreamEnvFlagEnabled(agentBrowserProcessEnv.AGENT_BROWSER_HEADED);
        const providerLaunch = executionPlan.startupScopedFlags.some((flag) => flag === "--provider" || flag === "-p") || agentBrowserProcessEnv.AGENT_BROWSER_PROVIDER !== undefined;
        const headedManagedAutosaveDisabled = retainedHeadedAutosaveDisabled || (explicitAutosaveInterval === undefined && headedLaunch);
        const headedManagedAutosaveInterval = retainedHeadedAutosaveInterval ?? (headedLaunch ? explicitAutosaveInterval ?? "0" : undefined);
        const compatibilityUserAgent = executionPlan.compatibilityWorkaround ? getDefaultHeadlessCompatUserAgent() : undefined;
        const compatibilityUserAgentApplied = compatibilityUserAgent !== undefined
            && executionPlan.effectiveArgs.some((token, index) => token === "--user-agent" && executionPlan.effectiveArgs[index + 1] === compatibilityUserAgent);
        const ownedManagedSession = browserIndependent && !recordedOwnedSession && !targetsCurrentManagedSession ? undefined : buildOwnedManagedSessionRestoreContext({
            args: executionPlan.effectiveArgs,
            reuseOnly: browserIndependent,
            cwd: recordedOwnedSession?.cwd ?? cwd,
            currentManagedSessionName: state.managedSessionName,
            currentManagedSessionNamespace: state.managedSessionNamespace,
            headedManagedAutosaveDisabled: browserIndependent ? retainedHeadedAutosaveDisabled : headedManagedAutosaveDisabled,
            headedManagedAutosaveInterval: browserIndependent ? retainedHeadedAutosaveInterval : headedManagedAutosaveInterval,
            managedSessionName: executionPlan.managedSessionName,
            namespace: executionPlan.namespace,
            parentEnv: agentBrowserProcessEnv,
            recordedOwnedSession,
            restoreState: state.managedSessionRestoreState,
            sessionName: executionPlan.sessionName,
            stdin: runtimeToolStdin,
            compatibilityUserAgent: compatibilityUserAgentApplied ? compatibilityUserAgent : undefined,
            wrapperInjectedUserAgent: compatibilityUserAgentApplied,
        });
        let managedSessionDaemonInactive = false;
        let managedSessionCleanupOnlyReason;
        if (!browserIndependent && !executionPlan.validationError && ownedManagedSession) {
            const closeCommand = isCloseCommand(executionPlan.commandInfo.command);
            const policy = await acquireOwnedManagedSessionDaemonPolicy({
                context: ownedManagedSession,
                electronLaunchRecord: findElectronLaunchRecordForSession(executionPlan.sessionName, state.electronLaunchRecords, executionPlan.namespace),
                electronVerificationTimeoutMs: params.timeoutMs,
                mode: closeCommand ? "close" : "reuse",
                signal,
            });
            managedSessionPolicyLock = policy.lock;
            managedSessionDaemonInactive = policy.daemonStatus === "inactive";
            if (policy.error) {
                managedSessionCleanupOnlyReason = policy.cleanupOnlyReason;
                executionPlan = {
                    ...executionPlan,
                    recoveryHint: undefined,
                    validationError: policy.error,
                };
            }
            else if (!closeCommand && policy.daemonStatus === "active" && offCurrentLaunchScopedFlags.length > 0) {
                executionPlan = {
                    ...executionPlan,
                    recoveryHint: undefined,
                    validationError: `This older wrapper-owned session is already running, so launch-scoped flags ${offCurrentLaunchScopedFlags.join(", ")} would replace or be ignored by upstream agent-browser. Close it first, or remove the explicit --session and retry with sessionMode: \"fresh\".`,
                };
            }
            else if (!closeCommand && policy.daemonStatus === "active" && offCurrentCompatibilityUpgrade) {
                executionPlan = {
                    ...executionPlan,
                    recoveryHint: undefined,
                    validationError: "This older wrapper-owned session is already running without the user agent required by this site. Close it first, or remove the explicit --session and retry with sessionMode: \"fresh\".",
                };
            }
            else if (!closeCommand && policy.daemonStatus === "inactive" && compatibilityUserAgent && !compatibilityUserAgentApplied) {
                ownedManagedSession.compatibilityUserAgent = compatibilityUserAgent;
                executionPlan = {
                    ...executionPlan,
                    effectiveArgs: ["--user-agent", compatibilityUserAgent, ...executionPlan.effectiveArgs],
                };
            }
        }
        let chromeStartupArgs;
        if (options.input.chromeStartupArgs !== undefined && !options.preserveAttachedBrowserSession && !browserIndependent
            && !executionPlan.validationError && !isCloseCommand(executionPlan.commandInfo.command)
            && needsManagedSession(parseArgvDescriptor(preparedArgs.args), runtimeToolStdin)) {
            const inactive = ownedManagedSession ? managedSessionDaemonInactive : options.daemonInactive
                ?? (executionPlan.sessionName !== undefined && (await inspectManagedSessionDaemon({ cwd, signal, sessionName: executionPlan.sessionName, namespace: executionPlan.namespace })).status === "inactive");
            if (inactive || options.input.configuredChromeLaunch)
                chromeStartupArgs = options.input.chromeStartupArgs;
        }
        return await withChromeStartupArgs(chromeStartupArgs, () => withOwnedManagedSessionContext(ownedManagedSession, async () => {
            const managedSessionRestoreDisabled = () => state.managedSessionRestoreState.isDisabled(executionPlan.sessionName, executionPlan.namespace);
            const sessionStateKey = getSessionContextKey(executionPlan.sessionName, executionPlan.namespace);
            const priorSessionPageState = sessionPageState.get(sessionStateKey);
            let priorSessionTabTarget = priorSessionPageState.tabTarget;
            let priorSessionTabTargetUnknown = priorSessionPageState.tabTargetUnknown;
            const sessionTabPinningReason = priorSessionPageState.pinningReason;
            let priorRefSnapshotState = priorSessionPageState.refSnapshot;
            let priorRefSnapshotInvalidation = priorSessionPageState.refSnapshotInvalidation;
            const coldManagedSession = !browserIndependent && (managedSessionDaemonInactive || priorSessionPageState.tabReopenPending === true)
                && recordedOwnedSession !== undefined
                && sessionTabPinningReason === "restore"
                && ownedManagedSession?.restoreDecision === "enabled"
                && !managedSessionRestoreDisabled()
                && !options.preserveAttachedBrowserSession;
            if (coldManagedSession && sessionStateKey) {
                sessionPageState.setTabReopenPending({ pending: true, sessionName: sessionStateKey, update: options.sessionPageStateUpdate });
                priorRefSnapshotState = undefined;
                priorRefSnapshotInvalidation = buildPageTransitionRefSnapshotInvalidation("The managed browser shut down. Reopening its URL reloads the page; run snapshot -i before using page-scoped refs.");
                sessionPageState.applyRefSnapshotInvalidation({ invalidation: priorRefSnapshotInvalidation, sessionName: sessionStateKey, update: options.sessionPageStateUpdate });
            }
            let semanticActionVisibleRefResolution;
            let livePageVerified = false;
            let sessionTabCorrection;
            let sessionTabSelectionError;
            const plannedCommandTokens = extractUpstreamCommandTokens(preparedArgs.args);
            const knownStaleRef = buildStaleRefPreflight({ commandTokens: plannedCommandTokens, currentTarget: priorSessionTabTarget, refSnapshot: priorRefSnapshotState, refSnapshotInvalidation: priorRefSnapshotInvalidation, stdin: runtimeToolStdin });
            const invalidStdin = validateStdinCommandContract({ command: executionPlan.commandInfo.command, commandTokens: plannedCommandTokens, stdin: runtimeToolStdin });
            const pinSessionTab = shouldPinSessionTabForCommand({
                command: executionPlan.commandInfo.command,
                commandTokens: plannedCommandTokens,
                // URL QA clears diagnostics before its explicit open; those clears do not need the old tab.
                pinningRequired: !readConfirmation && sessionTabPinningReason !== undefined && compiledQaPreset?.checks.url === undefined,
                reopenPending: coldManagedSession,
                sessionName: executionPlan.sessionName,
                stdin: runtimeToolStdin,
            });
            if (!executionPlan.validationError && !executionPlan.plainTextInspection && !knownStaleRef && !invalidStdin && priorSessionTabTarget && pinSessionTab) {
                signal?.throwIfAborted();
                const reopened = !coldManagedSession || await runSessionCommandData({
                    args: ["open", priorSessionTabTarget.url], cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal, timeoutMs: params.timeoutMs,
                    onProcessResult: ({ agentBrowserStarted }) => {
                        // A started open may have navigated even if its CLI was aborted before replying.
                        if (agentBrowserStarted && sessionStateKey)
                            sessionPageState.setTabReopenPending({ pending: false, sessionName: sessionStateKey, update: options.sessionPageStateUpdate });
                    },
                }) !== undefined;
                const selection = signal?.aborted ? undefined : reopened
                    ? await ensureSessionTabTarget({ cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal, target: priorSessionTabTarget })
                    : { error: "agent-browser could not reopen the remembered URL after the managed browser shut down. Navigate explicitly, then run snapshot -i before retrying." };
                if (coldManagedSession && signal?.aborted) {
                    const errorText = "agent_browser was aborted while reopening the remembered page. The requested command did not run.";
                    return { kind: "early-result", result: {
                            content: [{ type: "text", text: errorText }],
                            details: {
                                aborted: true, args: redactedArgs, command: executionPlan.commandInfo.command,
                                effectiveArgs: redactInvocationArgs(executionPlan.effectiveArgs), sessionMode,
                                ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                                ...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, command: executionPlan.commandInfo.command, errorText, failureCategory: "aborted", succeeded: false }),
                            },
                            isError: true,
                        } };
                }
                signal?.throwIfAborted();
                sessionTabCorrection = selection?.correction;
                sessionTabSelectionError = selection?.error;
                if (selection?.error)
                    executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: selection.error };
            }
            const isCallerOwnedExplicitSession = () => executionPlan.sessionName !== undefined
                && executionPlan.usedImplicitSession === false
                && ownedManagedSession === undefined;
            const requiresLivePageVerification = () => !readConfirmation && (isCallerOwnedExplicitSession() || options.preserveAttachedBrowserSession === true);
            const verifyLivePage = async (request) => {
                if (!request.requirement || !executionPlan.sessionName)
                    return;
                if (options.establishAttachedBrowserSession) {
                    executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: request.requirement };
                    return;
                }
                let liveUrl;
                try {
                    const liveUrlData = await runSessionCommandData({
                        args: ["get", "url"],
                        cwd,
                        namespace: executionPlan.namespace,
                        sessionName: executionPlan.sessionName,
                        signal,
                        throwOnFailure: true,
                    });
                    liveUrl = extractStringResultField(liveUrlData, "result") ?? extractStringResultField(liveUrlData, "url");
                }
                catch (error) {
                    if (signal?.aborted)
                        throw signal.reason ?? error;
                }
                if (liveUrl === undefined) {
                    executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: request.requirement };
                    return;
                }
                const livePageValidationError = getPageTargetValidationError({
                    args: request.args,
                    currentPageUrl: liveUrl,
                    pageUrlUnknown: false,
                    stdin: request.stdin,
                });
                if (livePageValidationError) {
                    executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: livePageValidationError };
                    return;
                }
                livePageVerified = true;
                priorSessionTabTarget ??= { url: liveUrl };
                priorSessionTabTargetUnknown = undefined;
            };
            const hasPotentialLiveSemanticSession = state.managedSessionActive || priorSessionTabTarget !== undefined || isCallerOwnedExplicitSession() || options.preserveAttachedBrowserSession === true;
            const mayResolveSemanticVisibleRef = executionPlan.managedSessionName !== freshSessionName && hasPotentialLiveSemanticSession && canResolveSemanticVisibleRef(compiledSemanticAction);
            if (!executionPlan.validationError && mayResolveSemanticVisibleRef && requiresLivePageVerification()) {
                await verifyLivePage({
                    args: ["snapshot", "-i"],
                    requirement: getExplicitSessionPageVerificationRequirement({ args: ["snapshot", "-i"] }),
                });
            }
            if (!executionPlan.validationError && mayResolveSemanticVisibleRef) {
                semanticActionVisibleRefResolution = await resolveSemanticActionVisibleRefArgs({
                    compiled: compiledSemanticAction,
                    cwd,
                    namespace: executionPlan.namespace,
                    sessionName: executionPlan.sessionName,
                    signal,
                });
            }
            if (!executionPlan.validationError && requiresResolvedSemanticVisibleRef(compiledSemanticAction) && !semanticActionVisibleRefResolution) {
                const freshLocatorError = executionPlan.managedSessionName === freshSessionName
                    ? "semanticAction select with locator cannot resolve a current @ref in sessionMode fresh. Open the page first, then reuse that session, or pass selector plus value/values."
                    : undefined;
                executionPlan = {
                    ...executionPlan,
                    validationError: freshLocatorError ?? (hasPotentialLiveSemanticSession
                        ? "semanticAction select with locator could not resolve to exactly one current visible combobox/listbox ref. Run snapshot -i and retry with selector or a more specific role/name."
                        : "semanticAction select with locator requires an active browser session so the wrapper can resolve a current @ref; open a page first or pass selector plus value/values."),
                };
            }
            if (semanticActionVisibleRefResolution) {
                executionPlan = buildExecutionPlan(semanticActionVisibleRefResolution.args, {
                    freshSessionName,
                    managedSessionActive: state.managedSessionActive,
                    managedSessionCompatibilityWorkaround: state.managedSessionCompatibilityWorkaround,
                    managedSessionName: state.managedSessionName,
                    managedSessionNamespace: state.managedSessionNamespace,
                    sessionMode,
                });
            }
            const commandTokens = semanticActionVisibleRefResolution ? extractUpstreamCommandTokens(semanticActionVisibleRefResolution.args) : extractUpstreamCommandTokens(preparedArgs.args);
            const unsupportedScrollIntoViewRecovery = executionPlan.validationError || executionPlan.plainTextInspection
                ? undefined
                : [commandTokens, ...getUpstreamEffectiveBatchSteps(commandTokens, runtimeToolStdin)]
                    .map((tokens) => buildUnsupportedScrollIntoViewRecovery({ commandTokens: tokens, sessionName: executionPlan.sessionName }))
                    .find((recovery) => recovery !== undefined);
            if (unsupportedScrollIntoViewRecovery)
                executionPlan = { ...executionPlan, recoveryHint: undefined, validationError: unsupportedScrollIntoViewRecovery.error };
            const resolvedSemanticActionRefSnapshot = semanticActionVisibleRefResolution?.snapshot
                ? { ...semanticActionVisibleRefResolution.snapshot, target: semanticActionVisibleRefResolution.snapshot.target ?? priorSessionTabTarget }
                : undefined;
            const preLiveStaleRefPreflight = buildStaleRefPreflight({
                commandTokens,
                currentTarget: priorSessionTabTarget,
                refSnapshot: resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState,
                refSnapshotInvalidation: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotInvalidation,
                stdin: runtimeToolStdin,
            });
            const livePageAccessEligible = !executionPlan.validationError
                && preLiveStaleRefPreflight === undefined
                && validateStdinCommandContract({ command: executionPlan.commandInfo.command, commandTokens, stdin: runtimeToolStdin }) === undefined
                && requiresLivePageVerification();
            const livePageRequirement = livePageAccessEligible
                && !livePageVerified
                ? getExplicitSessionPageVerificationRequirement({
                    args: executionPlan.effectiveArgs,
                    stdin: runtimeToolStdin,
                })
                : undefined;
            await verifyLivePage({
                args: executionPlan.effectiveArgs,
                requirement: livePageRequirement,
                stdin: runtimeToolStdin,
            });
            const redactedEffectiveArgs = redactInvocationArgs(prepareAgentBrowserSpawnArgs(executionPlan.effectiveArgs, undefined, options.preserveAttachedBrowserSession, chromeStartupArgs));
            const redactedRecoveryHint = redactRecoveryHint(executionPlan.recoveryHint);
            const compatibilityWorkaround = executionPlan.compatibilityWorkaround;
            const statePatch = executionPlan.managedSessionName === freshSessionName
                ? { freshSessionOrdinal: freshSessionOrdinal + 1 }
                : {};
            if (executionPlan.managedSessionName === freshSessionName) {
                freshSessionOrdinal += 1;
            }
            if (executionPlan.validationError) {
                const nextActions = applyNamespaceToNextActions(sessionTabSelectionError ? buildSessionTabRecoveryNextActions({ kind: "tab-drift", resultCategory: "failure", sessionName: executionPlan.sessionName, tabCorrection: sessionTabCorrection, target: priorSessionTabTarget }) : unsupportedScrollIntoViewRecovery?.nextActions, executionPlan.namespace);
                const nextActionsText = formatAgentBrowserNextActionsText(nextActions);
                return { kind: "early-result", statePatch, result: {
                        content: [{ type: "text", text: [executionPlan.validationError, nextActionsText].filter((text) => text !== undefined).join("\n\n") }],
                        details: {
                            args: redactedArgs,
                            compiledElectron: redactedCompiledElectron,
                            compiledJob: redactedCompiledJob,
                            compiledQaPreset: redactedCompiledQaPreset,
                            compiledSourceLookup: redactedCompiledSourceLookup,
                            compiledNetworkSourceLookup: redactedCompiledNetworkSourceLookup,
                            invalidValueFlag: executionPlan.invalidValueFlag,
                            managedSessionCleanupOnlyReason,
                            ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                            ...(managedSessionCleanupOnlyReason ? { namespace: ownedManagedSession?.namespace ?? "" } : {}),
                            nextActions,
                            sessionMode,
                            sessionRecoveryHint: redactedRecoveryHint,
                            startupScopedFlags: executionPlan.startupScopedFlags,
                            ...(sessionTabSelectionError ? { effectiveArgs: redactedEffectiveArgs, sessionTabCorrection } : {}),
                            ...(coldManagedSession ? { refSnapshotInvalidation: priorRefSnapshotInvalidation } : {}),
                            ...buildAgentBrowserResultCategoryDetails({ args: redactedArgs, command: executionPlan.commandInfo.command, errorText: executionPlan.validationError, failureCategory: sessionTabSelectionError ? "tab-drift" : undefined, succeeded: false, validationError: executionPlan.validationError }),
                            validationError: executionPlan.validationError,
                        },
                        isError: true,
                    } };
            }
            const exactSensitiveValues = getExactSensitiveStdinValues({
                command: executionPlan.commandInfo.command,
                commandTokens,
                stdin: runtimeToolStdin,
            });
            const traceOwnerGuardMessage = getTraceOwnerGuardMessage({
                command: executionPlan.commandInfo.command,
                sessionName: sessionStateKey,
                subcommand: executionPlan.commandInfo.subcommand,
                traceOwners,
            });
            if (traceOwnerGuardMessage) {
                return { kind: "early-result", statePatch, result: {
                        content: [{ type: "text", text: traceOwnerGuardMessage }],
                        details: {
                            args: redactedArgs,
                            command: executionPlan.commandInfo.command,
                            compatibilityWorkaround,
                            effectiveArgs: redactedEffectiveArgs,
                            sessionMode,
                            ...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: traceOwnerGuardMessage, succeeded: false, validationError: traceOwnerGuardMessage }),
                            validationError: traceOwnerGuardMessage,
                            ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                        },
                        isError: true,
                    } };
            }
            const stdinValidationError = validateStdinCommandContract({
                command: executionPlan.commandInfo.command,
                commandTokens,
                stdin: runtimeToolStdin,
            });
            if (stdinValidationError) {
                return { kind: "early-result", statePatch, result: {
                        content: [{ type: "text", text: stdinValidationError }],
                        details: {
                            args: redactedArgs,
                            command: executionPlan.commandInfo.command,
                            compatibilityWorkaround,
                            effectiveArgs: redactedEffectiveArgs,
                            sessionMode,
                            ...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: stdinValidationError, succeeded: false, validationError: stdinValidationError }),
                            validationError: stdinValidationError,
                            ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                        },
                        isError: true,
                    } };
            }
            const promptRefSnapshot = resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState;
            const requestedArtifactCloseViolation = await findRequestedArtifactCloseViolation({ artifactManifest: state.artifactManifest, command: executionPlan.commandInfo.command, cwd, promptPolicy: options.promptPolicy });
            if (requestedArtifactCloseViolation) {
                return { kind: "early-result", statePatch, result: {
                        content: [{ type: "text", text: requestedArtifactCloseViolation.message }],
                        details: {
                            args: redactedArgs,
                            command: executionPlan.commandInfo.command,
                            compatibilityWorkaround,
                            effectiveArgs: redactedEffectiveArgs,
                            promptGuard: requestedArtifactCloseViolation,
                            sessionMode,
                            ...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: requestedArtifactCloseViolation.message, failureCategory: "policy-blocked", succeeded: false, validationError: requestedArtifactCloseViolation.message }),
                            validationError: requestedArtifactCloseViolation.message,
                            ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                        },
                        isError: true,
                    } };
            }
            const staleRefPreflight = buildStaleRefPreflight({
                commandTokens,
                currentTarget: priorSessionTabTarget,
                refSnapshot: resolvedSemanticActionRefSnapshot ?? priorRefSnapshotState,
                refSnapshotInvalidation: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotInvalidation,
                stdin: runtimeToolStdin,
            });
            if (staleRefPreflight) {
                return { kind: "early-result", statePatch, result: {
                        content: [{ type: "text", text: staleRefPreflight.message }],
                        details: {
                            args: redactedArgs,
                            command: executionPlan.commandInfo.command,
                            compatibilityWorkaround,
                            effectiveArgs: redactedEffectiveArgs,
                            nextActions: applyNamespaceToNextActions(buildSessionAwareStaleRefNextActions(executionPlan.sessionName), executionPlan.namespace),
                            refIds: staleRefPreflight.refIds,
                            refSnapshot: staleRefPreflight.snapshot,
                            refSnapshotInvalidation: staleRefPreflight.snapshotInvalidation,
                            sessionMode,
                            ...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: staleRefPreflight.message, failureCategory: "stale-ref", succeeded: false }),
                            ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                        },
                        isError: true,
                    } };
            }
            const samePageRefFreshnessPreflight = await collectSamePageRefFreshnessPreflight({
                commandTokens,
                cwd,
                currentTarget: priorSessionTabTarget,
                previousSnapshot: resolvedSemanticActionRefSnapshot ? undefined : priorRefSnapshotState,
                stdin: runtimeToolStdin,
                namespace: executionPlan.namespace,
                sessionName: executionPlan.sessionName,
                signal,
            });
            if (samePageRefFreshnessPreflight) {
                if (samePageRefFreshnessPreflight.snapshot && sessionStateKey) {
                    sessionPageState.applyRefSnapshot({ fallbackTarget: priorSessionTabTarget, sessionName: sessionStateKey, snapshot: samePageRefFreshnessPreflight.snapshot, update: options.sessionPageStateUpdate });
                }
                return { kind: "early-result", statePatch, result: {
                        content: [{ type: "text", text: samePageRefFreshnessPreflight.message }],
                        details: {
                            args: redactedArgs,
                            command: executionPlan.commandInfo.command,
                            compatibilityWorkaround,
                            effectiveArgs: redactedEffectiveArgs,
                            nextActions: applyNamespaceToNextActions(buildSessionAwareStaleRefNextActions(executionPlan.sessionName), executionPlan.namespace),
                            refIds: samePageRefFreshnessPreflight.refIds,
                            refSnapshot: samePageRefFreshnessPreflight.snapshot,
                            sessionMode,
                            ...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: samePageRefFreshnessPreflight.message, failureCategory: "stale-ref", succeeded: false }),
                            ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                        },
                        isError: true,
                    } };
            }
            if (compiledQaPreset?.checks.attached) {
                const qaAttachedPrecondition = await validateQaAttachedPrecondition({
                    cwd,
                    namespace: executionPlan.namespace,
                    sessionName: executionPlan.sessionName,
                    signal,
                });
                if (qaAttachedPrecondition) {
                    return { kind: "early-result", statePatch, result: {
                            content: [{ type: "text", text: qaAttachedPrecondition.error }],
                            details: {
                                args: redactedArgs,
                                compiledQaPreset: redactedCompiledQaPreset,
                                compatibilityWorkaround,
                                effectiveArgs: redactedEffectiveArgs,
                                nextActions: applyNamespaceToNextActions(qaAttachedPrecondition.nextActions, executionPlan.namespace),
                                sessionMode,
                                ...buildAgentBrowserResultCategoryDetails({ args: redactedEffectiveArgs, command: executionPlan.commandInfo.command, errorText: qaAttachedPrecondition.error, succeeded: false, validationError: qaAttachedPrecondition.error }),
                                validationError: qaAttachedPrecondition.error,
                                ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                            },
                            isError: true,
                        } };
                }
            }
            const persistentArtifactStore = getPersistentSessionArtifactStore(options.ctx);
            const snapshotFilter = await trySnapshotFilter({
                artifactManifest: state.artifactManifest,
                commandTokens,
                compatibilityWorkaround,
                cwd,
                effectiveArgs: redactedEffectiveArgs,
                managedSessionRestoreDisabled,
                persistentArtifactStore,
                previousRefSnapshot: priorRefSnapshotState,
                redactedArgs,
                namespace: executionPlan.namespace,
                sessionMode,
                sessionName: executionPlan.sessionName,
                sessionStateKey,
                sessionPageState,
                sessionPageStateUpdate: options.sessionPageStateUpdate,
                signal,
                usedImplicitSession: executionPlan.usedImplicitSession,
            });
            if (snapshotFilter)
                return { kind: "early-result", statePatch: { ...statePatch, artifactManifest: snapshotFilter.artifactManifest ?? statePatch.artifactManifest }, result: snapshotFilter.result };
            const networkRequestsPageFilter = await tryNetworkRequestsPageFilter({
                commandTokens,
                compatibilityWorkaround,
                cwd,
                effectiveArgs: redactedEffectiveArgs,
                managedSessionRestoreDisabled,
                redactedArgs,
                sessionMode,
                namespace: executionPlan.namespace,
                sessionName: executionPlan.sessionName,
                signal,
                usedImplicitSession: executionPlan.usedImplicitSession,
            });
            if (networkRequestsPageFilter)
                return { kind: "early-result", statePatch, result: networkRequestsPageFilter };
            if (executionPlan.startupScopedFlags.length === 0) {
                const containerScroll = await tryContainerScroll({
                    commandTokens,
                    compatibilityWorkaround,
                    cwd,
                    effectiveArgs: redactedEffectiveArgs,
                    managedSessionRestoreDisabled,
                    redactedArgs,
                    sessionMode,
                    namespace: executionPlan.namespace,
                    sessionName: executionPlan.sessionName,
                    signal,
                    usedImplicitSession: executionPlan.usedImplicitSession,
                });
                if (containerScroll)
                    return { kind: "early-result", statePatch, result: containerScroll };
                const pageScrollTo = await tryPageScrollTo({
                    commandTokens,
                    compatibilityWorkaround,
                    cwd,
                    effectiveArgs: redactedEffectiveArgs,
                    managedSessionRestoreDisabled,
                    redactedArgs,
                    sessionMode,
                    namespace: executionPlan.namespace,
                    sessionName: executionPlan.sessionName,
                    signal,
                    usedImplicitSession: executionPlan.usedImplicitSession,
                });
                if (pageScrollTo)
                    return { kind: "early-result", statePatch, result: pageScrollTo };
            }
            const directAnchorDownload = await tryDirectAnchorDownload({
                artifactManifest: state.artifactManifest,
                commandTokens,
                compatibilityWorkaround,
                cwd,
                effectiveArgs: redactedEffectiveArgs,
                managedSessionRestoreDisabled,
                redactedArgs,
                sessionMode,
                namespace: executionPlan.namespace,
                sessionName: executionPlan.sessionName,
                signal,
                usedImplicitSession: executionPlan.usedImplicitSession,
            });
            if (directAnchorDownload)
                return { kind: "early-result", statePatch: { ...statePatch, artifactManifest: directAnchorDownload.artifactManifest ?? statePatch.artifactManifest }, result: directAnchorDownload.result };
            const processArgs = executionPlan.effectiveArgs;
            const processStdin = preparedArgs.stdin ?? runtimeToolStdin;
            const clickDispatchProbe = compiledElectron === undefined
                ? await prepareClickDispatchProbe({ commandTokens, cwd, namespace: executionPlan.namespace, refSnapshot: promptRefSnapshot, sessionName: executionPlan.sessionName, signal })
                : undefined;
            let readTimeoutPageUrl = priorSessionTabTarget?.url;
            if (options.params.timeoutMs === undefined && readTimeoutPageUrl === undefined && executionPlan.sessionName && commandTimeoutNeedsActivePageUrl(commandTokens, processStdin)) {
                try {
                    const data = await runSessionCommandData({ args: ["get", "url"], cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal });
                    readTimeoutPageUrl = extractStringResultField(data, "result") ?? extractStringResultField(data, "url");
                }
                catch { }
            }
            const processTimeoutMs = options.params.timeoutMs ?? getDialogAwareProcessTimeoutMs(commandTokens, promptRefSnapshot, processStdin) ?? getCommandAwareProcessTimeoutMs(commandTokens, processStdin, readTimeoutPageUrl);
            const redactedProcessArgs = redactInvocationArgs(prepareAgentBrowserSpawnArgs(processArgs, ownedManagedSession?.compatibilityUserAgent, options.preserveAttachedBrowserSession, chromeStartupArgs));
            const scrollAmount = Number(commandTokens.find((token) => /^\d+(?:\.\d+)?$/.test(token)));
            const shouldProbeScrollNoop = executionPlan.commandInfo.command === "scroll" && executionPlan.startupScopedFlags.length === 0 && (state.managedSessionActive || sessionMode === "fresh") && (!Number.isFinite(scrollAmount) || scrollAmount >= 500);
            const scrollPositionBefore = shouldProbeScrollNoop
                ? await collectScrollPositionSnapshot({ cwd, namespace: executionPlan.namespace, sessionName: executionPlan.sessionName, signal })
                : undefined;
            onUpdate?.({
                content: [{ type: "text", text: `Running agent-browser ${buildInvocationPreview(redactedProcessArgs)}` }],
                details: {
                    compatibilityWorkaround,
                    effectiveArgs: redactedProcessArgs,
                    sessionMode,
                    sessionTabCorrection,
                    ...buildSessionDetailFields(executionPlan.sessionName, executionPlan.usedImplicitSession, executionPlan.namespace, managedSessionRestoreDisabled()),
                },
            });
            managedSessionPolicyLockTransferred = true;
            electronLaunchTransferred = true;
            return {
                kind: "ready",
                prepared: {
                    chromeStartupArgs,
                    commandTokens,
                    headedLaunch,
                    providerLaunch,
                    managedSessionPolicyLock,
                    compiledDebug,
                    compiledCheckpoint,
                    compiledElectron,
                    compiledJob,
                    compiledLogin,
                    compiledNetworkBody,
                    compiledNetworkSourceLookup,
                    compiledQaPreset,
                    compiledScript,
                    compiledSemanticAction,
                    compiledSettle,
                    compiledSourceLookup,
                    compiledVault,
                    kind: resolvedInputKind,
                    revealSecrets,
                    verbosity,
                    compatibilityWorkaround,
                    clickDispatchProbe,
                    electronLaunch,
                    exactSensitiveValues,
                    executionPlan,
                    ownedManagedSessionContext: ownedManagedSession,
                    preparedArgs,
                    readConfirmation,
                    priorRefSnapshotState,
                    priorSessionTabTarget,
                    priorSessionTabTargetUnknown,
                    processArgs,
                    processStdin,
                    processTimeoutMs,
                    redactedArgs,
                    redactedCompiledElectron,
                    redactedCompiledJob,
                    redactedCompiledNetworkSourceLookup,
                    redactedCompiledQaPreset,
                    redactedCompiledSemanticAction: semanticActionVisibleRefResolution && redactedCompiledSemanticAction?.action === "select"
                        ? { ...redactedCompiledSemanticAction, args: redactInvocationArgs(semanticActionVisibleRefResolution.args) }
                        : redactedCompiledSemanticAction,
                    redactedCompiledSourceLookup,
                    redactedEffectiveArgs,
                    redactedProcessArgs,
                    redactedRecoveryHint,
                    resolvedSemanticActionRefSnapshot,
                    runtimeToolArgs,
                    runtimeToolStdin,
                    scrollPositionBefore,
                    sessionMode,
                    sessionTabCorrection,
                    sessionTabPinningReason,
                    shouldProbeScrollNoop,
                    statePatch,
                    userRequestedJson,
                },
            };
        }));
    }
    finally {
        if (!managedSessionPolicyLockTransferred)
            await managedSessionPolicyLock?.release();
        if (electronLaunch && !electronLaunchTransferred) {
            try {
                const cleanup = await cleanupElectronLaunchResources({
                    child: electronLaunch.child,
                    record: electronLaunch.record,
                    timeoutMs: options.implicitSessionCloseTimeoutMs,
                });
                if (cleanup.partial) {
                    state.electronLaunchRecords.set(cleanup.launchId, cleanup.record);
                    state.electronChildProcesses.set(cleanup.launchId, electronLaunch.child);
                }
            }
            catch {
                state.electronLaunchRecords.set(electronLaunch.record.launchId, electronLaunch.record);
                state.electronChildProcesses.set(electronLaunch.record.launchId, electronLaunch.child);
            }
        }
    }
}
