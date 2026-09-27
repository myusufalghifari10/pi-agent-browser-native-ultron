// FINAL-DESIGN.md §1 pillar A reshape item 1 / §2 aksi (F1): auto-settle-retry ladder ①.
// Wrapper-side, no-LLM: ONE automatic retry of the identical command for failure classes that
// provably dispatched nothing, so a page that was still settling gets one bounded chance before
// the model is asked to replan. This module is a pure decision policy; the pipeline
// (process-output.js) owns timing, re-execution and the single-retry cap.
// Retryable classes — and why nothing can have been dispatched:
// - "stale-ref": the ref failed resolution before any action ran (wrapper stale-ref preflight and
//   upstream ref lookup both refuse pre-dispatch).
// - "selector-not-found": upstream resolved no element for the locator, so no action ran.
export const SETTLE_RETRY_DELAY_MS = 300;
// A minimal re-run is assumed to need at least this much wall clock. When the remaining time
// budget cannot fit the delay plus this floor, the ladder is skipped entirely (fail closed).
export const SETTLE_RETRY_MIN_RUN_MS = 1_000;
const SETTLE_RETRYABLE_FAILURE_CATEGORIES = new Set(["stale-ref", "selector-not-found"]);
export function shouldRetrySettle({ failureCategory, commandInfo } = {}) {
    // Script mode owns its own step loop; the wrapper never auto-retries underneath it.
    if (commandInfo?.command === "script")
        return false;
    // Review round 1 (batch double-dispatch): a batch's run-level failureCategory is the failed
    // STEP's category, so it does not prove the earlier batch steps dispatched nothing — retrying
    // the batch wholesale would re-execute them. The pipeline gate additionally refuses any
    // presentation carrying batchFailure, covering every batch shape.
    if (commandInfo?.command === "batch")
        return false;
    return SETTLE_RETRYABLE_FAILURE_CATEGORIES.has(failureCategory);
}
export function hasSettleRetryTimeBudget({ startedAtMs, timeoutMs, delayMs = SETTLE_RETRY_DELAY_MS, minRunMs = SETTLE_RETRY_MIN_RUN_MS, nowMs = Date.now(), } = {}) {
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return false;
    const elapsedMs = Math.max(0, nowMs - startedAtMs);
    return timeoutMs - elapsedMs >= delayMs + minRunMs;
}
// Review round 1 (budget floor-not-cap): the retried run must fit inside the ORIGINAL command's
// time budget — remaining wall clock minus the settle delay — instead of receiving the full
// prepared timeout again. Floored at SETTLE_RETRY_MIN_RUN_MS so the clamp cannot starve the retry
// into a guaranteed timeout; the gate only calls this after hasSettleRetryTimeBudget passed, where
// remainingMs - delayMs >= minRunMs already holds and the floor is a defensive no-op.
export function computeRetryTimeoutMs({ timeoutMs, elapsedMs, delayMs = SETTLE_RETRY_DELAY_MS, minRunMs = SETTLE_RETRY_MIN_RUN_MS, } = {}) {
    return Math.max(minRunMs, timeoutMs - elapsedMs - delayMs);
}
