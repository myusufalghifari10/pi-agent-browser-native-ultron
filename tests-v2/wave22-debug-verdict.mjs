// wave22: debug discarded every assertion verdict and reported the page as clean.
//
// process-output.js passed the whole compiled object to analyzeDebugPresetResults, which reads
// input.expectedText / expectedSelector / evalExpression directly. On the compiled object those
// live one level down under `.checks`, so getExpectedEvalRoles returned an empty list, no eval row
// was ever assigned a role, and the report came back with expectedTextChecked 0 and
// "no failures detected" for a page that does not contain the requested text.
//
// Found live, not by reading: a debug run on a real page reported a clean bill of health while the
// text it had been asked to check for was absent. That is the worst shape this defect can take —
// worse than a crash, because a caller trusts it.
//
// This test pins the SHAPE at the boundary, by running the real analyzer over the real compiled
// object and requiring the verdict to survive. Asserting on the source line would pass while the
// runtime still dropped every verdict, which is exactly what happened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { analyzeDebugPresetResults, compileAgentBrowserDebug } from "../dist/extensions/agent-browser/lib/input-modes/debug.js";

// What the caller actually gets from the compiler, at the call site.
const compiled = compileAgentBrowserDebug({ action: "actionable", expectedText: "NEVER-ON-THE-PAGE", expectedSelector: "#no-such-thing", session: "u1" }).compiled;

// Batch rows as the pipeline produces them: the assertions resolve false because the page has
// neither the text nor the selector.
const rows = [
    { command: ["get", "url"], success: true, result: { url: "https://example.com/" } },
    { command: ["get", "title"], success: true, result: { title: "Example" } },
    { command: ["console"], success: true, result: {} },
    { command: ["eval", "predicate"], success: true, result: { result: false } },
    { command: ["eval", "predicate"], success: true, result: { result: false } },
];

// The checks half is what the analyzer documents as its input.
const verdict = analyzeDebugPresetResults(rows, compiled.checks ?? compiled).report;
assert.ok(verdict.counts.expectedTextChecked >= 1,
    "the expectedText check must be counted — a dropped verdict is the whole defect");
assert.equal(verdict.expectedTextMissing, true, "a page without the requested text must be reported missing it");
assert.equal(verdict.expectedSelectorMissing, true, "a page without the selector must be reported missing it");
assert.doesNotMatch(String(verdict.summary), /no failures detected/,
    "the summary must not claim a clean page when both assertions failed");

// A PASSING assertion must still read as passing, or the fix would be "always report failure".
const pass = analyzeDebugPresetResults(
    [{ command: ["get", "url"], success: true, result: { url: "https://x/" } },
     { command: ["eval", "p"], success: true, result: { result: true } },
     { command: ["eval", "p"], success: true, result: { result: true } }],
    compiled.checks ?? compiled).report;
assert.equal(pass.expectedTextMissing, false, "a satisfied assertion must not be reported missing");
assert.equal(pass.expectedSelectorMissing, false, "a satisfied assertion must not be reported missing");

// The call site must read `.checks`. Asserted on the real expression so a refactor cannot quietly
// pass the wrong object again while every other assertion here still passes.
const src = readFileSync(new URL("../dist/extensions/agent-browser/lib/orchestration/browser-run/process-output.js", import.meta.url).pathname, "utf8");
const callSite = src.match(/analyzeDebugPresetResults\([^;]*?\)\.report/)?.[0] ?? "";
assert.match(callSite, /compiledDebug\.checks/,
    "the call site must pass compiledDebug.checks, not the whole compiled object");
assert.doesNotMatch(callSite, /,\s*prepared\.compiledDebug\)\.report/,
    "the call site must not pass the bare compiled object again");

console.log("wave22-debug-verdict: all assertions passed (verdicts survive to the report, a failing page is not reported clean, a passing one still passes, call site pinned)");
