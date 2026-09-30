// wave23: the `qa` preset path still had the pre-fix defect class that `debug` was corrected for in
// wave22 — a check that never produced a verdict, or one whose verdict nobody could read, was
// reported as a clean pass. Three reviewer lanes reported these independently (silence F2, silence F3,
// validation F1, validation F3) and each was confirmed by running it before being fixed.
//
// The pattern: nothing inspects anything, or something inspects and the result is unreadable, and the
// summary says "passed". Both read identically to a real pass at the call site.
import assert from "node:assert/strict";
import { analyzeQaPresetResults, compileAgentBrowserQaPreset } from "../dist/extensions/agent-browser/lib/input-modes/job.js";

// --- an empty expectedText asserted nothing and passed ----------------------------------
for (const empty of [[], { item: [] }]) {
    const r = compileAgentBrowserQaPreset({ url: "https://example.com", expectedText: empty });
    assert.match(r.error ?? "", /qa\.expectedText/, `expectedText ${JSON.stringify(empty)} must be refused, not compiled into a check that asserts nothing`);
}
// The real array form still works, and a blank entry is still refused.
assert.equal(compileAgentBrowserQaPreset({ url: "https://example.com", expectedText: ["Dashboard"] }).error, undefined,
    "a real expectedText array must still compile");
assert.match(compileAgentBrowserQaPreset({ url: "https://example.com", expectedText: [""] }).error ?? "", /qa\.expectedText/,
    "a blank entry must still be refused");
assert.equal(compileAgentBrowserQaPreset({ url: "https://example.com" }).error, undefined, "an omitted expectedText is still fine");

// --- a preset with no batch rows reported success ---------------------------------------
const compiled = compileAgentBrowserQaPreset({ url: "https://example.com", expectedText: ["Dashboard"] }).compiled;
assert.ok(compiled, "the preset must compile for this test to mean anything");
for (const [label, data] of [["undefined", undefined], ["null", null], ["[]", []]]) {
    const r = analyzeQaPresetResults(data, compiled);
    assert.notEqual(r, undefined, `${label}: a preset with no rows must still produce a verdict, not none`);
    assert.equal(r.passed, false, `${label}: no rows must never be a pass`);
    assert.match(r.summary, /nothing was inspected/, `${label}: must say nothing was inspected`);
    assert.doesNotMatch(r.summary, /passed\./, `${label}: must not carry a pass sentence`);
    assert.ok(r.unverifiableChecks?.length, `${label}: must name which checks never ran`);
}

// --- an unreadable wait --fn verdict was scored as a pass -------------------------------
// Reproduced through the real compiled preset so the indices line up with the real batch.
const assertIndex = compiled.steps.findIndex((s) => s.action === "assertText");
assert.ok(assertIndex >= 0, "the compiled preset must contain an assertText step for this test to bite");
const baseItems = () => compiled.steps.map(() => ({ command: "get", success: true, result: {} }));
const withVerdict = (result) => {
    const items = baseItems();
    items[assertIndex] = { command: "wait", success: true, result };
    return items;
};
const passed = analyzeQaPresetResults(withVerdict(true), compiled);
assert.equal(passed.passed, true, "a readable true verdict is a pass");
assert.match(passed.summary, /^QA preset passed/, "and says so plainly");
// Before the fix every one of these returned passed:true with "QA preset passed."
for (const [label, result] of [
    ["object with no boolean", { waited: 5000 }],
    ["bare string", "done"],
    ["nested non-boolean", { result: { ok: 1 } }],
]) {
    const r = analyzeQaPresetResults(withVerdict(result), compiled);
    assert.equal(r.passed, false, `an unreadable verdict (${label}) must not clear the page`);
    assert.match(r.summary, /could not be read/, `an unreadable verdict (${label}) must be reported as unreadable`);
    assert.ok(r.unverifiableChecks?.length, `an unreadable verdict (${label}) must be listed as unverifiable`);
}
// A readable false still fails by name, and a wrapped boolean still passes.
const failed = analyzeQaPresetResults(withVerdict(false), compiled);
assert.equal(failed.passed, false, "a readable false verdict is a failure");
assert.match(failed.summary, /expected text not found/, "and names the text that was missing");
assert.equal(analyzeQaPresetResults(withVerdict({ result: true }), compiled).passed, true, "a wrapped boolean verdict still reads as a pass");

console.log("wave23-qa-silent-pass: all assertions passed (empty expectedText refused, no-rows never passes, an unreadable verdict is never a pass)");
