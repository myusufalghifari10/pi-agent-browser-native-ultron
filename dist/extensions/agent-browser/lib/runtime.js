import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { extractUpstreamCommandTokens, findCommandStartIndex, parseArgvDescriptor, parseCommandInfo, } from "./argv-descriptor.js";
import { batchHasSuccessfulCloseAll, getSuccessfulBatchCloseLifecycle } from "./batch-lifecycle.js";
import { canonicalizeAgentBrowserNamespace, extractExplicitNamespace, extractExplicitSessionName, getAgentBrowserSessionIdentityKey, getBooleanFlagValue, GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE, isAgentBrowserSessionIdentityKeyInNamespace, isUpstreamEnvFlagEnabled, PREVALIDATED_VALUE_FLAGS, resolveAgentBrowserNamespace, scanUpstreamGlobalFlagOccurrences, stripUpstreamGlobalFlags, } from "./argv-grammar.js";
import { needsManagedSession } from "./command-policy.js";
import { isCloseAllCommand, isCloseCommand, isOpenNavigationCommand } from "./command-taxonomy.js";
import { hasLaunchScopedFlagToken, LAUNCH_SCOPED_FLAG_DEFINITIONS, LAUNCH_SCOPED_FLAG_LABEL, } from "./launch-scoped-flags.js";
import { MANAGED_SESSION_NAME_PREFIX, } from "./managed-session-restore.js";
export { extractCommandTokens, extractUpstreamCommandTokens, findCommandStartIndex, parseArgvDescriptor, parseCommandInfo, parseWaitCommandTokens } from "./argv-descriptor.js";
import { isRecord } from "./parsing.js";
import { getAgentBrowserProcessEnvironment } from "./process-environment.js";
import { TARGET_AGENT_BROWSER_VERSION } from "./upstream-version.js";
const OPENAI_HEADLESS_COMPAT_HOSTS = new Set(["chat.com", "chat.openai.com", "chatgpt.com"]);
const CLOUDFLARE_HEADLESS_COMPAT_HOST = "dash.cloudflare.com";
const AGENT_BROWSER_IDLE_TIMEOUT_ENV = "AGENT_BROWSER_IDLE_TIMEOUT_MS";
const IMPLICIT_SESSION_IDLE_TIMEOUT_ENV = "PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS";
const IMPLICIT_SESSION_CLOSE_TIMEOUT_ENV = "PI_AGENT_BROWSER_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS";
const DEFAULT_IMPLICIT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS = 5_000;
const INSPECTION_FLAGS = new Set(["--help", "-h", "--version", "-V"]);
const SENSITIVE_VALUE_FLAGS = new Set(["--body", "--headers", "--password", "--proxy"]);
const SENSITIVE_QUERY_PARAM_PATTERN = /^(?:access(?:_|-)?token|api(?:_|-)?key|auth|authorization|authorization(?:_|-)?session(?:_|-)?id|bearer|client(?:_|-)?secret|code|cookie|id(?:_|-)?token|key|pass(?:word)?|refresh(?:_|-)?token|relay(?:_|-)?state|saml(?:_|-)?request|saml(?:_|-)?response|secret|sentry(?:_|-)?key|session(?:_|-)?id|sig(?:nature)?|token|write(?:_|-)?key)$/i;
const AUTH_STATE_QUERY_PARAM_PATTERN = /^(?:nonce|state)$/i;
const AUTH_URL_CONTEXT_PATTERN = /(?:^|[./_-])(?:auth|authorize|callback|login|oauth2?|oidc|saml|sso)(?:[./?#_-]|$)/i;
const SENSITIVE_FIELD_NAME_PATTERN = /^(?:[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|secret(?:[_-]?(?:key|access[_-]?key))?|token|password|passwd|credentials?|database[_-]?url|db[_-]?url|connection[_-]?string|mongo(?:db)?[_-]?uri|redis[_-]?url)|[A-Za-z0-9]*(?:apiKey|ApiKey|apikey|privateKey|PrivateKey|databaseUrl|DatabaseUrl|dbUrl|DbUrl|connectionString|ConnectionString|mongoUri|MongoUri|mongodbUri|MongodbUri|mongoDbUri|MongoDbUri|redisUrl|RedisUrl|Token|Secret|Password|Credential|Credentials)|auth(?:orization)?|bearer|client(?:_|-)?secret|cookie|id(?:_|-)?token|pass(?:word)?|proxy(?:_|-)?authorization|refresh(?:_|-)?token|sentry(?:_|-)?key|session(?:_|-)?id|set(?:_|-)?cookie|sig(?:nature)?|write(?:_|-)?key|x(?:_|-)?api(?:_|-)?key)$/i;
const ENV_SECRET_ASSIGNMENT_PATTERN = /\b((?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)(\s*[:=]\s*))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/g;
const DEFAULT_HEADLESS_COMPAT_USER_AGENT_BY_PLATFORM = {
    darwin: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    win32: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
};
const FALLBACK_HEADLESS_COMPAT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const SHELL_OPERATOR_TOKENS = new Set(["&&", "||", "|", ";", ">", ">>", "<"]);
const ANDROID_SESSION_NAME_IDENTITY_LENGTH = 20;
const MAX_PROJECT_SLUG_LENGTH = 24;
const SESSION_NAME_CWD_HASH_LENGTH = 8;
const SESSION_NAME_SESSION_ID_LENGTH = 12;
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function shouldRedactQueryParam(name) {
    return SENSITIVE_QUERY_PARAM_PATTERN.test(name) || isSensitiveFieldName(name);
}
function redactUrlToken(token) {
    let parsed;
    try {
        parsed = new URL(token);
    }
    catch {
        return token;
    }
    const originalHref = parsed.href;
    if (parsed.username.length > 0)
        parsed.username = "[REDACTED]";
    if (parsed.password.length > 0)
        parsed.password = "[REDACTED]";
    const hashText = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
    const hashParams = hashText.includes("=") ? new URLSearchParams(hashText) : undefined;
    const authContext = AUTH_URL_CONTEXT_PATTERN.test(`${parsed.hostname}${parsed.pathname}`)
        || [...parsed.searchParams.keys(), ...(hashParams?.keys() ?? [])].some(shouldRedactQueryParam);
    for (const [name] of parsed.searchParams) {
        if (shouldRedactQueryParam(name) || (authContext && AUTH_STATE_QUERY_PARAM_PATTERN.test(name))) {
            parsed.searchParams.set(name, "[REDACTED]");
        }
    }
    if (hashParams) {
        let hashMutated = false;
        for (const [name] of hashParams) {
            if (shouldRedactQueryParam(name) || (authContext && AUTH_STATE_QUERY_PARAM_PATTERN.test(name))) {
                hashParams.set(name, "[REDACTED]");
                hashMutated = true;
            }
        }
        if (hashMutated)
            parsed.hash = `#${hashParams.toString()}`;
    }
    return parsed.href === originalHref ? token : parsed.href;
}
function redactLooseUrlParameterText(text) {
    return text.replace(/(?<![^\s"'`<>\])}])[^\s"'`<>\])}]*[?#&][^\s"'`<>\])}]*/g, (token) => {
        const queryNames = [...token.matchAll(/[?#&]([^=&#\s"'`<>\])}]+)=/g)].map((match) => {
            try {
                return decodeURIComponent((match[1] ?? "").replace(/\+/g, " "));
            }
            catch {
                return match[1] ?? "";
            }
        });
        const authContext = AUTH_URL_CONTEXT_PATTERN.test(token) || queryNames.some(shouldRedactQueryParam);
        return token.replace(/([?#&])([^=&#\s"'`<>\])}]+)=([^&#\s"'`<>\])}]*)/g, (match, separator, rawName, rawValue) => {
            if (rawValue === "[REDACTED" || rawValue === "[REDACTED]" || /%5Bredacted%5D/i.test(rawValue))
                return match;
            let name = rawName;
            try {
                name = decodeURIComponent(rawName.replace(/\+/g, " "));
            }
            catch {
                // Keep the raw name when percent decoding fails.
            }
            if (!shouldRedactQueryParam(name) && !(authContext && AUTH_STATE_QUERY_PARAM_PATTERN.test(name)))
                return match;
            return `${separator}${rawName}=[REDACTED]`;
        });
    });
}
function redactLooseUrlUserinfo(text) {
    return text.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s"'`/@]+)@([^\s"'`]+)/g, (match, prefix, userinfo, suffix) => {
        if (/%5Bredacted%5D/i.test(userinfo))
            return match;
        if (userinfo.includes("[REDACTED]"))
            return redactLooseUrlParameterText(match);
        return redactLooseUrlParameterText(`${prefix}${userinfo.includes(":") ? "[REDACTED]:[REDACTED]" : "[REDACTED]"}@${suffix}`);
    });
}
function redactLooseUrlMatches(text) {
    return text.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>\])]+/g, (match) => redactUrlToken(match));
}
function findBalancedJsonEnd(text, startIndex) {
    const opener = text[startIndex];
    const closer = opener === "{" ? "}" : opener === "[" ? "]" : undefined;
    if (!closer)
        return undefined;
    const stack = [closer];
    let inString = false;
    let escaped = false;
    for (let index = startIndex + 1; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{") {
            stack.push("}");
            continue;
        }
        if (char === "[") {
            stack.push("]");
            continue;
        }
        if (char === "}" || char === "]") {
            if (stack.pop() !== char)
                return undefined;
            if (stack.length === 0)
                return index;
        }
    }
    return undefined;
}
function redactSerializedJson(text) {
    // Validate grammar only; rebuilding parsed values loses duplicates and numeric spelling.
    try {
        JSON.parse(text);
    }
    catch {
        return undefined;
    }
    let output = "";
    let cursor = 0;
    const strings = /"(?:\\.|[^"\\])*"/g;
    let match;
    while ((match = strings.exec(text)) !== null) {
        const end = strings.lastIndex;
        const value = JSON.parse(match[0]);
        const redacted = redactSensitiveText(value);
        if (redacted !== value) {
            output += text.slice(cursor, match.index) + JSON.stringify(redacted);
            cursor = end;
        }
        const separator = /^\s*:\s*/.exec(text.slice(end));
        if (!separator || !isSensitiveFieldName(value))
            continue;
        const valueStart = end + separator[0].length;
        let valueEnd = findBalancedJsonEnd(text, valueStart);
        if (valueEnd !== undefined) {
            valueEnd += 1;
        }
        else if (text[valueStart] === '"') {
            strings.lastIndex = valueStart;
            const fieldValue = strings.exec(text);
            valueEnd = strings.lastIndex;
            if (JSON.parse(fieldValue[0]) === "[REDACTED]")
                continue;
        }
        else {
            valueEnd = valueStart;
            while (valueEnd < text.length && !/[\s,\]}]/.test(text[valueEnd]))
                valueEnd += 1;
        }
        output += text.slice(cursor, valueStart) + '"[REDACTED]"';
        cursor = valueEnd;
        strings.lastIndex = valueEnd;
    }
    return output + text.slice(cursor);
}
function redactEmbeddedStructuredText(text) {
    let output = "";
    let cursor = 0;
    while (cursor < text.length) {
        const char = text[cursor];
        if (char !== "{" && char !== "[") {
            output += char;
            cursor += 1;
            continue;
        }
        const endIndex = findBalancedJsonEnd(text, cursor);
        if (endIndex === undefined) {
            output += char;
            cursor += 1;
            continue;
        }
        const candidate = text.slice(cursor, endIndex + 1);
        output += redactSerializedJson(candidate) ?? candidate;
        cursor = endIndex + 1;
    }
    return output;
}
function redactStandaloneBasicCredential(text) {
    return text.replace(/\b(Basic)\s+([A-Za-z0-9+/=]{12,})/gi, (match, label, credential) => {
        if (!/[0-9+/=]/.test(credential))
            return match;
        return `${label} [REDACTED]`;
    });
}
function credentialTrailingPunctuation(credential) {
    return credential.match(/[,.:;!?]+$/)?.[0] ?? "";
}
function formatRedactedCredential(label, credential, trailing = "") {
    return `${label} [REDACTED]${credentialTrailingPunctuation(credential)}${trailing}`;
}
function redactBearerCredentials(text) {
    return text
        .replace(/((?:\b([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*|(?:^|\s)(?:-H\s*|--header(?:\s+|=)))["']?Bearer)\s+([^\s"',)\[\]]+)([),.]?)/gi, (match, label, field, credential, trailing) => {
        if (field && !isSensitiveFieldName(field))
            return match;
        return formatRedactedCredential(label, credential, trailing);
    })
        .replace(/\b(Bearer)\s+([^\s"',)\[\]]+)([),.]?)/gi, (match, label, credential, trailing) => {
        // Without a credential field/header, require a bearer-token shape, not prose, HTML or a URL.
        const token = credential.slice(0, credential.length - credentialTrailingPunctuation(credential).length);
        if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || !/[0-9._~+/=-]/.test(token))
            return match;
        return formatRedactedCredential(label, credential, trailing);
    });
}
export function isSensitiveFieldName(key) {
    SENSITIVE_FIELD_NAME_PATTERN.lastIndex = 0;
    return SENSITIVE_FIELD_NAME_PATTERN.test(key);
}
function isEnvSecretAssignmentKey(key) {
    if (!isSensitiveFieldName(key))
        return false;
    if (key.includes("_") || key.includes("-") || key === key.toUpperCase())
        return true;
    return /(?:apiKey|ApiKey|privateKey|PrivateKey|databaseUrl|DatabaseUrl|dbUrl|DbUrl|connectionString|ConnectionString|mongoUri|MongoUri|mongodbUri|MongodbUri|mongoDbUri|MongoDbUri|redisUrl|RedisUrl|Token|Secret|Password|Credential|Credentials)$/.test(key);
}
function redactEnvSecretAssignments(text) {
    return text.replace(ENV_SECRET_ASSIGNMENT_PATTERN, (match, prefix, key) => {
        if (!isEnvSecretAssignmentKey(key))
            return match;
        return `${prefix}[REDACTED]`;
    });
}
export function redactSensitiveText(text) {
    // Redact JSON string literals before text heuristics can consume their escapes.
    // Non-JSON stays whole so assignments and headers retain their credential context.
    const serialized = redactSerializedJson(text);
    if (serialized !== undefined)
        return serialized;
    const embeddedRedactedText = redactEmbeddedStructuredText(text);
    return redactEmbeddedStructuredText(redactEnvSecretAssignments(redactStandaloneBasicCredential(redactBearerCredentials(redactLooseUrlParameterText(redactLooseUrlUserinfo(redactLooseUrlMatches(embeddedRedactedText))))
        .replace(/\b(Authorization\s*:\s*Basic)\s+[^\s",]+/gi, "$1 [REDACTED]")
        .replace(/\b(Cookie|Set-Cookie)\s*:\s*[^\n\r"]+/gi, "$1: [REDACTED]"))));
}
export function redactSensitiveValue(value) {
    if (typeof value === "string") {
        return redactSensitiveText(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactSensitiveValue(item));
    }
    if (!isRecord(value)) {
        return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => {
        if (isSensitiveFieldName(key)) {
            return [key, "[REDACTED]"];
        }
        return [key, redactSensitiveValue(entryValue)];
    }));
}
function redactFlagValue(flag, value) {
    if (SENSITIVE_VALUE_FLAGS.has(flag)) {
        return "[REDACTED]";
    }
    return redactUrlToken(value);
}
export function redactInvocationArgs(args) {
    const redacted = [];
    let pendingValueFlag;
    for (const token of args) {
        if (pendingValueFlag) {
            redacted.push(redactFlagValue(pendingValueFlag, token));
            pendingValueFlag = undefined;
            continue;
        }
        const normalizedToken = token.split("=", 1)[0] ?? token;
        if (SENSITIVE_VALUE_FLAGS.has(normalizedToken)) {
            if (token.includes("=")) {
                redacted.push(`${normalizedToken}=[REDACTED]`);
            }
            else {
                redacted.push(token);
                pendingValueFlag = normalizedToken;
            }
            continue;
        }
        redacted.push(redactSensitiveText(redactUrlToken(token)));
    }
    const commandStartIndex = findCommandStartIndex(args);
    if (commandStartIndex !== undefined && args[commandStartIndex] === "set" && args[commandStartIndex + 1] === "credentials") {
        for (const index of [commandStartIndex + 2, commandStartIndex + 3]) {
            if (redacted[index] !== undefined) {
                redacted[index] = "[REDACTED]";
            }
        }
    }
    if (commandStartIndex !== undefined && args[commandStartIndex] === "cookies" && args[commandStartIndex + 1] === "set" && redacted[commandStartIndex + 3] !== undefined) {
        redacted[commandStartIndex + 3] = "[REDACTED]";
    }
    if (commandStartIndex !== undefined
        && args[commandStartIndex] === "storage"
        && ["local", "session"].includes(args[commandStartIndex + 1] ?? "")
        && args[commandStartIndex + 2] === "set"
        && redacted[commandStartIndex + 4] !== undefined) {
        redacted[commandStartIndex + 4] = "[REDACTED]";
    }
    if (commandStartIndex !== undefined && args[commandStartIndex] === "clipboard" && args[commandStartIndex + 1] === "write") {
        for (let index = commandStartIndex + 2; index < redacted.length; index += 1) {
            redacted[index] = "[REDACTED]";
        }
    }
    return redacted;
}
export function isPlainTextInspectionArgs(args) {
    return args.some((token) => INSPECTION_FLAGS.has(token));
}
function parseTimeoutMs(rawValue, minimumValue) {
    if (typeof rawValue !== "string")
        return undefined;
    const normalizedValue = rawValue.trim();
    if (!/^\d+$/.test(normalizedValue))
        return undefined;
    const parsedValue = Number(normalizedValue);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < minimumValue) {
        return undefined;
    }
    return parsedValue;
}
export function getImplicitSessionIdleTimeoutMs(env = getAgentBrowserProcessEnvironment()) {
    return parseTimeoutMs(env[IMPLICIT_SESSION_IDLE_TIMEOUT_ENV], 0) ??
        parseTimeoutMs(env[AGENT_BROWSER_IDLE_TIMEOUT_ENV], 0) ??
        DEFAULT_IMPLICIT_SESSION_IDLE_TIMEOUT_MS;
}
function countExplicitGlobalFlags(args, targetFlag) {
    return scanUpstreamGlobalFlagOccurrences(args, targetFlag).length;
}
export function getImplicitSessionCloseTimeoutMs(env = getAgentBrowserProcessEnvironment()) {
    return parseTimeoutMs(env[IMPLICIT_SESSION_CLOSE_TIMEOUT_ENV], 0) ?? DEFAULT_IMPLICIT_SESSION_CLOSE_TIMEOUT_MS;
}
export function resolveManagedSessionState(options) {
    const { command, managedSessionName, priorActive, priorSessionName, succeeded } = options;
    const managedSessionNamespace = canonicalizeAgentBrowserNamespace(options.managedSessionNamespace);
    const priorNamespace = canonicalizeAgentBrowserNamespace(options.priorNamespace);
    if (!managedSessionName) {
        return { active: priorActive, ...(priorNamespace ? { namespace: priorNamespace } : {}), sessionName: priorSessionName };
    }
    if (isCloseCommand(command) && managedSessionName === priorSessionName) {
        if (managedSessionNamespace !== priorNamespace)
            return { active: priorActive, ...(priorNamespace ? { namespace: priorNamespace } : {}), sessionName: priorSessionName };
        const namespace = succeeded ? undefined : priorNamespace;
        return { active: succeeded ? false : priorActive, ...(namespace ? { namespace } : {}), sessionName: priorSessionName };
    }
    if (!succeeded) {
        return { active: priorActive, ...(priorNamespace ? { namespace: priorNamespace } : {}), sessionName: priorSessionName };
    }
    return {
        active: true,
        ...(managedSessionNamespace ? { namespace: managedSessionNamespace } : {}),
        replacedSessionName: priorActive && priorSessionName !== managedSessionName ? priorSessionName : undefined,
        sessionName: managedSessionName,
    };
}
export function isRestorableManagedSessionName(sessionName, fallbackSessionName) {
    return sessionName === fallbackSessionName || sessionName.startsWith(`${fallbackSessionName}-fresh-`);
}
function getManagedSessionRestoreRank(options) {
    const { fallbackSessionName, freshSessionRanks, sessionName } = options;
    if (sessionName === fallbackSessionName) {
        return 0;
    }
    if (!sessionName.startsWith(`${fallbackSessionName}-fresh-`)) {
        return undefined;
    }
    const existingRank = freshSessionRanks.get(sessionName);
    if (existingRank !== undefined) {
        return existingRank;
    }
    const nextRank = freshSessionRanks.size + 1;
    freshSessionRanks.set(sessionName, nextRank);
    return nextRank;
}
function getRestorableManagedSessionName(value, fallbackSessionName) {
    return typeof value === "string" && isRestorableManagedSessionName(value, fallbackSessionName) ? value : undefined;
}
function getElectronCleanupClosedManagedSessions(details, fallbackSessionName) {
    const electron = isRecord(details.electron) ? details.electron : undefined;
    const cleanup = isRecord(electron?.cleanup) ? electron.cleanup : undefined;
    const results = Array.isArray(cleanup?.results) ? cleanup.results : [];
    const closedSessions = [];
    for (const result of results) {
        if (!isRecord(result) || !Array.isArray(result.steps))
            continue;
        const record = isRecord(result.record) ? result.record : undefined;
        const fallbackNamespace = typeof record?.namespace === "string"
            ? record.namespace
            : typeof details.namespace === "string" ? details.namespace : undefined;
        for (const step of result.steps) {
            if (!isRecord(step) || step.resource !== "managed-session")
                continue;
            if (step.state !== "removed" && step.state !== "already-gone")
                continue;
            const sessionName = getRestorableManagedSessionName(step.sessionName, fallbackSessionName)
                ?? getRestorableManagedSessionName(record?.sessionName, fallbackSessionName);
            const namespace = typeof step.namespace === "string" ? step.namespace : fallbackNamespace;
            if (sessionName)
                closedSessions.push({ namespace, sessionName });
        }
    }
    return closedSessions;
}
export function restoreManagedSessionStateFromBranch(branch, fallbackSessionName) {
    const restoreDisabledIdentities = new Map();
    let restoredState = {
        active: false,
        sessionName: fallbackSessionName,
    };
    let activeRestoreRank = 0;
    let closedSessionName;
    let freshSessionOrdinal = 0;
    const freshSessionRanks = new Map();
    const applyManagedClose = (sessionName, namespace) => {
        namespace = canonicalizeAgentBrowserNamespace(namespace);
        const restoreRank = getManagedSessionRestoreRank({
            fallbackSessionName,
            freshSessionRanks,
            sessionName,
        });
        if (restoreRank === undefined || sessionName !== restoredState.sessionName || namespace !== restoredState.namespace)
            return;
        restoredState = { active: false, sessionName: restoredState.sessionName };
        closedSessionName = sessionName;
    };
    for (const entry of branch) {
        if (!isRecord(entry) || entry.type !== "message") {
            continue;
        }
        const message = isRecord(entry.message) ? entry.message : undefined;
        if (!message || message.toolName !== "agent_browser") {
            continue;
        }
        const details = isRecord(message.details) ? message.details : undefined;
        if (!details) {
            continue;
        }
        const args = isStringArray(details.args) ? details.args : [];
        if (isPlainTextInspectionArgs(args)) {
            continue;
        }
        for (const cleanupSession of getElectronCleanupClosedManagedSessions(details, fallbackSessionName)) {
            applyManagedClose(cleanupSession.sessionName, cleanupSession.namespace);
        }
        const explicitSessionName = extractExplicitSessionName(args);
        const sessionName = typeof details.sessionName === "string" ? details.sessionName : undefined;
        const namespace = canonicalizeAgentBrowserNamespace(typeof details.namespace === "string" ? details.namespace : undefined);
        const sessionMode = details.sessionMode === "fresh" || details.sessionMode === "auto" ? details.sessionMode : undefined;
        const usedImplicitSession = details.usedImplicitSession === true;
        const commandTokens = extractUpstreamCommandTokens(args);
        const command = typeof details.command === "string" ? details.command : parseCommandInfo(args).command;
        const batchCloseLifecycle = getSuccessfulBatchCloseLifecycle(details.batchSteps);
        const nestedBatchEndsClosed = batchCloseLifecycle?.endsClosed === true;
        const nestedBatchRemainsActive = batchCloseLifecycle?.endsClosed === false;
        const closeAllApplied = details.closeAllApplied === true
            || (message.isError !== true && isCloseAllCommand(commandTokens))
            || batchHasSuccessfulCloseAll(details.batchSteps);
        const commandClosesSession = isCloseCommand(command) || nestedBatchEndsClosed;
        const outcome = typeof details.managedSessionOutcome === "object" && details.managedSessionOutcome !== null ? details.managedSessionOutcome : undefined;
        const outcomeStatus = typeof outcome?.status === "string" ? outcome.status : undefined;
        const outcomeCurrentSessionName = typeof outcome?.currentSessionName === "string" ? outcome.currentSessionName : undefined;
        const outcomeAttemptedSessionName = getRestorableManagedSessionName(outcome?.attemptedSessionName, fallbackSessionName);
        const outcomeClosedSessionName = outcomeStatus === "closed" && outcome?.succeeded === true
            ? outcomeAttemptedSessionName ?? getRestorableManagedSessionName(outcomeCurrentSessionName, fallbackSessionName) ?? getRestorableManagedSessionName(sessionName, fallbackSessionName)
            : undefined;
        const restorableDetailSessionName = getRestorableManagedSessionName(sessionName, fallbackSessionName);
        if (closeAllApplied && restoredState.active) {
            const restoredKey = getAgentBrowserSessionIdentityKey(restoredState.sessionName, restoredState.namespace);
            const resultKey = restorableDetailSessionName ? getAgentBrowserSessionIdentityKey(restorableDetailSessionName, namespace) : undefined;
            const retainsCurrentSession = nestedBatchRemainsActive && resultKey === restoredKey;
            if (isAgentBrowserSessionIdentityKeyInNamespace(restoredKey, namespace) && !retainsCurrentSession) {
                applyManagedClose(restoredState.sessionName, restoredState.namespace);
            }
        }
        const explicitCloseSessionName = commandClosesSession && explicitSessionName && restorableDetailSessionName === explicitSessionName
            ? restorableDetailSessionName
            : undefined;
        // Sticky restore policy is session-identity state and must apply even for explicit
        // `--session <current-managed>` rows that are not used for managed-session lifecycle replay.
        if (details.managedSessionRestoreDisabled === true && typeof sessionName === "string") {
            restoreDisabledIdentities.set(getAgentBrowserSessionIdentityKey(sessionName, namespace), { namespace, sessionName });
        }
        const managedSessionName = outcomeClosedSessionName ?? (!explicitSessionName &&
            restorableDetailSessionName &&
            (usedImplicitSession || sessionMode === "fresh")
            ? restorableDetailSessionName
            : commandClosesSession
                ? explicitCloseSessionName
                : undefined);
        if (!managedSessionName) {
            continue;
        }
        const restoreRank = getManagedSessionRestoreRank({
            fallbackSessionName,
            freshSessionRanks,
            sessionName: managedSessionName,
        });
        if (restoreRank === undefined) {
            continue;
        }
        freshSessionOrdinal = Math.max(freshSessionOrdinal, restoreRank);
        const messageIsError = typeof message.isError === "boolean" ? message.isError : undefined;
        const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
        const outcomeActiveAfter = outcome?.activeAfter === true;
        const outcomeRepresentsActiveCurrentSession = outcomeActiveAfter && outcomeCurrentSessionName === managedSessionName && (outcomeStatus === "created" || outcomeStatus === "replaced" || outcomeStatus === "unchanged");
        const succeeded = outcomeRepresentsActiveCurrentSession || nestedBatchRemainsActive
            ? true
            : messageIsError === undefined ? exitCode === undefined || exitCode === 0 : !messageIsError;
        if (commandClosesSession || outcomeClosedSessionName) {
            if (nestedBatchEndsClosed || outcomeClosedSessionName || succeeded) {
                restoreDisabledIdentities.delete(getAgentBrowserSessionIdentityKey(managedSessionName, namespace));
                applyManagedClose(managedSessionName, namespace);
            }
            continue;
        }
        const staleCompletion = succeeded && restoreRank < activeRestoreRank;
        if (staleCompletion) {
            continue;
        }
        restoredState = resolveManagedSessionState({
            command,
            managedSessionName,
            managedSessionNamespace: namespace,
            priorActive: restoredState.active,
            priorNamespace: restoredState.namespace,
            priorSessionName: restoredState.sessionName,
            succeeded,
        });
        if (succeeded && restoredState.active) {
            activeRestoreRank = restoreRank;
            closedSessionName = undefined;
        }
    }
    return {
        ...restoredState,
        ...(closedSessionName ? { closedSessionName } : {}),
        freshSessionOrdinal,
        managedSessionRestoreDisabledIdentities: [...restoreDisabledIdentities.values()],
    };
}
export function createEphemeralSessionSeed() {
    return randomUUID();
}
function createCwdHash(cwd) {
    return createHash("sha256").update(`cwd:${cwd}`).digest("hex").slice(0, SESSION_NAME_CWD_HASH_LENGTH);
}
export function createImplicitSessionName(sessionId, cwd, ephemeralSeed, platform = process.platform) {
    const normalizedSessionId = sessionId?.replaceAll("-", "").toLowerCase();
    if (platform === "android") {
        const identity = normalizedSessionId ? `session:${normalizedSessionId}:cwd:${cwd}` : `ephemeral:${cwd}:${ephemeralSeed}`;
        const digest = createHash("sha256").update(identity).digest("hex").slice(0, ANDROID_SESSION_NAME_IDENTITY_LENGTH);
        return `${MANAGED_SESSION_NAME_PREFIX}${digest}`;
    }
    const slug = basename(cwd)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_PROJECT_SLUG_LENGTH) || "project";
    const cwdHash = createCwdHash(cwd);
    if (normalizedSessionId) {
        const stableSessionId = createHash("sha256")
            .update(`session:${normalizedSessionId}`)
            .digest("hex")
            .slice(0, SESSION_NAME_SESSION_ID_LENGTH);
        return `${MANAGED_SESSION_NAME_PREFIX}${slug}-${stableSessionId}-${cwdHash}`;
    }
    const digest = createHash("sha256")
        .update(`ephemeral:${cwd}:${ephemeralSeed}`)
        .digest("hex")
        .slice(0, SESSION_NAME_SESSION_ID_LENGTH);
    return `${MANAGED_SESSION_NAME_PREFIX}${slug}-${digest}-${cwdHash}`;
}
export function createFreshSessionName(baseSessionName, ephemeralSeed, ordinal) {
    const suffix = createHash("sha256")
        .update(`fresh:${baseSessionName}:${ephemeralSeed}:${ordinal}`)
        .digest("hex")
        .slice(0, 10);
    return `${baseSessionName}-fresh-${suffix}`;
}
function getSingleKeyCommandValidationError(args) {
    const { commandInfo, upstreamCommandTokens: commandTokens } = parseArgvDescriptor(args);
    const command = commandInfo.command;
    if (command !== "press" && command !== "key" && command !== "keydown" && command !== "keyup")
        return undefined;
    if (commandTokens.length === 2)
        return undefined;
    const label = command === "key" ? "key/press" : command;
    return `agent-browser ${label} accepts exactly one key argument. Do not pass a selector or ref to ${label}; focus or click the target first, then run ${command} <key> (for example: focus @e1, then press Enter).`;
}
function getBareMcpValidationError(args) {
    const { commandInfo, upstreamCommandTokens: commandTokens } = parseArgvDescriptor(args);
    if (commandInfo.command !== "mcp")
        return undefined;
    if (commandTokens.includes("--help") || commandTokens.includes("-h"))
        return undefined;
    return "agent-browser mcp starts a stdio MCP server for external MCP clients, not a one-shot native agent_browser tool workflow. Use the native agent_browser tool modes directly, or configure an MCP client to launch `agent-browser mcp`. Use `mcp --help` for help.";
}
function getUnsupportedInlineWaitDownloadError(args) {
    const descriptor = parseArgvDescriptor(args);
    if (descriptor.commandInfo.command !== "wait" || !descriptor.upstreamCommandTokens.some((token) => token.startsWith("--download=")))
        return undefined;
    return `agent-browser ${TARGET_AGENT_BROWSER_VERSION} does not support \`wait --download=<path>\`. Pass the optional path as a separate argument: \`wait --download <path>\` (or \`wait -d <path>\`).`;
}
function getBareNoSandboxValidationError(args, batchStep) {
    // Native batch rows skip global parsing; --args is effective only on the outer CLI call.
    const tokens = batchStep ? args : stripUpstreamGlobalFlags(args);
    const command = tokens[0];
    const leading = command === "--no-sandbox";
    if (!leading && (!isOpenNavigationCommand(command) || !tokens.slice(1).includes("--no-sandbox")))
        return undefined;
    const explanation = leading
        ? "`--no-sandbox` is not an agent-browser command."
        : `\`--no-sandbox\` is ignored as an option by \`${command}\`.`;
    return `${explanation} It is a Chromium launch argument. Put it in top-level \`--args\` and start a fresh session: { args: ["--args", "--no-sandbox", "open", "https://example.com"], sessionMode: "fresh" }. For batch, put --args before batch, not inside a step.`;
}
export function validateToolArgs(args, options = {}) {
    if (args.length === 0) {
        return "`args` must contain at least one agent-browser command token.";
    }
    const shellOperator = args.find((token) => SHELL_OPERATOR_TOKENS.has(token));
    if (shellOperator) {
        return `Do not pass shell operators like \`${shellOperator}\`. Pass exact agent-browser CLI arguments only.`;
    }
    const sessionModeArg = args.find((token) => token === "--session-mode" || token.startsWith("--session-mode="));
    if (sessionModeArg) {
        return "Do not pass `--session-mode` in args. Use the top-level agent_browser `sessionMode` field instead, for example { args: [\"--profile\", \"Default\", \"open\", \"https://example.com\"], sessionMode: \"fresh\" }.";
    }
    const inspection = !options.batchStep && isPlainTextInspectionArgs(args);
    const invalidValueFlag = inspection ? undefined : getInvalidValueFlagDetails(args, !options.batchStep);
    if (invalidValueFlag?.reason === "unsupported-assignment")
        return formatInvalidValueFlagError(invalidValueFlag, options.batchStep);
    return (inspection ? undefined : getBareNoSandboxValidationError(args, options.batchStep === true))
        ?? getBareMcpValidationError(args) ?? getSingleKeyCommandValidationError(args) ?? getUnsupportedInlineWaitDownloadError(args);
}
function getInvalidValueFlagDetails(args, allowRestoreAssignment = true) {
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (!token.startsWith("-")) {
            continue;
        }
        const normalizedToken = token.split("=", 1)[0] ?? token;
        if (token.includes("=")
            && (PREVALIDATED_VALUE_FLAGS.has(normalizedToken)
                || GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(normalizedToken)
                || (!allowRestoreAssignment && normalizedToken === "--restore"))) {
            return {
                flag: normalizedToken,
                index,
                reason: "unsupported-assignment",
            };
        }
        if (!PREVALIDATED_VALUE_FLAGS.has(normalizedToken)) {
            continue;
        }
        const receivedToken = args[index + 1];
        if (receivedToken === undefined || (normalizedToken === "--args" && receivedToken.length === 0)) {
            return {
                flag: normalizedToken,
                index,
                reason: "missing-value",
            };
        }
        if (receivedToken.startsWith("-") && !GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE.has(normalizedToken)) {
            return {
                flag: normalizedToken,
                index,
                reason: "unexpected-flag",
                receivedToken,
            };
        }
        index += 1;
    }
    return undefined;
}
function formatInvalidValueFlagError(details, batchStep = false) {
    if (details.reason === "unsupported-assignment") {
        if (batchStep) {
            return details.flag === "--restore"
                ? "Global `--restore=<key>` belongs before `batch` in top-level args, not inside a batch step."
                : `Global \`${details.flag}=<value>\` is not supported inside a batch step. Move \`${details.flag}\` and its value before \`batch\` as separate top-level args.`;
        }
        return `agent-browser ${TARGET_AGENT_BROWSER_VERSION} does not support \`${details.flag}=<value>\`. Pass \`${details.flag}\` and its value as separate arguments.`;
    }
    if (details.reason === "unexpected-flag" && details.receivedToken) {
        return `Flag \`${details.flag}\` requires a value, but received \`${details.receivedToken}\` instead. Pass a non-flag value immediately after \`${details.flag}\`.`;
    }
    return `Flag \`${details.flag}\` requires a value immediately after it. Pass a non-flag token like \`${details.flag} demo\`.`;
}
function hasFlagToken(args, flag) {
    return args.some((token) => token === flag || token.startsWith(`${flag}=`));
}
function normalizeComparableUrl(url) {
    const normalizedUrl = url.trim();
    if (normalizedUrl.length === 0) {
        return undefined;
    }
    try {
        const parsedUrl = new URL(normalizedUrl);
        parsedUrl.hash = "";
        return parsedUrl.toString();
    }
    catch {
        return undefined;
    }
}
function normalizeTabSelectionValue(value) {
    const normalizedValue = value?.trim();
    return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
}
function extractTabSelection(tab) {
    const tabId = normalizeTabSelectionValue(tab.tabId);
    if (tabId) {
        return { selectedTab: tabId, selectionKind: "tabId" };
    }
    const label = normalizeTabSelectionValue(tab.label);
    if (label) {
        return { selectedTab: label, selectionKind: "label" };
    }
    if (typeof tab.index === "number" && Number.isInteger(tab.index) && tab.index >= 0) {
        return { selectedTab: String(tab.index), selectionKind: "index" };
    }
    return undefined;
}
function parseComparableNavigationUrl(url) {
    try {
        return new URL(url);
    }
    catch {
        try {
            return new URL(`https://${url}`);
        }
        catch {
            return undefined;
        }
    }
}
export function getDefaultHeadlessCompatUserAgent(platform = process.platform) {
    return DEFAULT_HEADLESS_COMPAT_USER_AGENT_BY_PLATFORM[platform] ?? FALLBACK_HEADLESS_COMPAT_USER_AGENT;
}
export function canUseHeadlessCompatibilityUserAgent(args, env = getAgentBrowserProcessEnvironment()) {
    if (env.AGENT_BROWSER_SESSION !== undefined)
        return false;
    if (hasFlagToken(args, "--user-agent") || hasFlagToken(args, "--args"))
        return false;
    if (hasFlagToken(args, "--cdp") || hasFlagToken(args, "--provider") || hasFlagToken(args, "-p"))
        return false;
    if (env.AGENT_BROWSER_USER_AGENT !== undefined || env.AGENT_BROWSER_ARGS !== undefined || env.AGENT_BROWSER_CDP !== undefined || env.AGENT_BROWSER_PROVIDER !== undefined)
        return false;
    if ((getBooleanFlagValue(args, "--headed") ?? isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_HEADED))
        || (getBooleanFlagValue(args, "--auto-connect") ?? isUpstreamEnvFlagEnabled(env.AGENT_BROWSER_AUTO_CONNECT)))
        return false;
    const engine = scanUpstreamGlobalFlagOccurrences(args, "--engine").at(-1)?.value ?? env.AGENT_BROWSER_ENGINE;
    return !engine || engine === "chrome";
}
function getCompatibilityWorkaround(args, commandInfo) {
    if (!commandInfo.command || !isOpenNavigationCommand(commandInfo.command) || !commandInfo.subcommand || !canUseHeadlessCompatibilityUserAgent(args))
        return undefined;
    const parsedTargetUrl = parseComparableNavigationUrl(commandInfo.subcommand);
    if (!parsedTargetUrl || !["http:", "https:"].includes(parsedTargetUrl.protocol))
        return undefined;
    const hostname = parsedTargetUrl.hostname.toLowerCase();
    if (hostname === CLOUDFLARE_HEADLESS_COMPAT_HOST) {
        return {
            id: "cloudflare-headless-user-agent",
            reason: "Cloudflare Dashboard challenges the default headless Chrome user agent; inject a normal Chrome user agent so authenticated headless browsing reaches the dashboard instead of Turnstile.",
        };
    }
    if (!OPENAI_HEADLESS_COMPAT_HOSTS.has(hostname))
        return undefined;
    return {
        id: "chatgpt-headless-user-agent",
        reason: "OpenAI web properties currently challenge the default headless Chrome user agent; inject a normal Chrome user agent to preserve the default headless workflow without requiring headed mode or auto-connect.",
    };
}
function stripExplicitSessionArgs(args) {
    const sessionTokenIndexes = new Set();
    for (const occurrence of scanUpstreamGlobalFlagOccurrences(args, "--session")) {
        sessionTokenIndexes.add(occurrence.index);
        sessionTokenIndexes.add(occurrence.index + 1);
    }
    return args.filter((_token, index) => !sessionTokenIndexes.has(index));
}
function stripExplicitNamespaceArgs(args) {
    const namespaceTokenIndexes = new Set();
    for (const occurrence of scanUpstreamGlobalFlagOccurrences(args, "--namespace")) {
        namespaceTokenIndexes.add(occurrence.index);
        namespaceTokenIndexes.add(occurrence.index + 1);
    }
    return args.filter((_token, index) => !namespaceTokenIndexes.has(index));
}
export function getStartupScopedFlags(args) {
    return LAUNCH_SCOPED_FLAG_DEFINITIONS
        .map((definition) => definition.flag)
        .filter((flag) => hasLaunchScopedFlagToken(args, flag));
}
export function buildExecutionPlan(args, options) {
    const nativeSession = getAgentBrowserProcessEnvironment().AGENT_BROWSER_SESSION;
    if (nativeSession !== undefined && !isPlainTextInspectionArgs(args) && extractExplicitSessionName(args) === undefined)
        args = ["--session", nativeSession, ...args];
    const invalidValueFlag = getInvalidValueFlagDetails(args);
    const explicitNamespacePresent = scanUpstreamGlobalFlagOccurrences(args, "--namespace").length > 0;
    const explicitNamespace = extractExplicitNamespace(args);
    const managedSessionNamespace = canonicalizeAgentBrowserNamespace(options.managedSessionNamespace);
    const startupScopedFlags = getStartupScopedFlags(args).filter((flag) => !(flag === "--namespace" && explicitNamespacePresent && explicitNamespace === managedSessionNamespace));
    const plainTextInspection = isPlainTextInspectionArgs(args);
    const argvDescriptor = parseArgvDescriptor(args);
    const commandInfo = argvDescriptor.commandInfo;
    const commandNeedsManagedSession = !plainTextInspection && !options.browserIndependentReadConfirmation && needsManagedSession(argvDescriptor, options.stdin);
    const effectiveArgs = plainTextInspection ? [...args] : args.includes("--json") ? [] : ["--json"];
    let namespace = explicitNamespacePresent ? explicitNamespace ?? "" : undefined;
    if (plainTextInspection) {
        return {
            commandInfo,
            effectiveArgs,
            namespace,
            plainTextInspection,
            startupScopedFlags,
            usedImplicitSession: false,
        };
    }
    if (invalidValueFlag) {
        return {
            commandInfo: {},
            effectiveArgs,
            invalidValueFlag,
            plainTextInspection: false,
            startupScopedFlags: [],
            usedImplicitSession: false,
            validationError: formatInvalidValueFlagError(invalidValueFlag),
        };
    }
    for (const flag of ["--session", "--namespace"]) {
        if (countExplicitGlobalFlags(args, flag) <= 1)
            continue;
        return {
            commandInfo: {},
            effectiveArgs,
            plainTextInspection: false,
            startupScopedFlags: [],
            usedImplicitSession: false,
            validationError: `Multiple ${flag} flags are not supported. Pass a single ${flag} value; upstream uses the last occurrence while this wrapper would otherwise mis-attribute managed-session ownership.`,
        };
    }
    const explicitSessionName = extractExplicitSessionName(args);
    if (explicitSessionName && !explicitNamespacePresent) {
        const targetsCurrentManagedSession = options.managedSessionActive
            && getAgentBrowserSessionIdentityKey(explicitSessionName, managedSessionNamespace)
                === getAgentBrowserSessionIdentityKey(options.managedSessionName, managedSessionNamespace);
        namespace = targetsCurrentManagedSession
            ? managedSessionNamespace
            : resolveAgentBrowserNamespace(args, getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE);
    }
    const shouldCreateFreshManagedSession = !explicitSessionName && options.sessionMode === "fresh" && commandInfo.command !== undefined && !isCloseCommand(commandInfo.command);
    let argsToAppend = args;
    const requestedCompatibilityWorkaround = getCompatibilityWorkaround(args, commandInfo);
    let compatibilityWorkaround = requestedCompatibilityWorkaround;
    if (explicitSessionName && explicitNamespacePresent) {
        effectiveArgs.push("--namespace", explicitNamespace ?? "");
        argsToAppend = stripExplicitNamespaceArgs(args);
    }
    let managedSessionName;
    let recoveryHint;
    let sessionName = explicitSessionName;
    let usedImplicitSession = false;
    let validationError;
    if (!explicitSessionName && options.sessionMode === "auto" && commandNeedsManagedSession) {
        if (options.managedSessionActive && startupScopedFlags.length > 0) {
            recoveryHint = {
                exampleArgs: args,
                exampleParams: { args, sessionMode: "fresh" },
                reason: `Launch-scoped flags (${LAUNCH_SCOPED_FLAG_LABEL}) need a fresh upstream launch once the extension-managed session is already active.`,
                recommendedSessionMode: "fresh",
            };
            validationError = [
                `The current extension-managed agent-browser session is already running, so launch-scoped flags ${startupScopedFlags.join(", ")} would be ignored by upstream agent-browser.`,
                "Retry this call with `sessionMode: \"fresh\"` to force a fresh upstream launch, or pass an explicit `--session ...` if you want to name the new session yourself.",
            ].join(" ");
        }
        else {
            namespace = explicitNamespacePresent ? explicitNamespace ?? "" : managedSessionNamespace;
            if (namespace !== undefined)
                effectiveArgs.push("--namespace", namespace);
            effectiveArgs.push("--session", options.managedSessionName);
            if (explicitNamespacePresent)
                argsToAppend = stripExplicitNamespaceArgs(args);
            managedSessionName = options.managedSessionName;
            sessionName = options.managedSessionName;
            usedImplicitSession = true;
        }
    }
    else if (shouldCreateFreshManagedSession && commandNeedsManagedSession) {
        if (namespace !== undefined)
            effectiveArgs.push("--namespace", namespace);
        effectiveArgs.push("--session", options.freshSessionName);
        if (explicitNamespacePresent)
            argsToAppend = stripExplicitNamespaceArgs(args);
        managedSessionName = options.freshSessionName;
        sessionName = options.freshSessionName;
    }
    if (commandInfo.command !== undefined && !sessionName && !explicitNamespacePresent) {
        namespace = resolveAgentBrowserNamespace(args, getAgentBrowserProcessEnvironment().AGENT_BROWSER_NAMESPACE);
    }
    const targetsActiveManagedSession = options.managedSessionActive
        && commandNeedsManagedSession
        && sessionName
        && getAgentBrowserSessionIdentityKey(sessionName, namespace) === getAgentBrowserSessionIdentityKey(options.managedSessionName, options.managedSessionNamespace);
    if (targetsActiveManagedSession && startupScopedFlags.length > 0 && !isCloseCommand(commandInfo.command) && !validationError) {
        const recoveryArgs = explicitSessionName ? stripExplicitSessionArgs(args) : args;
        recoveryHint = {
            exampleArgs: recoveryArgs,
            exampleParams: { args: recoveryArgs, sessionMode: "fresh" },
            reason: `Launch-scoped flags (${LAUNCH_SCOPED_FLAG_LABEL}) need a fresh upstream launch once the extension-managed session is already active.`,
            recommendedSessionMode: "fresh",
        };
        validationError = [
            `The current extension-managed agent-browser session is already running, so launch-scoped flags ${startupScopedFlags.join(", ")} would replace or be ignored by upstream agent-browser.`,
            explicitSessionName
                ? "Remove the explicit `--session` and retry with `sessionMode: \"fresh\"` to force a fresh upstream launch."
                : "Retry this call with `sessionMode: \"fresh\"` to force a fresh upstream launch.",
        ].join(" ");
    }
    if (targetsActiveManagedSession && canUseHeadlessCompatibilityUserAgent(args)) {
        if (requestedCompatibilityWorkaround && !options.managedSessionCompatibilityWorkaround && !validationError) {
            compatibilityWorkaround = undefined;
            const recoveryArgs = explicitSessionName ? stripExplicitSessionArgs(args) : args;
            recoveryHint = {
                exampleArgs: recoveryArgs,
                exampleParams: { args: recoveryArgs, sessionMode: "fresh" },
                reason: "The requested site compatibility user agent is launch-scoped and needs a fresh browser session.",
                recommendedSessionMode: "fresh",
            };
            validationError = explicitSessionName
                ? "The current extension-managed agent-browser session is already running without the user agent required by this site. Remove the explicit `--session` and retry with `sessionMode: \"fresh\"` so the compatibility user agent is applied at launch."
                : "The current extension-managed agent-browser session is already running without the user agent required by this site. Retry this call with `sessionMode: \"fresh\"` so the compatibility user agent is applied at launch.";
        }
        else {
            compatibilityWorkaround = requestedCompatibilityWorkaround ?? options.managedSessionCompatibilityWorkaround;
        }
    }
    if (compatibilityWorkaround && !targetsActiveManagedSession) {
        effectiveArgs.push("--user-agent", getDefaultHeadlessCompatUserAgent());
    }
    effectiveArgs.push(...argsToAppend);
    return {
        commandInfo,
        compatibilityWorkaround,
        effectiveArgs,
        managedSessionName,
        namespace,
        plainTextInspection,
        recoveryHint,
        sessionName,
        startupScopedFlags,
        usedImplicitSession,
        validationError,
    };
}
export function chooseOpenResultTabCorrection(options) {
    const normalizedTargetUrl = typeof options.targetUrl === "string" ? normalizeComparableUrl(options.targetUrl) : undefined;
    if (!normalizedTargetUrl) {
        return undefined;
    }
    const tabsWithIndices = options.tabs.map((tab, index) => ({
        ...tab,
        index: typeof tab.index === "number" ? tab.index : index,
        label: normalizeTabSelectionValue(tab.label),
        tabId: normalizeTabSelectionValue(tab.tabId),
    }));
    const activeTab = tabsWithIndices.find((tab) => tab.active === true) ??
        (typeof options.activeTabIndex === "number" ? tabsWithIndices.find((tab) => tab.index === options.activeTabIndex) : undefined);
    if (activeTab && normalizeComparableUrl(activeTab.url ?? "") === normalizedTargetUrl) {
        return undefined;
    }
    const matchingTabs = tabsWithIndices.filter((tab) => normalizeComparableUrl(tab.url ?? "") === normalizedTargetUrl);
    if (matchingTabs.length === 0) {
        return undefined;
    }
    const trimmedTargetTitle = typeof options.targetTitle === "string" ? options.targetTitle.trim() : "";
    const titledMatch = trimmedTargetTitle.length === 0
        ? undefined
        : matchingTabs.find((tab) => typeof tab.title === "string" && tab.title.trim() === trimmedTargetTitle);
    const selectedTab = titledMatch ?? matchingTabs[0];
    const tabSelection = extractTabSelection(selectedTab);
    return tabSelection
        ? {
            ...tabSelection,
            targetTitle: trimmedTargetTitle.length > 0 ? trimmedTargetTitle : undefined,
            targetUrl: normalizedTargetUrl,
        }
        : undefined;
}
