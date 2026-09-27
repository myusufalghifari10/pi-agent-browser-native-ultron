// FINAL-DESIGN.md pillar A reshape item 2 (§5 step 4) — offline verifier for job++ verification receipts.
// Asserts: probe schema validation (4 types, required value, unknown-field rejection), the exact
// upstream argv each probe compiles to, wrapper-generated row attribution (generatedFrom "job.probe"
// + owner step index/action, mirroring compiledQaPreset's generatedFrom mechanism), receipts shape
// {index, action, probe, result} with pass/fail from the probe row's own status and "skipped" when
// --bail truncation (or a missing presentation) means the probe never ran, no-probe jobs producing
// no receipts at all, and the process-output/final-result wiring staying additive on top of the
// wave1 settle-retry hunks. Receipts are additive evidence, never a license for blind execution.
// Run: node tests-v2/wave2-e-job-receipts.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeJobReceipts, compileAgentBrowserJob, compileAgentBrowserQaPreset } from "../dist/extensions/agent-browser/lib/input-modes/job.js";

let checks = 0;

// ---------------------------------------------------------------------------
// 1. Compile: 3-step job — open+probe(url, pass-case), fill+probe(text, fail-case), snapshot (no probe).
const compiled = compileAgentBrowserJob({
    steps: [
        { action: "open", url: "https://example.com/login", probe: { type: "url", value: "https://example.com/dashboard*" } },
        { action: "fill", selector: "#user", text: "ada", probe: { type: "text", value: "Welcome back" } },
        { action: "snapshot", probe: { type: "visible", value: "#logout" } },
    ],
});
assert.equal(compiled.error, undefined, "3-step probe job compiles");
const job = compiled.compiled;
assert.deepEqual(job.args, ["batch", "--bail"], "probed job still compiles to batch --bail");
assert.equal(job.steps.length, 6, "3 user steps + 3 probe rows (probe appended right after its step)");
// Probe rows match the expected upstream argv exactly, in owner-then-probe order.
assert.deepEqual(job.steps[0].args, ["open", "https://example.com/login"], "step 1 user row untouched");
assert.deepEqual(job.steps[1].args, ["wait", "--url", "https://example.com/dashboard*", "--timeout", "5000"], "url probe argv exact");
assert.deepEqual(job.steps[2].args, ["fill", "#user", "ada"], "step 2 user row untouched");
assert.deepEqual(job.steps[3].args, ["wait", "--text", "Welcome back", "--timeout", "5000"], "text probe argv exact");
assert.deepEqual(job.steps[4].args, ["snapshot", "-i"], "step 3 user row untouched");
assert.deepEqual(job.steps[5].args, ["is", "visible", "#logout"], "visible probe argv exact");
for (const index of [1, 3, 5])
    assert.equal(job.steps[index].generatedFrom, "job.probe", `probe row ${index} is marked wrapper-generated`);
assert.equal(job.steps[0].generatedFrom, undefined, "user rows carry no probe marker");
// Owner attribution rides on the wrapper-generated row.
assert.deepEqual(job.steps[1].probe, { stepAction: "open", stepIndex: 0, type: "url", value: "https://example.com/dashboard*" });
assert.deepEqual(job.steps[3].probe, { stepAction: "fill", stepIndex: 1, type: "text", value: "Welcome back" });
assert.deepEqual(job.steps[5].probe, { stepAction: "snapshot", stepIndex: 2, type: "visible", value: "#logout" });
// stdin (what upstream actually executes) matches the compiled row order exactly.
assert.deepEqual(JSON.parse(job.stdin), job.steps.map((step) => step.args), "stdin row order equals compiled.steps order");
checks += 16;

// value-probe argv (fourth type).
const valueJob = compileAgentBrowserJob({ steps: [{ action: "open", url: "https://example.com/form", probe: { type: "value", value: "#email" } }] }).compiled;
assert.deepEqual(valueJob.steps[1].args, ["get", "value", "#email"], "value probe argv exact");
checks += 1;

