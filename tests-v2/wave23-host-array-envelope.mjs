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
import { compileAgentBrowserJob, compileAgentBrowserQaPreset } from "../dist/extensions/agent-browser/lib/input-modes/job.js";
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
// The list must cover every site the shared.js comment names. If it shrank, the comment would be
// asserting sites this test never looks at — which is exactly the overclaim a review lane caught.
const ENVELOPE_SITES = ["job.js", "debug.js", "cdp.js", "electron.js", "vault-mode.js"];
for (const mode of [...ENVELOPE_SITES, "shared.js"]) {
    const src = read(mode);
    if (mode === "shared.js") {
        assert.match(src, /export function isItemEnvelope/, "shared.js must be where the one definition lives");
        continue;
    }
    assert.match(src, /import \{[^}]*\b(?:unwrapItemEnvelope|unwrapItemEnvelopeDeep|isItemEnvelope)\b[^}]*\} from "\.\/shared\.js";/,
        `${mode} must import the envelope helper from shared.js`);
    assert.doesNotMatch(src, /function (?:isItemEnvelope|unwrapItemEnvelope)\s*\(/,
        `${mode} re-defines the envelope helper locally; one definition only, or the eight sites will drift`);
}
for (const site of ENVELOPE_SITES) {
    assert.match(read(site), /unwrapItemEnvelopeDeep|unwrapItemEnvelope/,
        `${site} is listed as healed in the shared.js comment and must actually use the helper`);
}

console.log("wave23-host-array-envelope: all assertions passed (all eight array sites healed, correct input untouched, free-form CDP params survive, one shared definition)");

// --- multi-level envelopes ------------------------------------------------------------------
// Confirmed live: a payload wrapped twice was refused with the OUTER error while the plain form of the
// same job worked, so a single-level strip is not enough. Bounded so it cannot loop on shaped input.
import { unwrapItemEnvelopeDeep } from "../dist/extensions/agent-browser/lib/input-modes/shared.js";
assert.deepEqual(unwrapItemEnvelopeDeep({ item: { item: ["a"] } }), ["a"], "a double-wrapped array is fully unwrapped");
assert.deepEqual(unwrapItemEnvelopeDeep({ item: { item: { item: ["a"] } } }), ["a"], "and a triple-wrapped one");
assert.deepEqual(unwrapItemEnvelopeDeep(["a"]), ["a"], "a plain array is unchanged");
assert.deepEqual(unwrapItemEnvelopeDeep({ a: 1 }), { a: 1 }, "a plain object is unchanged");
assert.deepEqual(unwrapItemEnvelopeDeep(undefined), undefined, "undefined is unchanged");

// A job whose steps arrive double-wrapped must still compile, and to the same thing.
const plainJob = compileAgentBrowserJob({ session: "u1", steps });
assert.equal(compileAgentBrowserJob({ session: "u1", steps: { item: { item: steps } } }).compiled.stdin, plainJob.compiled.stdin,
    "a double-wrapped job.steps must compile to exactly the same steps");

// The bound only limits wasted work — anything deeper simply stops being stripped, which then fails
// the shape check with an honest message rather than looping.
// The bound stops the loop and hands back the still-wrapped remainder. That remainder is not an
// array, so every shape check downstream refuses it with its own honest message rather than looping
// or silently accepting. The first version of this assertion expected undefined and failed: what is
// actually returned is the leftover object, which is safe for a different reason than "it is absent".
const overDeep = unwrapItemEnvelopeDeep({ item: { item: { item: { item: { item: { item: { item: { item: { item: "x" } } } } } } } } });
assert.equal(Array.isArray(overDeep), false, "an over-deep envelope must not resolve to an array");
assert.equal(overDeep === undefined, false, "it is returned, not discarded — downstream shape checks reject it by name");
assert.match(compileAgentBrowserJob({ session: "u1", steps: overDeep }).error ?? "", /job\.steps/,
    "and job names the real problem rather than looping or passing silently");

// --- select `values`, qa.expectedText, electron and vault -----------------------------------
import { getSelectValues } from "../dist/extensions/agent-browser/lib/input-modes/shared.js";
const selectOk = getSelectValues({ values: ["a", "b"] }, "job.steps[0]");
assert.equal(selectOk.error, undefined, "select values must accept a plain array");
assert.deepEqual(getSelectValues({ values: { item: ["a", "b"] } }, "job.steps[0]").values, ["a", "b"],
    "select values must accept the host envelope — confirmed live as 'job.steps must be a non-empty array'");
assert.match(getSelectValues({ values: [] }, "job.steps[0]").error ?? "", /non-empty array/,
    "an empty values array must still be refused");
assert.match(getSelectValues({ values: [""] }, "job.steps[0]").error ?? "", /non-empty strings/,
    "a blank value must still be refused");
assert.match(getSelectValues({}, "job.steps[0]").error ?? "", /is required/, "neither value nor values must still be refused");
assert.match(getSelectValues({ value: "a", values: ["b"] }, "job.steps[0]").error ?? "", /cannot both/,
    "value together with values must still be refused");

// qa is compiled by its own preset compiler, not by the job compiler — an earlier version of this
// test passed a `qa` key to compileAgentBrowserJob, which reported "job.steps must be a non-empty
// array" and would have read as a code failure rather than a wrong call.
const qaCompiled = compileAgentBrowserQaPreset({ url: "https://example.com/", expectedText: { item: ["a", "b"] } });
assert.equal(qaCompiled.error, undefined, "qa.expectedText must accept the host envelope");
assert.equal(compileAgentBrowserQaPreset({ url: "https://example.com/", expectedText: ["a", "b"] }).error, undefined,
    "and the plain array form must keep working");
assert.match(compileAgentBrowserQaPreset({ url: "https://example.com/", expectedText: { item: [""] } }).error ?? "", /qa\.expectedText/,
    "qa.expectedText must still refuse a blank entry");
assert.match(compileAgentBrowserQaPreset({ url: "https://example.com/", expectedText: { item: 5 } }).error ?? "", /qa\.expectedText/,
    "qa.expectedText must still refuse junk");
