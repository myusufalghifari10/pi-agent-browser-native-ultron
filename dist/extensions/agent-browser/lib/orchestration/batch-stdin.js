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
/**
 * The host's array-element envelope: an object whose ONLY key is `item`.
 *
 * wave22 LIVE, confirmed by reading what the wrapper actually received: this host wraps EVERY
 * array element recursively, so a correct
 *     [["get","url"],["get","title"]]
 * arrives as
 *     [{item:[{item:"get"},{item:"url"}]}, {item:[{item:"get"},{item:"title"}]}]
 * The outer wrapper alone was not enough — unwrapping one level then failed with "token 0 must be
 * a string (got object)", which is what exposed the inner level. Two earlier fixes were wrong
 * guesses (comma-joining, then flattening) and neither would ever have fired.
 *
 * Unwrapping is SAFE, not a guess, and the reason is structural: batch validation requires every
 * token to be a string, so no object can appear anywhere in a batch that would have validated.
 * Stripping {item: ...} is therefore a no-op on every input that already worked, and can only turn
 * a rejected input into the call the caller wrote. Validation remains the safety net either way.
 */
function isItemEnvelope(value) {
    return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && "item" in value;
}
function unwrapItemEnvelopes(value, stats) {
    if (Array.isArray(value)) {
        return value.map((entry) => unwrapItemEnvelopes(entry, stats));
    }
    if (isItemEnvelope(value)) {
        if (stats !== undefined) {
            stats.count += 1;
        }
        return unwrapItemEnvelopes(value.item, stats);
    }
    return value;
}
function validateUserBatchStep(step, index) {
    if (!Array.isArray(step)) {
        // Name what actually arrived. A caller who sent [[..],[..]] on this host gets something
        // that is neither a string nor an array, and "must be a non-empty array" does not let them
        // tell their own mistake from the host's re-serialization. Guessing here is what cost two
        // wrong fixes: the first assumed comma-joining, the second assumed flattening, and only a
        // live call with this in the message can settle which one the host really does.
        const received = step === null ? "null" : step === undefined ? "undefined" : typeof step === "object" ? `an object with keys [${Object.keys(step).slice(0, 6).join(", ")}]` : typeof step;
        return {
            error: `agent_browser batch stdin step ${index} must be a non-empty array of string command tokens, but it arrived as ${received}.${BATCH_STDIN_EXAMPLE}`,
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
    let parsedItemEnvelopes = 0;
    try {
        // wave4 (live-sweep W-A1): P28 prepareArguments de-stringifies a JSON-string stdin into a
        // real array before this point, so a plain JSON.parse here coerced that array back to a
        // comma-joined string ("click,x,get,url") and failed with a baffling parse error. Accept
        // both the documented JSON-string form and the already-parsed array form.
        parsed = typeof stdin === "string" ? JSON.parse(stdin) : stdin;
        if (!Array.isArray(parsed)) {
            return { error: `agent_browser batch stdin must be a JSON array of command steps.${BATCH_STDIN_EXAMPLE}` };
        }
        // wave22: this host re-serializes a nested array param and can deliver a batch stdin whose
        // steps are NOT arrays. Two shapes were observed live, both from a perfectly correct
        // [[..],[..]]:
        //   flattened : [[\"get\",\"url\"]]      arrives as [\"get\",\"url\"]   (2D lost to 1D)
        //   comma-joined: [[\"get\",\"url\"],[\"get\",\"title\"]] arrives as [\"get,url,get,title\"]
        // The old error only said \"step 0 must be a non-empty array of string command tokens\",
        // which describes the shape and never the cause, so a caller could not find the fix: the
        // steps must be sent as a JSON string. Both shapes are invalid — a valid step is always an
        // array — so blaming the host is only ever a guess, and the message says so.
        // Strip the host's {item: ...} envelope at every depth, then keep every existing rule.
        // See unwrapItemEnvelopes for why this is safe rather than a guess.
        const envelopeStats = { count: 0 };
        parsed = unwrapItemEnvelopes(parsed, envelopeStats);
        parsedItemEnvelopes = envelopeStats.count;

        if (parsed.length > 0 && parsed.every((row) => typeof row === "string")) {
            // More than one plain string is a flattened argv: a single step is always one array,
            // so several loose tokens can only mean the 2D shape lost a level. A lone bare word is
            // ambiguous, so that case keeps the old message — which was already correct for it —
            // and only gains the hint. Claiming host flattening there would send the caller to
            // debug their host instead of their own call, and wave11 pins that message.
            const commaJoined = parsed.some((row) => row.includes(","));
            const looksLikeArgv = parsed.length > 1;
            if (commaJoined || looksLikeArgv) {
                return {
                    error: `agent_browser batch stdin arrived as ${parsed.length} plain string${parsed.length === 1 ? "" : "s"}, but every step must be a non-empty array of command tokens. This host re-serializes a nested array parameter, so a correct [[..],[..]] was flattened on the way in. Send stdin as a JSON STRING and it survives: {"stdin": "[[\\"get\\",\\"url\\"]]"}.${BATCH_STDIN_EXAMPLE}`,
                };
            }
            return {
                error: `agent_browser batch stdin step 0 must be a non-empty array of string command tokens. If you meant [["get","url"]], send stdin as a JSON STRING: {"stdin": "[[\\"get\\",\\"url\\"]]"} — a nested array parameter is re-serialized by this host, so the array form may not survive.${BATCH_STDIN_EXAMPLE}`,
            };
        }
        return { steps: parsed, itemEnvelopesStripped: parsedItemEnvelopes };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Show the text that actually arrived. Four theories about the host's coercion have been
        // wrong already (comma-joining, flattening, outer-only envelope, recursive envelope) and
        // every one of them was a guess read off a symptom. Quoting the received value is the only
        // thing that settles it, and it has settled two of them already. Truncated, because a
        // runaway payload must not land in an error message whole.
        const received = typeof stdin === "string" ? stdin : Array.isArray(stdin) ? `array(${stdin.length}) ${JSON.stringify(stdin).slice(0, 90)}` : typeof stdin;
        return { error: `agent_browser batch stdin could not be parsed as JSON: ${message}. It arrived as ${typeof stdin} of length ${typeof stdin === "string" ? stdin.length : "n/a"}: ${String(received).slice(0, 140)}${BATCH_STDIN_EXAMPLE}` };
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
    return { steps, itemEnvelopesStripped: parsed.itemEnvelopesStripped ?? 0 };
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