// ---------------------------------------------------------------------------
// 2. Receipts: pass / fail / skipped attribution against synthetic batch results (--bail truncated
// after the failing text probe, so the snapshot probe never ran).
const rows = [
    { command: ["open", "https://example.com/login"], success: true },
    { command: ["wait", "--url", "https://example.com/dashboard*", "--timeout", "5000"], success: true },
    { command: ["fill", "#user", "ada"], success: true },
    { command: ["wait", "--text", "Welcome back", "--timeout", "5000"], success: false },
    // bail truncation: the snapshot + its probe never ran.
];
const presentation = { batchSteps: rows, resultCategory: "failure" };
const receipts = analyzeJobReceipts(job.steps, presentation.batchSteps, presentation);
assert.deepEqual(receipts, [
    { index: 0, action: "open", probe: { type: "url", value: "https://example.com/dashboard*" }, result: "pass" },
    { index: 1, action: "fill", probe: { type: "text", value: "Welcome back" }, result: "fail" },
    { index: 2, action: "snapshot", probe: { type: "visible", value: "#logout" }, result: "skipped" },
], "receipts shape, attribution, pass/fail from row status, skipped on bail truncation");
checks += 1;

// A failing USER step (not the probe) under --bail skips the later probe too.
const earlyFailJob = compileAgentBrowserJob({
    steps: [
        { action: "open", url: "https://example.com/404" },
        { action: "click", selector: "#next", probe: { type: "visible", value: "#panel" } },
    ],
}).compiled;
const earlyFailReceipts = analyzeJobReceipts(earlyFailJob.steps, [
    { command: ["open", "https://example.com/404"], success: false },
], { batchSteps: [{ command: ["open", "https://example.com/404"], success: false }] });
assert.deepEqual(earlyFailReceipts, [
    { index: 1, action: "click", probe: { type: "visible", value: "#panel" }, result: "skipped" },
], "probe after a failed earlier step is skipped under --bail");
checks += 1;

// No presentation (no per-row evidence at all) → every probe stays unverified, never "pass".
const unverifiable = analyzeJobReceipts(job.steps, presentation.batchSteps, undefined);
assert.deepEqual(unverifiable?.map((receipt) => receipt.result), ["skipped", "skipped", "skipped"], "missing presentation means no probe is claimed as verified");
checks += 1;

// Receipts are evidence, not verdicts: without --bail every row runs, so a probe after a failed
// owner step still reports what it observed.
const noBailJob = compileAgentBrowserJob({ failFast: false, steps: [
    { action: "open", url: "https://example.com/x" },
    { action: "click", selector: "#go", probe: { type: "url", value: "https://example.com/y" } },
] }).compiled;
assert.deepEqual(noBailJob.args, ["batch"], "failFast:false compiles to plain batch");
const noBailReceipts = analyzeJobReceipts(noBailJob.steps, [
    { command: ["open", "https://example.com/x"], success: true },
    { command: ["click", "#go"], success: false },
    { command: ["wait", "--url", "https://example.com/y", "--timeout", "5000"], success: true },
], { batchSteps: [] });
assert.deepEqual(noBailReceipts, [
    { index: 1, action: "click", probe: { type: "url", value: "https://example.com/y" }, result: "pass" },
], "without bail the probe reports its own observed result");
checks += 2;

// ---------------------------------------------------------------------------
// 3. No-probe jobs are 100% unchanged: no probe rows, no receipts field, no prose source.
const plainJob = compileAgentBrowserJob({
    steps: [
        { action: "open", url: "https://example.com" },
        { action: "assertText", text: "Example Domain" },
        { action: "snapshot" },
    ],
}).compiled;
assert.equal(plainJob.steps.length, 3, "no-probe job compiles to exactly its own rows");
assert.ok(plainJob.steps.every((step) => step.generatedFrom === undefined && step.probe === undefined), "no-probe job carries no probe markers");
assert.equal(analyzeJobReceipts(plainJob.steps, [
    { command: ["open", "https://example.com"], success: true },
    { command: ["wait", "--text", "Example Domain"], success: true },
    { command: ["snapshot", "-i"], success: true },
], { batchSteps: [] }), undefined, "no-probe job produces no receipts");
assert.equal(analyzeJobReceipts(undefined, [], {}), undefined, "non-array steps fail closed to undefined");
checks += 3;

// qa mode aliases into compiledJob upstream, so receipts must ignore qa's generated rows.
const qaCompiled = compileAgentBrowserQaPreset({ url: "https://example.com", expectedText: "Example Domain" }).compiled;
assert.equal(analyzeJobReceipts(qaCompiled.steps, qaCompiled.steps.map(() => ({ success: true })), { batchSteps: [] }), undefined, "qa generated rows never produce job receipts");
checks += 1;

