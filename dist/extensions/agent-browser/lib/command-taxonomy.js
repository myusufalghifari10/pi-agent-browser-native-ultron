const ADDITIONAL_COMMAND_TOKENS = [
    "a11y", "auth", "chat", "clipboard", "confirm", "connect", "dashboard", "deny", "device", "dialog", "diff", "doctor", "errors", "eval", "find", "frame", "get", "highlight", "inspect", "install", "is", "mcp", "plugin", "plugins", "profiles", "profiler", "react", "record", "removeinitscript", "session", "set", "skills", "snapshot", "state", "stream", "trace", "upgrade", "vitals", "wait", "web-vitals", "webmcp", "window",
];
const WEBMCP_PAGE_MUTATION_SUBCOMMANDS = new Set(["invoke", "result", "cancel"]);
const COMMAND_CAPABILITIES = [
    {
        command: "back",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        navigationObservable: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "batch",
        excludedFromPostCommandCorrection: true,
    },
    {
        command: "check",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "click",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        navigationObservable: true,
        triggersPostMutationSnapshot: true,
    },
    {
        aliases: ["quit", "exit"],
        closesSession: true,
        command: "close",
        excludedFromPinning: true,
        excludedFromPostCommandCorrection: true,
    },
    {
        command: "console",
        readOnlyDiagnosticSessionTarget: true,
    },
    {
        command: "cookies",
        readOnlyDiagnosticSessionTarget: true,
    },
    {
        command: "dblclick",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        navigationObservable: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "dialog",
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "diff",
        guardsPageRefs: true,
    },
    {
        command: "download",
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
    },
    {
        command: "drag",
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
    },
    {
        command: "errors",
        readOnlyDiagnosticSessionTarget: true,
    },
    {
        command: "eval",
        invalidatesBatchRefs: true,
        navigationObservable: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "fill",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "find",
        eligibleForElectronHealthProbe: true,
    },
    {
        command: "frame",
        guardsPageRefs: true,
    },
    {
        command: "focus",
        guardsPageRefs: true,
    },
    {
        command: "forward",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        navigationObservable: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "get",
        guardsPageRefs: true,
    },
    {
        command: "highlight",
        guardsPageRefs: true,
    },
    {
        command: "hover",
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "is",
        guardsPageRefs: true,
    },
    {
        command: "keydown",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "keyboard",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "keyup",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "mouse",
        eligibleForElectronHealthProbe: true,
        invalidatesBatchRefs: true,
    },
    {
        command: "network",
        readOnlyDiagnosticSessionTarget: true,
    },
    {
        aliases: ["goto", "navigate"],
        command: "open",
        eligibleForPageChangeSummary: true,
        excludedFromPinning: true,
        invalidatesBatchRefs: true,
        openNavigation: true,
    },
    {
        command: "pdf",
        eligibleForPageChangeSummary: true,
    },
    {
        aliases: ["key"],
        command: "press",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "pushstate",
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "reload",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        navigationObservable: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "read",
        readOnlyDiagnosticSessionTarget: true,
    },
    {
        command: "screenshot",
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
    },
    {
        command: "scroll",
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        aliases: ["scrollinto"],
        command: "scrollintoview",
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "select",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "session",
        excludedFromPinning: true,
        excludedFromPostCommandCorrection: true,
    },
    {
        command: "storage",
        readOnlyDiagnosticSessionTarget: true,
    },
    {
        command: "swipe",
        eligibleForPageChangeSummary: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "tab",
        excludedFromPinning: true,
        excludedFromPostCommandCorrection: true,
    },
    {
        command: "tap",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "type",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "uncheck",
        eligibleForElectronHealthProbe: true,
        eligibleForPageChangeSummary: true,
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
        triggersPostMutationSnapshot: true,
    },
    {
        command: "upload",
        guardsPageRefs: true,
        invalidatesBatchRefs: true,
    },
];
const COMMAND_CAPABILITY_BY_NAME = new Map();
for (const entry of COMMAND_CAPABILITIES) {
    COMMAND_CAPABILITY_BY_NAME.set(entry.command, entry);
    for (const alias of entry.aliases ?? []) {
        COMMAND_CAPABILITY_BY_NAME.set(alias, entry);
    }
}
const KNOWN_COMMAND_TOKENS = new Set([...COMMAND_CAPABILITY_BY_NAME.keys(), ...ADDITIONAL_COMMAND_TOKENS]);
export function isKnownCommandToken(token) {
    return KNOWN_COMMAND_TOKENS.has(token);
}
function getCommandCapability(command) {
    return command === undefined ? undefined : COMMAND_CAPABILITY_BY_NAME.get(command);
}
function hasCommandCapability(command, capability) {
    return getCommandCapability(command)?.[capability] === true;
}
export function normalizeCommandName(command) {
    return getCommandCapability(command)?.command ?? command;
}
export function isCloseCommand(command) {
    return hasCommandCapability(command, "closesSession");
}
export function isCloseAllCommand(commandTokens) {
    return isCloseCommand(commandTokens[0]) && commandTokens.slice(1).includes("--all");
}
export function isOpenNavigationCommand(command) {
    return hasCommandCapability(command, "openNavigation");
}
export function isReadOnlyDiagnosticSessionTargetCommand(command, subcommand) {
    return hasCommandCapability(command, "readOnlyDiagnosticSessionTarget") || (command === "webmcp" && subcommand === "list");
}
export function isSessionTabPinningExcludedCommand(command) {
    return hasCommandCapability(command, "excludedFromPinning");
}
export function isSessionTabPostCommandCorrectionExcludedCommand(command) {
    return hasCommandCapability(command, "excludedFromPostCommandCorrection");
}
export function getRecordCommandOperands(tokens) {
    if (tokens[0] !== "record" || !["start", "restart"].includes(tokens[1] ?? ""))
        return {};
    const operands = [];
    for (let index = 2; index < tokens.length && operands.length < 2; index += 1) {
        // Native validates the range; bare/non-numeric --fps keeps its old literal meaning.
        if (tokens[index] === "--fps" && /^\+?\d+$/.test(tokens[index + 1] ?? ""))
            index += 1;
        else
            operands.push(tokens[index]);
    }
    return operands.length > 0 ? { path: operands[0], url: operands[1] } : { path: tokens[2], url: tokens[3] };
}
/** Starts conservatively invalidate refs because older supported natives replace the page, even on failure. Restarts invalidate only when they have a URL. */
export function isRecordPageTransitionCommand(tokens) {
    if (tokens[0] !== "record")
        return false;
    if (tokens[1] === "start")
        return true;
    return tokens[1] === "restart" && getRecordCommandOperands(tokens).url !== undefined;
}
export function isWebMcpPageMutationCommand(tokens) {
    return isWebMcpPageMutation(tokens[0], tokens[1]);
}
export function isWindowOrDiffPageTransitionCommand(command, subcommand) {
    return (command === "window" && subcommand === "new") || (command === "diff" && subcommand === "url");
}
export function isRefInvalidatingBatchCommand(step) {
    return hasCommandCapability(step[0], "invalidatesBatchRefs") || isRecordPageTransitionCommand(step) || isWebMcpPageMutationCommand(step) || isWindowOrDiffPageTransitionCommand(step[0], step[1]);
}
export function isRefGuardedCommand(command) {
    return hasCommandCapability(command, "guardsPageRefs");
}
export function isElectronPostCommandHealthCommand(command) {
    return hasCommandCapability(command, "eligibleForElectronHealthProbe");
}
function isWebMcpPageMutation(command, subcommand) {
    return command === "webmcp" && WEBMCP_PAGE_MUTATION_SUBCOMMANDS.has(subcommand ?? "");
}
export function isNavigationObservableCommandName(command, subcommand) {
    return hasCommandCapability(command, "navigationObservable") || isWebMcpPageMutation(command, subcommand) || isWindowOrDiffPageTransitionCommand(command, subcommand);
}
export function isUnverifiedPageTransitionCommand(command, subcommand) {
    return ["back", "connect", "eval", "forward", "reload"].includes(command ?? "")
        || (command === "state" && subcommand === "load")
        || (command === "tab" && subcommand !== undefined && !["list", "new"].includes(subcommand))
        || isWindowOrDiffPageTransitionCommand(command, subcommand)
        || isWebMcpPageMutation(command, subcommand);
}
export function isPageMutationCommand(command, subcommand) {
    return hasCommandCapability(command, "triggersPostMutationSnapshot") || isWebMcpPageMutation(command, subcommand);
}
export function isPageChangeSummaryCommand(command, subcommand) {
    return hasCommandCapability(command, "eligibleForPageChangeSummary") || isWebMcpPageMutation(command, subcommand);
}
