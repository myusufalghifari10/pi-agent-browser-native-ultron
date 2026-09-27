import { isKnownCommandToken } from "./command-taxonomy.js";
export const GLOBAL_VALUE_FLAGS = [
    "--session",
    "--namespace",
    "--cdp",
    "--config",
    "--profile",
    "--session-name",
    "--restore-save",
    "--restore-check-url",
    "--restore-check-text",
    "--restore-check-fn",
    "--proxy",
    "--proxy-bypass",
    "--ca-cert",
    "--headers",
    "--executable-path",
    "--extension",
    "--init-script",
    "--enable",
    "--provider",
    "-p",
    "--engine",
    "--state",
    "--download-path",
    "--screenshot-dir",
    "--screenshot-format",
    "--screenshot-quality",
    "--color-scheme",
    "--device",
    "--args",
    "--user-agent",
    "--allowed-domains",
    "--action-policy",
    "--confirm-actions",
    "--max-output",
    "--model",
    "--idle-timeout",
];
export const COMMAND_VALUE_FLAGS = [
    "--allowed-origins",
    "--baseline",
    "--body",
    "--categories",
    "--content",
    "--curl",
    "--depth",
    "-d",
    "--domain",
    "--expires",
    "--filter",
    "--frame",
    "--fn",
    "--label",
    "--load",
    "--method",
    "--name",
    "--older-than",
    "--output",
    "--prefix",
    "--path",
    "--port",
    "--params",
    "--resource-type",
    "--resource-types",
    "--sameSite",
    "--scope",
    "--selector",
    "-s",
    "--status",
    "--tags",
    "--text",
    "--threshold",
    "--timeout",
    "--type",
    "--url",
    "--username",
    "--password",
    "--wait-until",
];
export const OPTIONAL_GLOBAL_VALUE_FLAGS = new Set(["--restore"]);
export const VALUE_FLAGS = new Set([...GLOBAL_VALUE_FLAGS, ...COMMAND_VALUE_FLAGS]);
export const PREVALIDATED_VALUE_FLAGS = new Set(GLOBAL_VALUE_FLAGS);
export const GLOBAL_VALUE_FLAGS_ALLOWING_DASH_VALUE = new Set(["--args", "--session"]);
export const GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES = new Set([
    "--allow-file-access",
    "--annotate",
    "--auto-connect",
    "--confirm-interactive",
    "--content-boundaries",
    "--debug",
    "--headed",
    "--hide-scrollbars",
    "--ignore-https-errors",
    "--json",
    "--no-auto-dialog",
    "--no-ca-cert",
    "--no-pin-tab",
    "--no-webmcp",
    "--offline",
    "--pin-tab",
    "--quick",
    "--fix",
    "--quiet",
    "-q",
    "--verbose",
    "-v",
    "--webgpu",
]);
const SESSION_COMPONENT_ALPHANUMERIC = /^[\p{Alphabetic}\p{Number}]$/u;
/** Match upstream's last-wins, case-sensitive boolean semantics; only exact `false` disables a present flag. */
export function getBooleanFlagValue(args, flag) {
    let enabled;
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === flag) {
            enabled = args[index + 1] !== "false";
            if (["true", "false"].includes(args[index + 1] ?? ""))
                index += 1;
            continue;
        }
        if (PREVALIDATED_VALUE_FLAGS.has(token)) {
            index += 1;
            continue;
        }
        if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) && ["true", "false"].includes(args[index + 1] ?? ""))
            index += 1;
    }
    return enabled;
}
export function isBooleanFlagEnabled(args, flag) {
    return getBooleanFlagValue(args, flag) ?? false;
}
/** Match upstream env_var_is_truthy exactly: lowercase only, without trimming or accepting "off". */
export function isUpstreamEnvFlagEnabled(value) {
    return value !== undefined && !["", "0", "false", "no"].includes(value.toLowerCase());
}
/** Mirror upstream sanitize_session_component for namespace/socket/state identity. */
export function canonicalizeAgentBrowserNamespace(value) {
    if (value === undefined)
        return undefined;
    let normalized = "";
    let lastWasSeparator = false;
    for (const character of value) {
        if (SESSION_COMPONENT_ALPHANUMERIC.test(character)) {
            normalized += character.toLowerCase();
            lastWasSeparator = false;
        }
        else if (character === "-" || character === "_") {
            if (normalized && !lastWasSeparator) {
                normalized += character;
                lastWasSeparator = true;
            }
        }
        else if (normalized && !lastWasSeparator) {
            normalized += "-";
            lastWasSeparator = true;
        }
    }
    return normalized.replace(/[-_]+$/u, "") || undefined;
}
export function foldAgentBrowserFilesystemIdentity(value, platform) {
    if (platform !== "darwin" && platform !== "win32")
        return value;
    // APFS aliases include full Unicode folds such as ß/SS and ς/Σ, not just ASCII case.
    return value.normalize("NFC").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
}
export function getAgentBrowserSessionIdentityKey(sessionName, namespace, platform = process.platform) {
    const canonicalNamespace = canonicalizeAgentBrowserNamespace(namespace);
    const identityNamespace = canonicalNamespace ? foldAgentBrowserFilesystemIdentity(canonicalNamespace, platform) : undefined;
    const canonicalSessionName = foldAgentBrowserFilesystemIdentity(sessionName, platform);
    return identityNamespace ? `${identityNamespace}\0${canonicalSessionName}` : canonicalSessionName;
}
export function isAgentBrowserSessionIdentityKeyInNamespace(identityKey, namespace) {
    const prefix = getAgentBrowserSessionIdentityKey("", namespace);
    return prefix ? identityKey.startsWith(prefix) : !identityKey.includes("\0");
}
export function deleteIdentityKeysInNamespace(entries, namespace) {
    for (const key of entries.keys()) {
        if (isAgentBrowserSessionIdentityKeyInNamespace(key, namespace))
            entries.delete(key);
    }
}
/** Mirror upstream global parsing: full argv, no `--` sentinel, and only global value payloads are skipped. */
export function scanUpstreamGlobalFlagOccurrences(args, targetFlag) {
    const occurrences = [];
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === targetFlag) {
            occurrences.push({ index, value: args[index + 1] });
            index += 1;
            continue;
        }
        if (PREVALIDATED_VALUE_FLAGS.has(token)) {
            index += 1;
            continue;
        }
        if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) && ["true", "false"].includes(args[index + 1] ?? ""))
            index += 1;
    }
    return occurrences;
}
export function extractExplicitSessionName(args) {
    return scanUpstreamGlobalFlagOccurrences(args, "--session").at(-1)?.value;
}
export function extractExplicitNamespace(args) {
    return canonicalizeAgentBrowserNamespace(scanUpstreamGlobalFlagOccurrences(args, "--namespace").at(-1)?.value);
}
export function resolveAgentBrowserNamespace(args, envValue) {
    const occurrences = scanUpstreamGlobalFlagOccurrences(args, "--namespace");
    if (occurrences.length > 0)
        return canonicalizeAgentBrowserNamespace(occurrences.at(-1)?.value) ?? "";
    return canonicalizeAgentBrowserNamespace(envValue);
}
/** Mirror upstream's optional restore value and full-argv last-wins parsing. */
export function extractRequestedRestoreKey(args, sessionName, envValue) {
    let restoreKey = envValue || null;
    let seenCommand = false;
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token.startsWith("--restore=")) {
            restoreKey = token.slice("--restore=".length) || sessionName;
            continue;
        }
        if (token === "--restore") {
            if (!seenCommand && optionalGlobalValueFlagConsumesNext(token, args[index + 1])) {
                restoreKey = args[index + 1];
                index += 1;
            }
            else {
                restoreKey = sessionName;
            }
            continue;
        }
        if (PREVALIDATED_VALUE_FLAGS.has(token)) {
            index += 1;
            continue;
        }
        if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token) && ["true", "false"].includes(args[index + 1] ?? "")) {
            index += 1;
            continue;
        }
        if (isKnownCommandToken(token))
            seenCommand = true;
    }
    return restoreKey;
}
export function getFlagName(token) {
    return token.split("=", 1)[0] ?? token;
}
export function isNonFlagToken(token) {
    return typeof token === "string" && !token.startsWith("-");
}
export function hasOnlyBooleanFlags(tokens, allowedFlags) {
    return tokens.every((token) => token.startsWith("-") && allowedFlags.has(getFlagName(token)));
}
export function hasOnlyOptionFlags(tokens, allowedBooleanFlags, allowedValueFlags) {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token.startsWith("-"))
            return false;
        const flagName = getFlagName(token);
        if (allowedBooleanFlags.has(flagName))
            continue;
        if (!allowedValueFlags.has(flagName))
            return false;
        if (token.includes("="))
            continue;
        const value = tokens[index + 1];
        if (!isNonFlagToken(value))
            return false;
        index += 1;
    }
    return true;
}
export function optionalGlobalValueFlagConsumesNext(flag, nextToken) {
    if (!OPTIONAL_GLOBAL_VALUE_FLAGS.has(flag) || nextToken === undefined || nextToken.startsWith("-"))
        return false;
    return !isKnownCommandToken(nextToken);
}
export function projectUpstreamGlobalFlags(args) {
    const indices = [];
    const tokens = [];
    let seenCommand = false;
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token.startsWith("--restore="))
            continue;
        if (token === "--restore") {
            if (!seenCommand && optionalGlobalValueFlagConsumesNext(token, args[index + 1]))
                index += 1;
            continue;
        }
        if (PREVALIDATED_VALUE_FLAGS.has(token)) {
            index += 1;
            continue;
        }
        if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(token)) {
            if (["true", "false"].includes(args[index + 1] ?? ""))
                index += 1;
            continue;
        }
        tokens.push(token);
        indices.push(index);
        if (isKnownCommandToken(token))
            seenCommand = true;
    }
    return { indices, tokens };
}
/** Mirror upstream clean_args: remove global flags wherever they appear before command parsing. */
export function stripUpstreamGlobalFlags(args) {
    return projectUpstreamGlobalFlags(args).tokens;
}
export function stripSessionlessShapeGlobalFlags(commandTokens) {
    const stripped = [];
    for (let index = 0; index < commandTokens.length; index += 1) {
        const token = commandTokens[index];
        const flagName = getFlagName(token);
        if (token === "--json")
            continue;
        if ((flagName === "--session" || flagName === "--namespace") && !token.includes("=")) {
            index += 1;
            continue;
        }
        if (token.startsWith("--session=") || token.startsWith("--namespace="))
            continue;
        stripped.push(token);
    }
    return stripped;
}

// local patch: origin auth-snapshots (FINAL-DESIGN.md §5 step 7). Restores always land in a dedicated
// fresh session derived from the checkpoint id, so a restore can never silently reuse or overwrite
// the caller's live browser session. The prefix lives here because this module owns session-name
// grammar and identity (canonicalizeAgentBrowserNamespace, getAgentBrowserSessionIdentityKey).
export const CHECKPOINT_SESSION_PREFIX = "piab-ckpt-";

// Limitation: session names keep only the first 32 bits (8 hex) of the 64-bit id, so two distinct snapshots can collide on one session name.
export function checkpointSessionNameForId(id) {
    return `${CHECKPOINT_SESSION_PREFIX}${typeof id === "string" ? id.slice(0, 8) : ""}`;
}

export function isCheckpointSessionName(value) {
    return typeof value === "string"
        && value.length === CHECKPOINT_SESSION_PREFIX.length + 8
        && value.startsWith(CHECKPOINT_SESSION_PREFIX)
        && /^[0-9a-f]{8}$/.test(value.slice(CHECKPOINT_SESSION_PREFIX.length));
}
