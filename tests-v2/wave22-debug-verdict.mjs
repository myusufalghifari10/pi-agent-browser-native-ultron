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

// --- the shape that actually reached the analyzer ------------------------------------------
// The analyzer is handed PRESENTATION rows, and a successful step's `details` carries no `result`
// key at all. Proved live: the eval row rendered `true` for a page that contains the text, and the
// report said "expected text not found". So the reader must find the verdict where the pipeline
// actually leaves it, or every assertion reports as failing.
const presentationRow = (last) => ({ command: ["eval", "predicate"], success: true, summary: `() => { ... }\n(succeeded)${last === undefined ? "" : `\n${last}`}` });
const page = [{ command: ["get", "url"], success: true, summary: "https://example.com/" }];

const passReport = analyzeDebugPresetResults([...page, presentationRow("true")], compiled.checks ?? compiled).report;
assert.equal(passReport.expectedTextMissing, false, "a PRESENTATION row reporting true must not be called missing");
assert.doesNotMatch(String(passReport.summary), /not found/,
    "the live shape that produced a false 'not found' must now read as a pass");

const failReport = analyzeDebugPresetResults([...page, presentationRow("false")], compiled.checks ?? compiled).report;
assert.equal(failReport.expectedTextMissing, true, "a PRESENTATION row reporting false must be called missing");

// An unreadable verdict is neither a pass nor a failure, and must never be summarised as clean.
// This is the state that let the original bug hide: a verdict that was never read looked identical
// to a verdict that passed.
const unknownReport = analyzeDebugPresetResults([...page, presentationRow(undefined)], compiled.checks ?? compiled).report;
assert.equal(unknownReport.expectedTextMissing, false, "an unreadable verdict must not be reported as a failure");
assert.match(String(unknownReport.summary), /could not be read/i, "an unreadable verdict must be named in the summary");
assert.doesNotMatch(String(unknownReport.summary), /no failures detected/,
    "a report with an unreadable verdict must never claim the page is clean");
assert.equal(unknownReport.unverifiableChecks?.length, 1, "the unreadable verdict must be counted and reported");

// Both selector and text assertions use the same reader, so both must be covered.
const selectorCompiled = compileAgentBrowserDebug({ action: "actionable", expectedSelector: "#nope", session: "u1" }).compiled;
const selFail = analyzeDebugPresetResults([...page, presentationRow("false")], selectorCompiled.checks ?? selectorCompiled).report;
assert.equal(selFail.expectedSelectorMissing, true, "expectedSelector must use the same reader");
const selUnknown = analyzeDebugPresetResults([...page, presentationRow(undefined)], selectorCompiled.checks ?? selectorCompiled).report;
assert.match(String(selUnknown.summary), /could not be read/i, "an unreadable selector verdict must be named too");

console.log("wave22-debug-verdict: all assertions passed (verdicts survive on process AND presentation rows, unreadable verdicts are named instead of silently passing, call site pinned)");
