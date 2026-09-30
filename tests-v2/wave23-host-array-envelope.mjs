// wave23: one host defect, five call sites, each previously treated as an unrelated bug.
//
// This Pi build serialises every tool parameter to a string (earendil-works/pi#4226) and its runner
// wraps a NESTED array parameter in an object whose only key is `item` (hermes-agent#104803). So any
// array a caller supplies arrives as {item: [...]}. Confirmed live for all of these:
//
//   stdin (batch)     rejected outright -> batch retired as a caller command
//   job.steps         "job.steps must be a non-empty array" for a correct payload -> healed
//   debug.expectedText  the single-string form worked, the two-string array form did not
//   cdp.commands      "args must contain at least one agent-browser command token", while the
//                     identical payload as a JSON string ran and returned a result
//
// Two properties this must hold, and both are asserted for every site:
//
//   1. Correct input is untouched. An envelope strip that changed a working call would be a new bug.
//   2. The strip is POSITIONAL. cdp.commands[].params is free-form JSON handed to the browser, where
//      a real CDP parameter can be named "item". A blanket recursive strip would corrupt it, so that
//      value is asserted byte-identical.
import assert from "node:assert/strict";

import { isItemEnvelope, unwrapItemEnvelope } from "../dist/extensions/agent-browser/lib/input-modes/shared.js";
import { compileAgentBrowserJob } from "../dist/extensions/agent-browser/lib/input-modes/job.js";
import { compileAgentBrowserDebug } from "../dist/extensions/agent-browser/lib/input-modes/debug.js";
import { normalizeCdpInput } from "../dist/extensions/agent-browser/lib/input-modes/cdp.js";

// --- the predicate itself ------------------------------------------------------------------
assert.equal(isItemEnvelope({ item: [1] }), true, "{item:[...]} is an envelope");
assert.equal(isItemEnvelope({ item: [1], other: 1 }), false, "more than one key is not an envelope");
assert.equal(isItemEnvelope([1]), false, "a real array is not an envelope");
assert.equal(isItemEnvelope(null), false, "null is not an envelope");
assert.equal(isItemEnvelope("x"), false, "a string is not an envelope");
assert.deepEqual(unwrapItemEnvelope({ item: [1, 2] }), [1, 2], "the envelope is unwrapped one level");
assert.deepEqual(unwrapItemEnvelope([1, 2]), [1, 2], "a plain array passes through unchanged");
assert.deepEqual(unwrapItemEnvelope({ a: 1 }), { a: 1 }, "a plain object passes through unchanged");

// --- site 1: job.steps ----------------------------------------------------------------------
const steps = [{ action: "snapshot" }, { action: "assertUrl", url: "x" }];
const jobPlain = compileAgentBrowserJob({ session: "u1", steps });
const jobWrapped = compileAgentBrowserJob({ session: "u1", steps: { item: steps } });
assert.equal(jobWrapped.error, undefined, "job.steps envelope must be accepted");
assert.equal(jobPlain.compiled.stdin, jobWrapped.compiled.stdin, "job envelope must not change what runs");

// --- site 2: debug.expectedText -------------------------------------------------------------
const dbgPlain = compileAgentBrowserDebug({ action: "actionable", expectedText: ["a", "b"] });
const dbgWrapped = compileAgentBrowserDebug({ action: "actionable", expectedText: { item: ["a", "b"] } });
assert.equal(dbgWrapped.error, undefined, "debug.expectedText envelope must be accepted");
assert.equal(dbgPlain.compiled.stdin, dbgWrapped.compiled.stdin, "debug envelope must not change what runs");
assert.equal(compileAgentBrowserDebug({ action: "actionable", expectedText: "single" }).error, undefined,
    "the single-string form must keep working");

// An empty list asserted nothing while looking exactly like a report whose assertions all passed.
for (const [label, value] of [["[]", []], ["{item:[]}", { item: [] }]]) {
    assert.match(compileAgentBrowserDebug({ action: "actionable", expectedText: value }).error ?? "",
        /expectedText/, `an empty expectedText ${label} must be refused, not silently assert nothing`);
}

// --- site 3: cdp.commands -------------------------------------------------------------------
const commands = [{ method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }];
assert.equal(normalizeCdpInput({ session: "u1", commands }).error, undefined, "cdp.commands array must keep working");
assert.equal(normalizeCdpInput({ session: "u1", commands: { item: commands } }).error, undefined,
    "cdp.commands envelope must be accepted");
assert.match(normalizeCdpInput({ session: "u1" }).error ?? "", /requires a commands array/,
    "a missing commands array must still be named");
assert.match(normalizeCdpInput({ session: "u1", commands: [] }).error ?? "", /at least one command/,
    "an empty commands array must still be refused");

// The one thing a recursive strip would destroy. A real CDP parameter can be named "item", and a
// params object whose ONLY key is "item" is indistinguishable from the envelope by shape alone.
// The first version of this assertion used a two-key params, which no predicate treats as an
// envelope, so a recursive strip sailed past it — the test looked like it covered the danger and did
// not. A single-key params is the case that actually distinguishes positional from recursive.
const singleKeyParam = { item: { payload: [1, 2] } };
const withItemParam = normalizeCdpInput({ session: "u1", commands: [{ method: "Runtime.evaluate", params: singleKeyParam }] });
assert.equal(withItemParam.error, undefined, "a CDP param literally named item must survive the strip");
assert.deepEqual(withItemParam.value.commands[0].params, singleKeyParam,
    "the pass-through params must be byte-identical — a single-key {item:...} inside free-form CDP JSON is data, not an envelope");
const twoKeyParam = normalizeCdpInput({ session: "u1", commands: [{ method: "Runtime.evaluate", params: { item: [1, 2], expression: "1" } }] });
assert.deepEqual(twoKeyParam.value.commands[0].params, { item: [1, 2], expression: "1" }, "multi-key params are untouched too");

// --- the strip is defined once, not five times ------------------------------------------------
import { readFileSync } from "node:fs";
const read = (f) => readFileSync(new URL(`../dist/extensions/agent-browser/lib/input-modes/${f}`, import.meta.url).pathname, "utf8");
// The first version of this check matched a literal that a re-definition written with a different
// parameter name would not contain, so a duplicated definition passed it — a test that survives
// sabotage proves nothing. It now checks the two things that actually matter: the module imports the
// helper, and it does not declare a local function of the same name.
for (const mode of ["job.js", "debug.js", "cdp.js"]) {
    const src = read(mode);
    assert.match(src, /import \{[^}]*\b(?:unwrapItemEnvelope|isItemEnvelope)\b[^}]*\} from "\.\/shared\.js";/,
        `${mode} must import the envelope helper from shared.js`);
    assert.doesNotMatch(src, /function (?:isItemEnvelope|unwrapItemEnvelope)\s*\(/,
        `${mode} re-defines the envelope helper locally; one definition only, or the five sites will drift`);
}

console.log("wave23-host-array-envelope: all assertions passed (all five array sites healed, correct input untouched, free-form CDP params survive, one shared definition)");
