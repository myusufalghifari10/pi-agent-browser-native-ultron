// wave22: `debug` emitted its assertion rows before its evidence rows, and the page-target guard then
// refused the whole call.
//
// An `eval` step marks the page target unverified for the remainder of the batch. debug pushed
// expectedText / expectedSelector / evalExpression evals at positions 3-4, then console, errors,
// network requests and snapshot after them — so every evidence row after the first eval was
// rejected with "The active page became unverified". Found live: `debug actionable` with an
// expectedSelector could not run at all, while `debug checkConsole` (no eval rows) worked, which
// is what made it look like a guard problem rather than an ordering problem.
//
// The guard is right. Evidence first, assertions last — which is also the better report order,
// since a reader sees the context a verdict was drawn from before the verdict.
//
// The assertion here is on the VALIDATOR, not on step indices. Pinning indices would pass while the
// guard still refused the call; feeding the compiled batch to the real validator reproduces the
// actual failure and the actual fix.
import assert from "node:assert/strict";

import { compileAgentBrowserDebug } from "../dist/extensions/agent-browser/lib/input-modes/debug.js";
import { getPageTargetValidationError } from "../dist/extensions/agent-browser/lib/page-target-validation.js";

const compiledOf = (input) => compileAgentBrowserDebug({ session: "u1", ...input }).compiled;
const validate = (compiled, pageUrlUnknown = false) =>
    getPageTargetValidationError({ args: compiled.args, stdin: compiled.stdin, pageUrlUnknown, currentPageUrl: "https://example.com/" });
const indexOf = (compiled, generatedFrom) => compiled.steps.findIndex((s) => s.generatedFrom === generatedFrom);
const tagOf = (compiled, step) => step.args[0];

// The reported case: expectedSelector produced a call that could not run at all.
const actionable = compiledOf({ action: "actionable", expectedSelector: "#qa-check-1" });
assert.equal(validate(actionable), undefined, "debug actionable must pass the page-target guard");
assert.equal(validate(actionable, true), undefined, "and must pass even when the page starts unverified");

// No evidence row may follow an assertion row, for any combination of inputs.
const combos = [
    { action: "actionable", expectedSelector: "#a" },
    { action: "actionable", url: "https://example.com/", expectedText: ["hello"] },
    { action: "actionable", expectedText: ["a", "b"], includeSnapshot: true },
    { action: "actionable", expectedSelector: "#a", includeSnapshot: true },
    { action: "actionable", eval: "1 + 1" },
    { action: "actionable", expectedSelector: "#a", eval: "document.title" },
];
const EVIDENCE = new Set(["debug.console", "debug.errors", "debug.network", "debug.snapshot", "debug.screenshot", "debug.pageContext"]);
const ASSERTIONS = new Set(["debug.expectedText", "debug.expectedSelector", "debug.evalExpression"]);
for (const combo of combos) {
    const c = compiledOf(combo);
    assert.equal(validate(c), undefined, `guard must pass for ${JSON.stringify(combo)}`);
    let lastEvidence = -1;
    let firstAssertion = Number.MAX_SAFE_INTEGER;
    c.steps.forEach((s, i) => {
        if (EVIDENCE.has(s.generatedFrom)) lastEvidence = Math.max(lastEvidence, i);
        if (ASSERTIONS.has(s.generatedFrom)) firstAssertion = Math.min(firstAssertion, i);
    });
    assert.ok(lastEvidence < firstAssertion,
        `evidence must precede assertions in ${JSON.stringify(combo)} — last evidence at ${lastEvidence}, first assertion at ${firstAssertion}`);
}

// The evals must still be present and last: a reorder that DROPS them would pass a count check.
const withSelector = compiledOf({ action: "actionable", expectedSelector: "#a", includeSnapshot: true });
assert.equal(indexOf(withSelector, "debug.expectedSelector"), withSelector.steps.length - 1,
    "the assertion row must still be emitted, and it must be the final step");
assert.ok(withSelector.steps.some((s) => tagOf(withSelector, s) === "snapshot"),
    "the evidence rows must still be present");
assert.ok(withSelector.steps.some((s) => tagOf(withSelector, s) === "console"),
    "the evidence rows must still be present");

// Multiple assertions: one eval marks the page unverified, so a second one in the same batch is
// refused. `expectedText: ["a","b"]` could not run at all until a get url re-verified between them.
// The report consumes eval rows in plan order, so the reverify rows must NOT be eval rows or every
// later verdict would land on the wrong check.
const multi = compiledOf({ action: "actionable", expectedText: ["a", "b"], expectedSelector: "#c", eval: "1+1" });
assert.equal(validate(multi), undefined, "three assertions in one call must pass the guard");
const evalIdx = multi.steps.map((s) => s.generatedFrom).filter((g) => g !== "debug.reverify").indexOf("debug.expectedSelector");
const revertsBefore = multi.steps.slice(0, multi.steps.findIndex((s) => s.generatedFrom === "debug.expectedSelector"))
    .filter((s) => s.generatedFrom === "debug.reverify").length;
assert.equal(revertsBefore, 2, "each assertion after the first must be preceded by a reverify row");
assert.equal(multi.steps.filter((s) => s.generatedFrom === "debug.reverify").length, 2,
    "exactly one reverify per additional assertion, never more");
assert.equal(multi.steps.filter((s) => s.args[0] === "eval").length, 3,
    "all three assertions must still be emitted as their own eval rows");

// A checkConsole-only report has no assertions and must be unchanged in shape.
const consoleOnly = compiledOf({ action: "checkConsole" });
assert.equal(validate(consoleOnly), undefined, "checkConsole must pass the guard");
assert.equal(consoleOnly.steps.length, 5, "checkConsole still emits its 5 steps");

console.log("wave22-debug-step-order: all assertions passed (guard accepts the real compiled batch, evidence precedes assertions, no step dropped)");
