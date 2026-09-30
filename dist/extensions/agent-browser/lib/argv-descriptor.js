import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, VALUE_FLAGS, optionalGlobalValueFlagConsumesNext, stripUpstreamGlobalFlags } from "./argv-grammar.js";
import { isOpenNavigationCommand } from "./command-taxonomy.js";
function isBooleanLiteral(token) {
    const normalized = token?.trim().toLowerCase();
    return normalized === "true" || normalized === "false";
}
export function findCommandStartIndex(args) {
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token.startsWith("--session=") || token.startsWith("--namespace=") || token.startsWith("--restore=")) {
            continue;
        }
        if (token.startsWith("-")) {
            const normalizedToken = token.split("=", 1)[0] ?? token;
            if (optionalGlobalValueFlagConsumesNext(normalizedToken, args[index + 1])) {
                index += 1;
            }
            else if (VALUE_FLAGS.has(normalizedToken) && !token.includes("=")) {
                index += 1;
            }
            else if (GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES.has(normalizedToken) &&
                !token.includes("=") &&
                isBooleanLiteral(args[index + 1])) {
                index += 1;
            }
            continue;
        }
        return index;
    }
    return undefined;
}
/**
 * This host delivers an ARRAY tool parameter wrapped in an envelope: `args: ["--session","s","get",
 * "url"]` reaches the tool as `{item: ["--session","s","get","url"]}`. The same wrapping is a
 * documented runner bug (hermes-agent#104803), and a string parameter arrives intact by contrast,
 * which is how the two shapes were told apart.
 *
 * A plain argv array can never legitimately be an object, so unwrapping cannot change the meaning
 * of anything that previously worked. Recursive, because the host wraps array elements at every
 * depth; a string is returned untouched.
 */
function unwrapArgvEnvelope(args) {
    if (Array.isArray(args)) {
        return args.map(unwrapArgvEnvelope);
    }
    if (args !== null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 1 && "item" in args) {
        return unwrapArgvEnvelope(args.item);
    }
    return args;
}
export function extractCommandTokens(args) {
    const unwrapped = unwrapArgvEnvelope(args);
    const commandStartIndex = findCommandStartIndex(unwrapped);
    return commandStartIndex === undefined ? [] : unwrapped.slice(commandStartIndex);
}
export function extractUpstreamCommandTokens(args) {
    return stripUpstreamGlobalFlags(extractCommandTokens(args));
}
export function parseWaitCommandTokens(commandTokens) {
    if (commandTokens[0] !== "wait")
        return {};
    const considered = commandTokens.slice(1).map((token, offset) => ({ index: offset + 1, token }));
    const timeoutIndex = considered.findIndex((entry) => entry.token === "--timeout");
    if (timeoutIndex >= 0)
        considered.splice(timeoutIndex, Math.min(2, considered.length - timeoutIndex));
    for (const flags of [["--url", "-u"], ["--load", "-l"], ["--fn", "-f"], ["--text", "-t"]]) {
        const match = considered.find((entry) => flags.includes(entry.token));
        if (match)
            return { subcommand: match.token };
    }
    const downloadIndex = considered.findIndex((entry) => entry.token === "--download" || entry.token === "-d");
    if (downloadIndex >= 0) {
        const candidate = considered[downloadIndex + 1];
        return {
            downloadPath: candidate && !candidate.token.startsWith("--") ? candidate.token : undefined,
            downloadPathIndex: candidate && !candidate.token.startsWith("--") ? candidate.index : undefined,
            subcommand: considered[downloadIndex].token,
        };
    }
    return { subcommand: considered[0]?.token };
}
function getOpenCommandTarget(commandTokens) {
    for (let index = 1; index < commandTokens.length; index += 1) {
        const token = commandTokens[index];
        if (token === "--init-script" || token === "--enable") {
            index += 1;
            continue;
        }
        if (token.startsWith("--init-script=") || token.startsWith("--enable=")) {
            continue;
        }
        if (token.startsWith("-")) {
            continue;
        }
        return token;
    }
    return undefined;
}
export function parseCommandInfoFromTokens(commandTokens) {
    const upstreamCommandTokens = stripUpstreamGlobalFlags(commandTokens);
    const command = upstreamCommandTokens[0];
    return {
        command,
        subcommand: isOpenNavigationCommand(command)
            ? getOpenCommandTarget(upstreamCommandTokens)
            : command === "wait" ? parseWaitCommandTokens(upstreamCommandTokens).subcommand : upstreamCommandTokens[1],
    };
}
export function parseCommandInfo(args) {
    return parseCommandInfoFromTokens(extractCommandTokens(args));
}
export function parseArgvDescriptor(args) {
    const commandTokens = extractCommandTokens(args);
    const upstreamCommandTokens = stripUpstreamGlobalFlags(commandTokens);
    return {
        commandInfo: parseCommandInfoFromTokens(commandTokens),
        commandTokens,
        upstreamCommandTokens,
    };
}
