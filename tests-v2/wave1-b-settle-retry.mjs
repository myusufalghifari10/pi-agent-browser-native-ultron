// FINAL-DESIGN.md pillar A reshape item 1 (F1) — offline verifier for the auto-settle-retry ladder ①.
// Asserts the full failure-category decision matrix of shouldRetrySettle (true ONLY for the two
// provably-not-dispatched classes: stale-ref + selector-not-found) plus the time-budget bounds.
// Review round 1: batch commands/presentations never retry (double-dispatch), the retried run's
// timeout is clamped to the remaining budget (floor-not-cap), and the final result carries a
// structured settleRetryOutcome detail next to recoveredBy.
// Run: node tests-v2/wave1-b-settle-retry.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRetryTimeoutMs, hasSettleRetryTimeBudget, SETTLE_RETRY_DELAY_MS, SETTLE_RETRY_MIN_RUN_MS, shouldRetrySettle, } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/settle-retry.js";

// Every failure category the wrapper emits (lib/results/categories.js classifier + wrapper demotions).
const FAILURE_CATEGORIES = [
    "aborted",
    "artifact-missing",
    "cleanup-failed",
    "confirmation-required",
    "download-not-verified",
    "missing-binary",
    "parse-failure",
    "policy-blocked",
    "qa-failure",
    "selector-not-found",
    "selector-unsupported",
    "stale-ref",
    "tab-drift",
    "tab-gone",
    "timeout",
    "upstream-error",
    "validation-error",
];
const RETRYABLE = new Set(["stale-ref", "selector-not-found"]);
let checks = 0;
for (const failureCategory of FAILURE_CATEGORIES) {
    const expected = RETRYABLE.has(failureCategory);
    assert.equal(shouldRetrySettle({ failureCategory }), expected, `failureCategory=${failureCategory} must ${expected ? "retry" : "not retry"}`);
    checks += 1;
}
// Never retry without a recognized, retryable failure category.
for (const failureCategory of [undefined, "", "unknown-category", null, 0]) {
    assert.equal(shouldRetrySettle({ failureCategory }), false, `non-category ${String(failureCategory)} must not retry`);
    checks += 1;
}
assert.equal(shouldRetrySettle({}), false);
checks += 1;
// Script mode owns its own step loop: the ladder must refuse even for retryable categories.
assert.equal(shouldRetrySettle({ failureCategory: "stale-ref", commandInfo: { command: "script" } }), false, "script mode never auto-retries");
assert.equal(shouldRetrySettle({ failureCategory: "selector-not-found", commandInfo: { command: "script", subcommand: undefined } }), false, "script mode never auto-retries (selector-not-found)");
assert.equal(shouldRetrySettle({ failureCategory: "stale-ref", commandInfo: { command: "click" } }), true);
assert.equal(shouldRetrySettle({ failureCategory: "selector-not-found", commandInfo: undefined }), true);
checks += 4;
// Review round 1 (batch double-dispatch): a batch's run-level failureCategory is the failed STEP's
// category, so the ladder must refuse to retry a batch wholesale for ANY category.
assert.equal(shouldRetrySettle({ failureCategory: "stale-ref", commandInfo: { command: "batch" } }), false, "batch never auto-retries (stale-ref of one step)");
assert.equal(shouldRetrySettle({ failureCategory: "selector-not-found", commandInfo: { command: "batch" } }), false, "batch never auto-retries (selector-not-found of one step)");
checks += 2;
// Review round 1 (budget floor-not-cap): the retried run gets remaining wall clock minus the settle
// delay — never the full prepared timeout again — floored at the minimal-run time.
assert.equal(computeRetryTimeoutMs({ timeoutMs: 5_300, elapsedMs: 1_000, delayMs: SETTLE_RETRY_DELAY_MS }), 4_000, "clamp subtracts elapsed + delay");
assert.equal(computeRetryTimeoutMs({ timeoutMs: 1_400, elapsedMs: 100, delayMs: SETTLE_RETRY_DELAY_MS }), SETTLE_RETRY_MIN_RUN_MS, "clamp lands exactly on the floor");
assert.equal(computeRetryTimeoutMs({ timeoutMs: 1_300, elapsedMs: 100, delayMs: SETTLE_RETRY_DELAY_MS }), SETTLE_RETRY_MIN_RUN_MS, "clamp floors below the minimal run instead of starving the retry");
assert.equal(computeRetryTimeoutMs({ timeoutMs: 5_300, elapsedMs: 1_000 }), 4_000, "delayMs defaults to the 300ms ladder delay");
checks += 4;
// Bounds: the 300ms delay plus one minimal run must fit in the remaining prepared timeout budget.
assert.equal(SETTLE_RETRY_DELAY_MS, 300, "ladder delay is 300ms");
assert.ok(Number.isFinite(SETTLE_RETRY_MIN_RUN_MS) && SETTLE_RETRY_MIN_RUN_MS > 0, "minimal-run floor is a positive number");
const now = 1_000_000;
const base = { delayMs: SETTLE_RETRY_DELAY_MS, minRunMs: SETTLE_RETRY_MIN_RUN_MS, nowMs: now, startedAtMs: now - 1_000 };
const exactFitTimeoutMs = 1_000 + SETTLE_RETRY_DELAY_MS + SETTLE_RETRY_MIN_RUN_MS;
assert.equal(hasSettleRetryTimeBudget({ ...base, timeoutMs: exactFitTimeoutMs }), true, "exact fit retries");
assert.equal(hasSettleRetryTimeBudget({ ...base, timeoutMs: exactFitTimeoutMs - 1 }), false, "one ms short of delay+min-run skips");
assert.equal(hasSettleRetryTimeBudget({ ...base, timeoutMs: 5_000 }), true, "comfortable budget retries");
assert.equal(hasSettleRetryTimeBudget({ ...base, timeoutMs: 1_200 }), false, "remaining under delay+min-run skips");
// Budget already exhausted (elapsed >= timeout) never retries.
assert.equal(hasSettleRetryTimeBudget({ ...base, startedAtMs: now - 5_000, timeoutMs: 5_000 }), false, "exhausted budget skips");
checks += 5;
// Whenever the budget predicate admits a retry, the clamp keeps at least one minimal run.
for (const [timeoutMs, elapsedMs] of [[5_000, 1_000], [exactFitTimeoutMs, 1_000], [2_000, 600]]) {
    assert.equal(hasSettleRetryTimeBudget({ startedAtMs: now - elapsedMs, timeoutMs, nowMs: now }), true, `budget admits retry (timeoutMs=${timeoutMs}, elapsedMs=${elapsedMs})`);
    assert.ok(computeRetryTimeoutMs({ timeoutMs, elapsedMs, delayMs: SETTLE_RETRY_DELAY_MS }) >= SETTLE_RETRY_MIN_RUN_MS, `budgeted retry keeps >= min run (timeoutMs=${timeoutMs})`);
    checks += 2;
}
// Invalid prepared timeout fields fail closed: skip the ladder rather than run unbounded.
for (const timeoutMs of [0, -1, undefined, NaN, "5000"]) {
    assert.equal(hasSettleRetryTimeBudget({ ...base, timeoutMs }), false, `invalid timeoutMs ${String(timeoutMs)} skips`);
    checks += 1;
}
// Missing run-start timestamp fails closed; a custom delay is honored against the same budget.
assert.equal(hasSettleRetryTimeBudget({ timeoutMs: 5_000 }), false, "missing startedAtMs skips");
assert.equal(hasSettleRetryTimeBudget({ ...base, timeoutMs: 2_300, delayMs: 400 }), false, "larger custom delay eats the budget (needs 1400 of 1300)");
assert.equal(hasSettleRetryTimeBudget({ ...base, timeoutMs: 2_300, delayMs: 300 }), true, "nominal custom delay fits exactly");
checks += 3;
// Pipeline-level review-round-1 guards, asserted at source level (pure-logic feasible scope):
// the gate refuses any presentation carrying batchFailure (every batch shape), the retried run
// uses the clamped timeout, and the final result threads a structured settleRetryOutcome detail.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gateSource = await readFile(join(packageRoot, "dist/extensions/agent-browser/lib/orchestration/browser-run/process-output.js"), "utf8");
assert.ok(gateSource.includes("&& presentation.batchFailure == null"), "gate refuses presentations carrying batchFailure (batch double-dispatch)");
assert.ok(gateSource.includes("computeRetryTimeoutMs({ timeoutMs: prepared.processTimeoutMs, elapsedMs: settleRetryElapsedMs, delayMs: SETTLE_RETRY_DELAY_MS })"), "retried run timeout is clamped to the remaining budget");
assert.ok(gateSource.includes("settleRetryOutcome: settleRetryOutcome === undefined ? undefined : settleRetryOutcome.recovered ? \"recovered\" : \"attempted-failed\""), "final result carries settleRetryOutcome= recovered/attempted-failed");
const finalResultSource = await readFile(join(packageRoot, "dist/extensions/agent-browser/lib/orchestration/browser-run/final-result.js"), "utf8");
assert.ok(finalResultSource.includes("settleRetryOutcome: options.settleRetryOutcome,"), "details assembly threads settleRetryOutcome like recoveredBy");
checks += 4;
console.log(`OK: ${checks} settle-retry checks passed (${FAILURE_CATEGORIES.length} failure categories — retry true only for stale-ref + selector-not-found; script + batch guards; budget bounds incl. exact-fit boundary and fail-closed inputs; retry timeout clamp; settleRetryOutcome detail threading).`);
