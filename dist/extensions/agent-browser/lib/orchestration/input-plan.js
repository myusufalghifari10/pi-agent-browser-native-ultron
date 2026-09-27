import { parseArgvDescriptor } from "../argv-descriptor.js";
import { getUpstreamEffectiveBatchSteps, normalizeUrlLessOpen } from "./batch-stdin.js";
import { isPlainTextInspectionArgs, validateToolArgs, redactInvocationArgs, redactSensitiveText } from "../runtime.js";
import { buildAgentBrowserResultCategoryDetails } from "../results/categories.js";
import { compileAgentBrowserElectron } from "../input-modes/electron.js";
import { compileAgentBrowserDebug } from "../input-modes/debug.js";
import { compileAgentBrowserJob, compileAgentBrowserQaPreset } from "../input-modes/job.js";
import { normalizeLoginFlowInput } from "../input-modes/login-flow.js";
import { compileNetworkBodyRequest, normalizeNetworkBodyInput } from "../input-modes/network-body.js";
import { compileAgentBrowserSettle } from "../input-modes/settle.js";
import { normalizeVaultInput } from "../input-modes/vault-mode.js";
// local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7).
import { compileCheckpointRun, normalizeCheckpointInput } from "../input-modes/checkpoint.js";
import { getRevealSecretsScopeError, normalizeRevealSecrets } from "./browser-run/reveal-secrets.js";
import { normalizeVerbosity } from "./browser-run/verbosity.js";
import { compileAgentBrowserNetworkSourceLookup, compileAgentBrowserSourceLookup, redactNetworkSourceLookupArgs, redactNetworkSourceLookupUrl } from "../input-modes/lookups.js";
import { compileAgentBrowserSemanticAction } from "../input-modes/semantic-action.js";
import { AGENT_BROWSER_SCRIPT_MAX_TIMEOUT_MS, compileAgentBrowserScript } from "../input-modes/script.js";
function redactCompiledElectron(compiled) {
    if (!compiled)
        return undefined;
    if (compiled.action === "list") {
        return { ...compiled, query: compiled.query ? redactSensitiveText(compiled.query) : undefined };
    }
    if (compiled.action === "launch") {
        return { ...compiled, appArgs: compiled.appArgs ? redactInvocationArgs(compiled.appArgs) : undefined };
    }
    return { ...compiled };
}
function redactCompiledJob(compiled) {
    const redactedSteps = compiled?.steps.map((step) => ({ ...step, args: redactInvocationArgs(step.args) }));
    return compiled && redactedSteps
        ? { ...compiled, stdin: JSON.stringify(redactedSteps.map((step) => step.args)), steps: redactedSteps }
        : undefined;
}
function redactCompiledSourceLookup(compiled) {
    const redactedSteps = compiled?.steps.map((step) => ({ ...step, args: redactInvocationArgs(step.args) }));
    return compiled && redactedSteps
        ? { ...compiled, stdin: JSON.stringify(redactedSteps.map((step) => step.args)), steps: redactedSteps }
        : undefined;
}
function redactCompiledNetworkSourceLookup(compiled) {
    const redactedSteps = compiled?.steps.map((step) => ({ ...step, args: redactNetworkSourceLookupArgs(step.args) }));
    return compiled && redactedSteps
        ? {
            ...compiled,
            args: redactNetworkSourceLookupArgs(compiled.args),
            query: {
                ...compiled.query,
                filter: redactNetworkSourceLookupUrl(compiled.query.filter),
                url: redactNetworkSourceLookupUrl(compiled.query.url),
            },
            stdin: JSON.stringify(redactedSteps.map((step) => step.args)),
            steps: redactedSteps,
        }
        : undefined;
}
function normalizeExplicitEvalStdinArgs(args, stdin) {
    if (stdin !== undefined) {
        return { args, stdin };
    }
    const descriptor = parseArgvDescriptor(args);
    if (descriptor.commandInfo.command !== "eval") {
        return { args, stdin };
    }
    const stdinIndex = descriptor.commandTokens.indexOf("--stdin");
    if (stdinIndex < 0 || stdinIndex >= descriptor.commandTokens.length - 1) {
        return { args, stdin };
    }
    const commandStartIndex = args.length - descriptor.commandTokens.length;
    const stdinValue = descriptor.commandTokens.slice(stdinIndex + 1).join(" ");
    return {
        args: [...args.slice(0, commandStartIndex), ...descriptor.commandTokens.slice(0, stdinIndex + 1)],
        stdin: stdinValue,
    };
}
// local patch: upstream agent-browser 0.37.0 ignores the requested session name in `state clear`
// and deletes every saved state file in the state directory (verified: `state clear <one-name>`
// removed 6 files, including snapshots owned by other sessions). Block the command until upstream
// fixes it; targeted host-side deletion remains available.
const STATE_CLEAR_BLOCK_MESSAGE = [
    "Upstream agent-browser 0.37.0 `state clear` ignores the requested session name and deletes every saved state file in the state directory, so this wrapper blocks it to prevent data loss.",
    "Run `state list` to see the absolute paths, then delete only the specific files you no longer need with host file tools (or use `state save` / `state load` for portable state).",
].join(" ");
function isStateClearStep(step) {
    return Array.isArray(step) && step[0] === "state" && step[1] === "clear";
}
// local patch: upstream 0.37.0 `diff snapshot` without `--baseline` diffs against an empty baseline
// (verified: always changed:true with zero removals), which reads as "everything changed" and silently
// misleads change detection. Point callers at the two working alternatives instead.
const DIFF_SNAPSHOT_BASELINE_MESSAGE = [
    "Upstream agent-browser 0.37.0 `diff snapshot` without `--baseline` compares against an empty baseline, so it always reports changed: true with zero removals, which is misleading.",
    "Pass `--baseline <saved-snapshot-file>` for a real unified diff, or use the wrapper-side `snapshot --diff` for a ref-map delta against the previous tracked snapshot.",
].join(" ");
function hasBaselineToken(tokens) {
    return tokens.some((token) => token === "--baseline" || token.startsWith("--baseline="));
}
function isDiffSnapshotWithoutBaseline(step) {
    return Array.isArray(step) && step[0] === "diff" && step[1] === "snapshot" && !hasBaselineToken(step);
}
function isStateRenameStep(step) {
    return Array.isArray(step) && step[0] === "state" && step[1] === "rename";
}
// local patch: `state rename` is handled locally by this wrapper (upstream 0.37.0 fails in every documented
// form), so a batch step cannot reach it. Reject the step with guidance instead of an opaque upstream error.
function getBatchStateRenameError(commandTokens, stdin) {
    if (!Array.isArray(commandTokens) || commandTokens.length === 0)
        return undefined;
    const descriptor = parseArgvDescriptor(commandTokens);
    if (descriptor.commandInfo.command !== "batch")
        return undefined;
    const steps = getUpstreamEffectiveBatchSteps(descriptor.commandTokens, stdin);
    for (let index = 0; index < steps.length; index += 1) {
        if (isStateRenameStep(steps[index]))
            return `This wrapper performs \`state rename\` locally because upstream agent-browser 0.37.0 fails in every documented form, so it cannot run as batch step ${index + 1}. Call \`state rename <old> <new>\` as a top-level command instead.`;
    }
    return undefined;
}
function getDiffSnapshotBaselineError(commandTokens, stdin) {
    if (!Array.isArray(commandTokens) || commandTokens.length === 0)
        return undefined;
    const descriptor = parseArgvDescriptor(commandTokens);
    if (descriptor.commandInfo.command === "diff" && descriptor.commandInfo.subcommand === "snapshot")
        return hasBaselineToken(descriptor.commandTokens) ? undefined : DIFF_SNAPSHOT_BASELINE_MESSAGE;
    if (descriptor.commandInfo.command !== "batch")
        return undefined;
    const steps = getUpstreamEffectiveBatchSteps(descriptor.commandTokens, stdin);
    for (let index = 0; index < steps.length; index += 1) {
        if (isDiffSnapshotWithoutBaseline(steps[index]))
            return `${DIFF_SNAPSHOT_BASELINE_MESSAGE} (Blocked batch step ${index + 1}.)`;
    }
    return undefined;
}
function getStateClearBlockError(commandTokens, stdin) {
    if (!Array.isArray(commandTokens) || commandTokens.length === 0)
        return undefined;
    const descriptor = parseArgvDescriptor(commandTokens);
    const command = descriptor.commandInfo.command;
    if (command === "state" && descriptor.commandInfo.subcommand === "clear")
        return STATE_CLEAR_BLOCK_MESSAGE;
    if (command !== "batch")
        return undefined;
    // local patch follow-up: use the descriptor's command tokens, not the raw argv. Raw argv can
    // start with global flags (`--namespace "" batch ...`), and getUpstreamEffectiveBatchSteps
    // bails out unless token 0 is exactly "batch" — that bypass ran the destructive upstream
    // command (verified: {"deleted": 10}, whole state dir wiped).
    const steps = getUpstreamEffectiveBatchSteps(descriptor.commandTokens, stdin);
    for (let index = 0; index < steps.length; index += 1) {
        if (isStateClearStep(steps[index]))
            return `${STATE_CLEAR_BLOCK_MESSAGE} (Blocked batch step ${index + 1}.)`;
    }
    return undefined;
}
export function resolveAgentBrowserInput(options) {
    const { getBatchPreflightValidationError, params } = options;
    const semanticActionResult = params.semanticAction === undefined ? {} : compileAgentBrowserSemanticAction(params.semanticAction);
    const jobResult = params.job === undefined ? {} : compileAgentBrowserJob(params.job);
    const qaResult = params.qa === undefined ? {} : compileAgentBrowserQaPreset(params.qa);
    const sourceLookupResult = params.sourceLookup === undefined ? {} : compileAgentBrowserSourceLookup(params.sourceLookup);
    const networkSourceLookupResult = params.networkSourceLookup === undefined ? {} : compileAgentBrowserNetworkSourceLookup(params.networkSourceLookup);
    const electronResult = params.electron === undefined ? {} : compileAgentBrowserElectron(params.electron);
    const scriptResult = params.script === undefined ? {} : compileAgentBrowserScript(params.script);
    // local patch: diagnostics + devtools + vault modes (PATCHES.md P13-P22).
    const debugResult = params.debug === undefined ? {} : compileAgentBrowserDebug(params.debug);
    const settleResult = params.settle === undefined ? {} : compileAgentBrowserSettle(params.settle);
    const networkBodyNormalized = params.networkBody === undefined ? {} : normalizeNetworkBodyInput(params.networkBody);
    const networkBodyResult = networkBodyNormalized.value ? compileNetworkBodyRequest(networkBodyNormalized.value) : {};
    const vaultInput = params.vault === undefined ? {} : normalizeVaultInput(params.vault);
    // local patch: origin auth-snapshots — the `checkpoint` mode compiles to real upstream argv rows
    // (`state save <temp>`, or a fail-fast restore batch) finalized by the output pipeline.
    const checkpointInput = params.checkpoint === undefined ? {} : normalizeCheckpointInput(params.checkpoint);
    const compiledCheckpoint = checkpointInput.value ? compileCheckpointRun(checkpointInput.value) : undefined;
    // local patch: devServer is host-only and needs `cwd` to resolve candidates, so input-plan passes the
    // raw object through and `lib/orchestration/dev-server-host/handler.js` validates it with cwd + registry.
    const devServerInput = params.devServer === undefined ? {} : { value: params.devServer };
    const loginFlowInput = params.login === undefined ? {} : normalizeLoginFlowInput(params.login);
    const verbosityResult = normalizeVerbosity(params.verbosity);
    const revealSecretsResult = normalizeRevealSecrets(params.revealSecrets);
    const hasExplicitArgs = Array.isArray(params.args);
    // local patch P15: count the modes the caller actually supplied, not only the ones that compiled.
    // Previously `{ args: [...], semanticAction: <invalid> }` reported the semanticAction compile error
    // and a lone invalid mode produced a misleading "provide exactly one" style failure, which hid the
    // real conflict.
    const suppliedModeNames = [
        ["args", hasExplicitArgs],
        ["script", params.script !== undefined],
        ["semanticAction", params.semanticAction !== undefined],
        ["job", params.job !== undefined],
        ["qa", params.qa !== undefined],
        ["sourceLookup", params.sourceLookup !== undefined],
        ["networkSourceLookup", params.networkSourceLookup !== undefined],
        ["electron", params.electron !== undefined],
        ["debug", params.debug !== undefined],
        ["settle", params.settle !== undefined],
        ["networkBody", params.networkBody !== undefined],
        ["vault", params.vault !== undefined],
        ["checkpoint", params.checkpoint !== undefined],
        ["devServer", params.devServer !== undefined],
        ["login", params.login !== undefined],
    ].filter(([, supplied]) => supplied).map(([name]) => name);
    const allModeNames = ["script", "args", "semanticAction", "job", "qa", "sourceLookup", "networkSourceLookup", "electron", "debug", "settle", "networkBody", "vault", "checkpoint", "devServer", "login"];
    const inputModeError = suppliedModeNames.length !== 1
        ? suppliedModeNames.length === 0
            ? `Provide exactly one input mode. Supported modes: ${allModeNames.join(", ")}.`
            : `Provide exactly one input mode, but this call supplied ${suppliedModeNames.join(" and ")}. Remove all but one of them. Supported modes: ${allModeNames.join(", ")}.`
        : undefined;
    const compiledSemanticAction = semanticActionResult.compiled;
    const compiledQaPreset = qaResult.compiled;
    const compiledSourceLookup = sourceLookupResult.compiled;
    const compiledNetworkSourceLookup = networkSourceLookupResult.compiled;
    const compiledElectron = electronResult.compiled;
    const compiledScript = scriptResult.compiled;
    const compiledDebug = debugResult.compiled;
    const compiledSettle = settleResult.compiled;
    const compiledNetworkBody = networkBodyResult.args ? networkBodyResult : undefined;
    const compiledVault = vaultInput.value;
    const compiledDevServer = devServerInput.value;
    const compiledLogin = loginFlowInput.value;
    const hostOnlyKind = compiledVault ? "vault" : compiledDevServer ? "devServer" : compiledLogin ? "login" : undefined;
    const compiledJob = jobResult.compiled ?? compiledQaPreset;
    const compiledGeneratedBatch = compiledNetworkSourceLookup ?? compiledSourceLookup ?? compiledJob ?? compiledDebug;
    const normalizedExplicitArgs = normalizeExplicitEvalStdinArgs(params.args ?? [], params.stdin);
    const hostOnlyArgs = compiledVault ? ["--vault-host"] : compiledDevServer ? ["--devserver-host"] : compiledLogin ? ["--login-host"] : undefined;
    const toolArgs = compiledElectron || compiledScript || hostOnlyKind ? (hostOnlyArgs ?? []) : compiledSemanticAction?.args ?? compiledSettle?.args ?? compiledNetworkBody?.args ?? compiledGeneratedBatch?.args ?? compiledCheckpoint?.args ?? normalizedExplicitArgs.args;
    const toolStdin = compiledSettle?.stdin ?? compiledGeneratedBatch?.stdin ?? compiledCheckpoint?.stdin ?? normalizedExplicitArgs.stdin;
    const redactedArgs = redactInvocationArgs(toolArgs);
    const generatedStdinError = params.stdin !== undefined
        ? compiledGeneratedBatch
            ? "Do not provide stdin with job, qa, sourceLookup, or networkSourceLookup; those modes generate their own batch stdin."
            : compiledElectron
                ? "Do not provide stdin with electron; electron mode is host-only or manages its own input."
                : compiledScript
                    ? "Do not provide stdin with script; browser call stdin belongs inside browser({ args, stdin })."
                    : undefined
        : undefined;
    const outputPathError = params.outputPath !== undefined && (typeof params.outputPath !== "string" || params.outputPath.trim().length === 0)
        ? "outputPath must be a non-empty string when provided."
        : undefined;
    const timeoutMsError = params.timeoutMs !== undefined && (typeof params.timeoutMs !== "number" || !Number.isSafeInteger(params.timeoutMs) || params.timeoutMs <= 0)
        ? "timeoutMs must be a positive integer when provided."
        : compiledElectron && params.timeoutMs !== undefined
            ? compiledElectron.action === "list"
                ? "electron.list has no configurable timeout; remove top-level timeoutMs."
                : "Use electron.timeoutMs for this action; top-level timeoutMs applies only to browser CLI subprocess calls."
            : compiledScript && params.timeoutMs !== undefined && params.timeoutMs > AGENT_BROWSER_SCRIPT_MAX_TIMEOUT_MS
                ? `script timeoutMs must be ${AGENT_BROWSER_SCRIPT_MAX_TIMEOUT_MS} or less.`
                : undefined;
    const scriptSessionModeError = compiledScript && params.sessionMode !== undefined
        ? "Do not provide sessionMode with script; script always uses its own isolated session."
        : undefined;
    const attachedQaSessionError = compiledQaPreset?.checks.attached
        ? params.sessionMode === "fresh"
            ? "qa.attached cannot be used with sessionMode=fresh; attach or launch a session first, then run qa.attached with the current session."
            : undefined
        : undefined;
    const validationError = semanticActionResult.error
        ?? jobResult.error
        ?? qaResult.error
        ?? sourceLookupResult.error
        ?? networkSourceLookupResult.error
        ?? electronResult.error
        ?? scriptResult.error
        ?? debugResult.error
        ?? settleResult.error
        ?? networkBodyNormalized.error
        ?? vaultInput.error
        ?? checkpointInput.error
        ?? devServerInput.error
        ?? loginFlowInput.error
        ?? verbosityResult.error
        ?? revealSecretsResult.error
        ?? inputModeError
        ?? generatedStdinError
        ?? outputPathError
        ?? timeoutMsError
        ?? scriptSessionModeError
        ?? attachedQaSessionError
        ?? (revealSecretsResult.value ? getRevealSecretsScopeError(parseArgvDescriptor(toolArgs).commandTokens, revealSecretsResult.value) : undefined)
        // checkpoint is wrapper-orchestrated: its rows are compiler-generated (list never spawns), so
        // caller-argv guards are skipped exactly like the host-only kinds; the mode payload itself is
        // validated by normalizeCheckpointInput above.
        ?? (compiledElectron || compiledScript || hostOnlyKind || compiledCheckpoint ? undefined : getStateClearBlockError(toolArgs, toolStdin) ?? getBatchStateRenameError(toolArgs, toolStdin) ?? getDiffSnapshotBaselineError(toolArgs, toolStdin) ?? validateToolArgs(toolArgs) ?? getBatchPreflightValidationError(toolArgs, toolStdin));
    const redactedCompiledJob = redactCompiledJob(compiledJob);
    const redactedCompiledSemanticAction = compiledSemanticAction
        ? { ...compiledSemanticAction, args: redactInvocationArgs(compiledSemanticAction.args) }
        : undefined;
    const attemptedKind = compiledElectron
        ? "electron"
        : compiledScript
            ? "script"
            : compiledVault
                ? "vault"
                : compiledCheckpoint
                    ? "checkpoint"
                    : compiledDevServer
                        ? "devServer"
                    : compiledLogin
                        ? "login"
                        : compiledNetworkSourceLookup
                            ? "networkSourceLookup"
                            : compiledSourceLookup
                                ? "sourceLookup"
                                : compiledQaPreset
                                    ? "qa"
                                    : jobResult.compiled
                                        ? "job"
                                        : compiledDebug
                                            ? "debug"
                                            : compiledSettle
                                                ? "settle"
                                                : compiledNetworkBody
                                                    ? "networkBody"
                                                    : compiledSemanticAction
                                                        ? "semanticAction"
                                                        : hasExplicitArgs
                                                            ? "args"
                                                            : undefined;
    const redactedCompiledElectron = redactCompiledElectron(compiledElectron);
    const redactedCompiledNetworkSourceLookup = redactCompiledNetworkSourceLookup(compiledNetworkSourceLookup);
    const redactedCompiledQaPreset = compiledQaPreset && redactedCompiledJob ? { ...redactedCompiledJob, checks: compiledQaPreset.checks } : undefined;
    const redactedCompiledSourceLookup = redactCompiledSourceLookup(compiledSourceLookup);
    const normalized = validationError || isPlainTextInspectionArgs(toolArgs) || hostOnlyKind || compiledCheckpoint ? { args: toolArgs, stdin: toolStdin } : normalizeUrlLessOpen(toolArgs, toolStdin);
    const resolvedBase = { redactedArgs, revealSecrets: revealSecretsResult.value, toolArgs: normalized.args, toolStdin: normalized.stdin, verbosity: verbosityResult.value ?? "normal" };
    if (validationError) {
        return {
            ...resolvedBase,
            attemptedKind,
            compiledElectron,
            compiledGeneratedBatch,
            compiledJob,
            compiledNetworkSourceLookup,
            compiledQaPreset,
            compiledSemanticAction,
            compiledSourceLookup,
            kind: "invalid",
            redactedCompiledElectron,
            redactedCompiledJob,
            redactedCompiledNetworkSourceLookup,
            redactedCompiledQaPreset,
            redactedCompiledSemanticAction,
            redactedCompiledSourceLookup,
            status: "invalid",
            validationError,
        };
    }
    if (compiledElectron && redactedCompiledElectron) {
        return { ...resolvedBase, compiledElectron, kind: "electron", redactedCompiledElectron, status: "valid" };
    }
    if (compiledVault) {
        return { ...resolvedBase, compiledVault, kind: "vault", status: "valid" };
    }
    if (compiledCheckpoint) {
        // The redacted echo is the plan itself: it never carries the temp state path or any state bytes.
        return { ...resolvedBase, compiledCheckpoint, kind: "checkpoint", redactedCompiledCheckpoint: compiledCheckpoint.plan, status: "valid" };
    }
    if (compiledDevServer) {
        return { ...resolvedBase, compiledDevServer, kind: "devServer", status: "valid" };
    }
    if (compiledLogin) {
        return { ...resolvedBase, compiledLogin, kind: "login", status: "valid" };
    }
    if (compiledDebug) {
        return { ...resolvedBase, compiledDebug, compiledGeneratedBatch: compiledDebug, kind: "debug", status: "valid" };
    }
    if (compiledSettle) {
        return { ...resolvedBase, compiledSettle, kind: "settle", status: "valid" };
    }
    if (compiledNetworkBody) {
        return { ...resolvedBase, compiledNetworkBody, kind: "networkBody", status: "valid" };
    }
    if (compiledScript) {
        return { ...resolvedBase, compiledScript, kind: "script", status: "valid" };
    }
    if (compiledNetworkSourceLookup && redactedCompiledNetworkSourceLookup) {
        return {
            ...resolvedBase,
            compiledGeneratedBatch: compiledNetworkSourceLookup,
            compiledNetworkSourceLookup,
            kind: "networkSourceLookup",
            redactedCompiledNetworkSourceLookup,
            status: "valid",
        };
    }
    if (compiledSourceLookup && redactedCompiledSourceLookup) {
        return {
            ...resolvedBase,
            compiledGeneratedBatch: compiledSourceLookup,
            compiledSourceLookup,
            kind: "sourceLookup",
            redactedCompiledSourceLookup,
            status: "valid",
        };
    }
    if (compiledQaPreset && redactedCompiledJob && redactedCompiledQaPreset) {
        return {
            ...resolvedBase,
            compiledGeneratedBatch: compiledQaPreset,
            compiledJob: compiledQaPreset,
            compiledQaPreset,
            kind: "qa",
            redactedCompiledJob,
            redactedCompiledQaPreset,
            status: "valid",
        };
    }
    if (jobResult.compiled && redactedCompiledJob) {
        return {
            ...resolvedBase,
            compiledGeneratedBatch: jobResult.compiled,
            compiledJob: jobResult.compiled,
            kind: "job",
            redactedCompiledJob,
            status: "valid",
        };
    }
    if (compiledSemanticAction && redactedCompiledSemanticAction) {
        return { ...resolvedBase, compiledSemanticAction, kind: "semanticAction", redactedCompiledSemanticAction, status: "valid" };
    }
    return { ...resolvedBase, kind: "args", status: "valid" };
}
export function buildValidationFailureResult(input) {
    const validationError = input.validationError ?? "Invalid agent_browser input.";
    return {
        content: [{ type: "text", text: validationError }],
        details: {
            args: input.redactedArgs,
            compiledElectron: input.redactedCompiledElectron,
            ...(input.redactedCompiledCheckpoint ? { checkpointPlan: input.redactedCompiledCheckpoint } : {}),
            compiledJob: input.redactedCompiledJob,
            compiledQaPreset: input.redactedCompiledQaPreset,
            compiledSourceLookup: input.redactedCompiledSourceLookup,
            compiledNetworkSourceLookup: input.redactedCompiledNetworkSourceLookup,
            compiledSemanticAction: input.redactedCompiledSemanticAction,
            ...buildAgentBrowserResultCategoryDetails({
                args: input.redactedArgs,
                errorText: validationError,
                succeeded: false,
                validationError,
            }),
            validationError,
        },
        isError: true,
    };
}
