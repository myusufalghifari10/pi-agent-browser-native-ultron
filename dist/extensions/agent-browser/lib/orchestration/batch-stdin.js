import { projectUpstreamGlobalFlags } from "../argv-grammar.js";
/** Bare open's native launch action drops prior launch options. URL reads lazily launch without navigating. */
export function normalizeUrlLessOpen(args, stdin, batchStep = false) {
    const { tokens, indices } = batchStep ? { tokens: args, indices: args.map((_, index) => index) } : projectUpstreamGlobalFlags(args);
    if (tokens[0] === "open" && !tokens.slice(1).some(token => !token.startsWith("--"))) {
        const index = indices[0];
        return { args: [...args.slice(0, index), "get", "url", ...args.slice(index + 1)], stdin };
    }
    if (tokens[0] !== "batch")
        return { args, stdin };
    const rawSteps = tokens.slice(1).flatMap((token, offset) => {
        const step = token === "--bail" ? undefined : parseBatchCommandArgument(token).step;
        return step ? [{ index: indices[offset + 1], step }] : [];
    });
    if (tokens.slice(1).some(token => token !== "--bail")) {
        let normalized = args;
        for (const { index, step } of rawSteps) {
            const row = normalizeUrlLessOpen(step, undefined, true).args;
            if (row === step)
                continue;
            if (normalized === args)
                normalized = [...args];
            normalized[index] = row.map(token => `'${token.replaceAll("'", "'\\''")}'`).join(" ");
        }
        return { args: normalized, stdin };
    }
    const steps = parseUserBatchStdin(stdin).steps;
    if (!steps?.length)
        return { args, stdin };
    const normalized = steps.map(step => normalizeUrlLessOpen(step, undefined, true).args);
    return { args, stdin: normalized.some((step, index) => step !== steps[index]) ? JSON.stringify(normalized) : stdin };
}
const BATCH_STDIN_EXAMPLE = ' Example: { "args": ["batch"], "stdin": "[[\\"get\\",\\"title\\"],[\\"get\\",\\"url\\"]]" }';
// Mirror upstream commands::shell_words_split so policy inspection sees the same argv.
export function parseBatchCommandArgument(command) {
    const tokens = [];
    let token = "";
    let inDoubleQuote = false;
    let inSingleQuote = false;
    for (let index = 0; index < command.length; index += 1) {
        const character = command[index];
        if (character === "\\" && !inSingleQuote) {
            const next = command[index + 1];
            if (next !== undefined) {
                token += next;
                index += 1;
            }
        }
        else if (character === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
        }
        else if (character === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
        }
        else if (character === " " && !inDoubleQuote && !inSingleQuote) {
            if (token !== "") {
                tokens.push(token);
                token = "";
            }
        }
        else {
            token += character;
        }
    }
    if (token !== "")
        tokens.push(token);
    return tokens.length > 0 ? { step: tokens } : { error: "batch command is empty" };
}
function validateUserBatchStep(step, index) {
    if (!Array.isArray(step)) {
        return {
            error: `agent_browser batch stdin step ${index} must be a non-empty array of string command tokens.${BATCH_STDIN_EXAMPLE}`,
            ok: false,
        };
    }
    if (step.length === 0) {
        return {
            error: `agent_browser batch stdin step ${index} must not be empty.${BATCH_STDIN_EXAMPLE}`,
            ok: false,
        };
    }
    // Every token must be a string. The wave-7 numeric-token coercion was DELETED here: the Pi host
    // validates the `stdin` tool param as an array-of-string-arrays before this function ever runs
    // ("invalid type: integer 489, expected a string"), so a numeric token cannot reach it on this host.
    // The error still names the offending type so a genuine shape mistake stays diagnosable.
    const invalidTokenIndex = step.findIndex((token) => typeof token !== "string");
    if (invalidTokenIndex !== -1) {
        return {
            error: `agent_browser batch stdin step ${index} token ${invalidTokenIndex} must be a string${step[invalidTokenIndex] === null || typeof step[invalidTokenIndex] === "object" || typeof step[invalidTokenIndex] === "boolean" ? " (got " + (step[invalidTokenIndex] === null ? "null" : Array.isArray(step[invalidTokenIndex]) ? "an array" : typeof step[invalidTokenIndex]) + ")" : ""}.${BATCH_STDIN_EXAMPLE}`,
            ok: false,
        };
    }
    return { ok: true, step };
}
export function parseBatchStdinJsonArray(stdin) {
    if (stdin === undefined) {
        return { steps: [] };
    }
    let parsed;
    try {
        // wave4 (live-sweep W-A1): P28 prepareArguments de-stringifies a JSON-string stdin into a
        // real array before this point, so a plain JSON.parse here coerced that array back to a
        // comma-joined string ("click,x,get,url") and failed with a baffling parse error. Accept
        // both the documented JSON-string form and the already-parsed array form.
        parsed = typeof stdin === "string" ? JSON.parse(stdin) : stdin;
        if (!Array.isArray(parsed)) {
            return { error: `agent_browser batch stdin must be a JSON array of command steps.${BATCH_STDIN_EXAMPLE}` };
        }
        return { steps: parsed };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: `agent_browser batch stdin could not be parsed as JSON: ${message}.${BATCH_STDIN_EXAMPLE}` };
    }
}
export function parseUserBatchStdin(stdin) {
    const parsed = parseBatchStdinJsonArray(stdin);
    if (parsed.error || parsed.steps === undefined) {
        return parsed.error ? { error: parsed.error } : { steps: [] };
    }
    const steps = [];
    for (const [index, rawStep] of parsed.steps.entries()) {
        const validated = validateUserBatchStep(rawStep, index);
        if (!validated.ok) {
            return { error: validated.error };
        }
        steps.push(validated.step);
    }
    return { steps };
}
/**
 * The batch steps upstream will actually execute: run_batch uses raw batch
 * arguments exclusively when any exist and reads stdin only otherwise.
 * Upstream filters only the exact `--bail` token, so an equals form such as
 * `--bail=true` stays a raw command (an unknown-command row) and keeps stdin
 * ignored.
 */
export function getUpstreamEffectiveBatchSteps(commandTokens, stdin) {
    if (commandTokens[0] !== "batch")
        return [];
    const argumentSteps = commandTokens.slice(1).flatMap((command) => {
        if (command === "--bail")
            return [];
        const step = parseBatchCommandArgument(command).step;
        return step ? [step] : [];
    });
    if (argumentSteps.length > 0)
        return argumentSteps;
    return parseUserBatchStdin(stdin).steps ?? [];
}
export function parseValidBatchStepEntries(stdin) {
    const parsed = parseBatchStdinJsonArray(stdin);
    if (parsed.error || parsed.steps === undefined)
        return [];
    return parsed.steps.flatMap((step, index) => {
        const validated = validateUserBatchStep(step, index);
        return validated.ok ? [{ index, step: validated.step }] : [];
    });
}