// ---------------------------------------------------------------------------
// 4. Compiler validation (validation stays in the compiler).
const bad = (jobInput) => compileAgentBrowserJob(jobInput).error;
assert.match(bad({ steps: [{ action: "open", url: "https://example.com", probe: { type: "smell" } }] }), /probe\.type must be one of: url, text, visible, value\./, "unknown probe.type rejected");
assert.match(bad({ steps: [{ action: "open", url: "https://example.com", probe: { type: "url" } }] }), /probe\.value is required for url probes/, "url probe without value rejected");
assert.match(bad({ steps: [{ action: "snapshot", probe: { type: "text", value: "   " } }] }), /probe\.value is required for text probes/, "blank probe.value rejected");
assert.match(bad({ steps: [{ action: "snapshot", probe: { type: "visible", value: "#x", when: "later" } }] }), /probe does not support when; supported fields are type, value\./, "unknown probe field rejected per step-validation style");
assert.match(bad({ steps: [{ action: "snapshot", probe: "visible" }] }), /probe must be an object\./, "non-object probe rejected");
assert.match(bad({ steps: [{ action: "open", url: "https://example.com", probe: { type: "toString" } }] }), /probe\.type must be one of/, "prototype keys are not probe types");
checks += 6;

// ---------------------------------------------------------------------------
// 5. Pipeline wiring (source-level, wave1-b pattern): additive threading only, wave1 hunks preserved.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const jobSource = await readFile(join(packageRoot, "dist/extensions/agent-browser/lib/input-modes/job.js"), "utf8");
const processOutputSource = await readFile(join(packageRoot, "dist/extensions/agent-browser/lib/orchestration/browser-run/process-output.js"), "utf8");
const finalResultSource = await readFile(join(packageRoot, "dist/extensions/agent-browser/lib/orchestration/browser-run/final-result.js"), "utf8");

assert.ok(processOutputSource.includes("import { analyzeJobReceipts, analyzeQaPresetResults"), "process-output imports analyzeJobReceipts from job.js");
assert.ok(processOutputSource.includes("prepared.kind === \"job\" && prepared.compiledJob ? analyzeJobReceipts(prepared.compiledJob.steps, presentation?.batchSteps, presentation) : undefined"), "receipts are computed kind-gated from the compiled job + presentation rows");
assert.ok(processOutputSource.includes("inspectionText, jobReceipts, preserveAttachedBrowserSession"), "jobReceipts threads into buildFinalAgentBrowserToolResult options");
assert.ok(finalResultSource.includes("jobReceipts: options.jobReceipts,"), "details carries jobReceipts");
assert.ok(finalResultSource.includes("formatJobReceiptsText(options.jobReceipts, options.presentation?.batchSteps !== undefined)"), "receipts prose joins the rawAppendedDiagnosticText array with step-evidence flag");
assert.ok(finalResultSource.includes("(no per-step evidence available)"), "skipped prose hedges when batchSteps evidence is absent (review round 1, minor 1)");
assert.ok(finalResultSource.includes("details: redactToolDetails(details, options.exactSensitiveValues)"), "returned details pass through redactToolDetails — covers details.jobReceipts[].probe.value (review round 1, minor 2)");
assert.ok(finalResultSource.includes("shouldAppendDiagnosticBlocks(options.verbosity) && (!options.userRequestedJson || options.plainTextInspection)"), "the appended-prose verbosity gate is unchanged and still covers the receipts line");
// Wave1 preservation: settle-retry ladder and P24 window untouched by the receipts hunks.
assert.ok(processOutputSource.includes("&& presentation.batchFailure == null"), "wave1 settle-retry gate (batch double-dispatch refusal) preserved");
assert.ok(processOutputSource.includes("settleRetryOutcome: settleRetryOutcome === undefined ? undefined : settleRetryOutcome.recovered ? \"recovered\" : \"attempted-failed\""), "wave1 settleRetryOutcome threading preserved");
assert.ok(finalResultSource.includes("function formatSettleRetryText(options)"), "wave1 settle-retry prose formatter preserved");
assert.ok(processOutputSource.includes("const diagnosticsBufferBySession = new Map();"), "P24 diagnostics window state preserved");
assert.ok(finalResultSource.includes("jobReceipts: options.jobReceipts,\n        login: options.login,"), "details field sits additively in the P13-P22 transparency block");
checks += 10;

console.log(`OK: ${checks} job-receipts checks passed (probe schema + exact upstream argv + generatedFrom attribution; receipts pass/fail/skipped incl. bail truncation, no-presentation fail-closed, evidence-not-verdict no-bail case; no-probe + qa-alias isolation; wiring additive over wave1 hunks).`);
