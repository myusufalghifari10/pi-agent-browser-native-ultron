// wave15: fail fast on an unknown upstream flag.
//
// Why this wave exists: until now a mistyped flag was not rejected at all. The spawn went
// upstream, upstream did not recognise the flag, and the call sat there until the 35s
// wrapper watchdog fired and the model was told "timeout". That is the worst possible answer:
// expensive, and it points at the wrong cause entirely, so the model retries the same typo.
//
// The vocabulary of accepted flags is the whole design. An earlier measurement found 59 flags
// that the documentation proves are real and valid (--new-tab, --bail, --stdin, --ms,
// --exact, --compact, --timeout, ...) and that were NOT in argv-grammar's sets. A guard built
// only on those sets would have rejected correct calls - strictly worse than the hang. So
// the accepted set is deliberately a superset, and the single most important test here is the
// one that walks every flag the documentation mentions and demands it is accepted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const { KNOWN_FLAG_NAMES } = await import(join(repo, "dist/extensions/agent-browser/lib/argv-grammar.js"));
const { resolveAgentBrowserInput } = await import(join(repo, "dist/extensions/agent-browser/lib/orchestration/input-plan.js"));

let failures = 0;
function group(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        failures += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}
function check(name, fn) {
    group(name, fn);
}

const KNOWN_COMMANDS = ["get", "click", "type", "wait", "snapshot", "find", "eval", "console", "network", "state", "storage", "records", "tab", "device", "trace", "profiler", "a11y", "vitals", "react", "clipboard", "stream", "webmcp", "pushstate", "geo", "dialog", "drag", "upload", "hover", "press", "keyboard", "mouse", "batch", "session", "open", "goto", "back", "forward", "reload"];

function errorFor(argv) {
    const result = resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params: { args: argv } });
    return result.validationError;
}

check("an unknown flag is rejected immediately, naming the flag", () => {
    const error = errorFor(["get", "url", "--nonsense-flag"]);
    assert.ok(error, "an unknown flag must produce an error before the spawn");
    assert.match(error, /--nonsense-flag/, "the error must name the offending flag, or the model cannot fix it");
});

check("the rejection is instant, so the 35s watchdog is never reached", () => {
    const started = Date.now();
    errorFor(["get", "url", "--nonsense-flag"]);
    assert.ok(Date.now() - started < 1000, "the guard must be pure computation, not a wait");
});

check("a near-miss typo is suggested by name", () => {
    // The typo has to be of a flag that really exists, otherwise there is nothing correct to
    // suggest and the assertion would be testing a coincidence.
    const error = errorFor(["get", "url", "--new-tabs"]);
    assert.ok(error, "a typo must be rejected");
    assert.match(error, /Did you mean --new-tab\?/, "the closest real flag must be suggested so the model can self-correct");
    const swapped = errorFor(["click", "@e2", "--headed "]);
    assert.equal(swapped, undefined, "a valid flag with a trailing space is not this guard's business");
    const distant = errorFor(["get", "url", "--zzzzzzzzzzzz"]);
    assert.ok(distant && !/Did you mean/.test(distant), "a nonsense flag far from everything must not get a nonsense suggestion");
});

check("a typo of a real command flag is still caught", () => {
    // snapshot takes no free-text positionals, so it is inside the guard's reach.
    assert.ok(errorFor(["snapshot", "--new-tabs"]), "--new-tabs must not pass as --new-tab");
    assert.equal(errorFor(["snapshot", "--new-tab"]), undefined, "the real --new-tab must pass");
});

check("the trade-off is explicit: free-text commands are NOT typo-checked", () => {
    // A selector or a text argument may legitimately start with "--", and the guard cannot tell
    // a positional from a flag position. Rather than refuse correct calls, the guard stands
    // aside for these commands - so a typo in a `type` or `click` call still reaches the
    // watchdog. This test exists to make that cost visible instead of pretending it is gone.
    assert.equal(errorFor(["click", "@e2", "--new-tabs"]), undefined, "click is deliberately not checked");
    assert.equal(errorFor(["type", "#f", "--definitely-not-a-flag"]), undefined, "type is deliberately not checked");
    assert.equal(errorFor(["mouse", "move", "100", "--typo-flag-here"]), undefined, "mouse is deliberately not checked");
});

check("REAL COMMAND AND GLOBAL FLAGS ALL PASS - the anti-false-positive tripwire", () => {
    // The guard must never be the reason a valid call fails. This walks every flag the
    // project's own documentation names and demands each one is accepted. If upstream grows a
    // flag and the docs document it, this test fails loudly instead of the guard quietly
    // refusing correct calls in production.
    const doc = readFileSync(join(repo, "docs/COMMAND_REFERENCE.md"), "utf8");
    const documented = [...new Set(doc.match(/--[a-z][a-z0-9-]*/g) ?? [])].sort();
    assert.ok(documented.length >= 100, `expected the documented flag surface to be substantial, saw ${documented.length}`);
    const rejected = documented.filter((flag) => !KNOWN_FLAG_NAMES.has(flag));
    assert.deepEqual(rejected, [], `these documented flags are not in the accepted vocabulary and would be wrongly refused:\n  ${rejected.join("\n  ")}`);

    // And they must pass through the real guard, not just the set.
    const wronglyRefused = documented.filter((flag) => {
        const error = errorFor(["get", "url", flag]);
        return typeof error === "string" && error.includes(flag) && error.includes("not a recognized");
    });
    assert.deepEqual(wronglyRefused, [], `the guard refuses documented flags:\n  ${wronglyRefused.join("\n  ")}`);
});

check("short flags are covered by the tripwire too, not just --long flags", () => {
    // This exact class of bug already happened once: the vocabulary was built from a --long
    // regex only, and `snapshot -i` - one of the most common calls in the tool - was refused.
    // The wave5 regression suite caught it, but nothing in THIS file would have. So the
    // single-dash surface the docs name is asserted here on its own terms.
    const doc = readFileSync(join(repo, "docs/COMMAND_REFERENCE.md"), "utf8");
    const documentedShort = [...new Set((doc.match(/(?:^|[^\w-])-[A-Za-z](?![\w-])/g) ?? []).map((match) => match.slice(-1)))].sort();
    assert.ok(documentedShort.length >= 8, `expected a real single-dash surface, saw ${JSON.stringify(documentedShort)}`);
    const refused = documentedShort.filter((flag) => typeof errorFor(["snapshot", flag]) === "string" && errorFor(["snapshot", flag]).includes("not a recognized"));
    assert.deepEqual(refused, [], `these short flags are refused but upstream documents them:\n  ${refused.join("\n  ")}`);
    assert.equal(errorFor(["snapshot", "-i"]), undefined, "-i must pass");
    assert.ok(errorFor(["snapshot", "-Z"]), "an unknown short flag is still refused");
});

check("every known command still spawns without a flag", () => {
    for (const command of KNOWN_COMMANDS) {
        const error = errorFor([command]);
        if (typeof error === "string" && error.includes("not a recognized")) {
            assert.fail(`bare command ${command} was refused as an unknown flag`);
        }
    }
});

check("values that merely look like flags are not touched", () => {
    // A negative number, a URL path and a free-text argument must never be read as a flag.
    assert.equal(errorFor(["mouse", "move", "-5", "-10"]), undefined, "negative coordinates are values, not flags");
    assert.equal(errorFor(["type", "--not-a-flag", "--really-not"]), undefined, "selector and text arguments are not flags");
    assert.equal(errorFor(["click", "--x"], undefined), undefined, "a selector is never a flag");
    assert.ok(errorFor(["get", "url", "--nope"]), "but a command with no free-text positionals is still checked");
});

check("only --tokens are candidates; bare dashes and negative numbers are values", () => {
    assert.equal(errorFor(["mouse", "move", "100", "-200"]), undefined, "a negative coordinate must pass");
    assert.equal(errorFor(["mouse", "move", "--", "100"]), undefined, "an explicit -- terminator must pass");
    assert.ok(errorFor(["snapshot", "--typo-flag-here"]), "but a real unknown --flag is still refused");
});

check("short boolean flags the upstream documents are accepted", () => {
    assert.equal(errorFor(["get", "url", "-q"]), undefined, "-q must pass");
    assert.equal(errorFor(["get", "url", "-v"]), undefined, "-v must pass");
    assert.ok(errorFor(["get", "url", "-z"]), "an unknown short flag must be refused");
});

check("the guard lives in the input-plan ?? chain, not bolted on elsewhere", () => {
    // An invariant of this codebase: a validation that is not in that chain does not run for
    // every mode. Asserting the chain shape is cheaper than rediscovering it after a refactor.
    const source = readFileSync(join(repo, "dist/extensions/agent-browser/lib/orchestration/input-plan.js"), "utf8");
    assert.match(source, /getUnknownFlagError\(toolArgs\)/, "the guard must be called with the resolved tool args");
    const chain = source.match(/\?\? \(compiledElectron[\s\S]*?getBatchPreflightValidationError\(toolArgs, toolStdin\)\)/);
    assert.ok(chain, "the guard chain was not found");
    assert.ok(chain[0].includes("?? getUnknownFlagError"), "the guard must be joined with ?? so a falsy result does not swallow it");
    assert.ok(!chain[0].includes("|| getUnknownFlagError"), "|| would swallow a falsy guard result");
});

check("the guard is skipped for host-only modes, like every other argv guard", () => {
    const result = resolveAgentBrowserInput({
        getBatchPreflightValidationError: () => undefined,
        params: { cdp: { commands: [{ method: "Runtime.evaluate" }] } },
    });
    assert.equal(result.kind, "cdp");
    assert.equal(result.error, undefined, "cdp must not be dragged through the argv guard chain");
});

if (failures > 0) {
    console.log(`\nwave15-unknown-flag: ${failures} group(s) FAILED`);
    process.exit(1);
}
console.log("\nwave15-unknown-flag: all assertions passed");
