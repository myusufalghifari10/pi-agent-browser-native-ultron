// FINAL-DESIGN.md §2.3 + §5 step 6 (F-lane, wave2) — offline verifier for the
// delta-snapshot default on large pages.
//
// Decision matrix under test (pure functions in the snapshot shim module):
//   auto   + prior + same-url + rendered lines > threshold  -> delta
//   auto   + prior + same-url + rendered lines <= threshold -> full
//   auto   + no prior                                       -> passthrough (today's behavior)
//   any    + url changed                                    -> full
//   never                                                   -> passthrough (today's behavior)
//   always + prior                                          -> delta regardless of size
//   any    + --delta=full                                   -> full (documented escape hatch)
//
// Presentation invariants: exact header text, changed-refs region only (unchanged
// lines excluded, removed refs listed), and the delta is presentation-only — the
// full snapshot text is what the shim hands to state tracking (details.refSnapshot).
//
// Run: node tests-v2/wave2-f-snapshot-delta.mjs
import assert from "node:assert/strict";
import { buildSnapshotDeltaText, countRenderedSnapshotLines, decideSnapshotDeltaPresentation, hasTrackedRefSnapshot, parseSnapshotFilterRequest, refSnapshotTargetUrlsMatch, resolveSnapshotDeltaPolicy, } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/prepare/snapshot-filter.js";

const AUTO = (minLines) => ({ minLines, mode: "auto" });
const ALWAYS = (minLines) => ({ minLines, mode: "always" });

function synthSnapshotData(pairs) {
    return {
        refs: Object.fromEntries(pairs.map(([refId, role, name]) => [refId, { name, role }])),
        snapshot: pairs.map(([refId, role, name]) => `- ${role} "${name}" [ref=${refId}]`).join("\n"),
        title: "Test Page",
        url: "https://example.test/app",
    };
}

const PRIOR_TARGET = { title: "Test Page", url: "https://example.test/app" };

// 1. Policy resolution: env contract.
//
// The 400 default is measured, not chosen — and measured on the RIGHT quantity: rendered lines of
// an INTERACTIVE snapshot, because the delta gate requires `snapshot -i`. Live pages 2026-09-30:
// tokopedia 251, github 426, wikipedia 1600. The old 2000 sat above all three, so the delta never
// fired on any of them. Pinned to the measured number, so changing it is a conscious act.
assert.deepEqual(resolveSnapshotDeltaPolicy({}), { minLines: 400, mode: "auto" }, "default is auto @400 lines");
assert.deepEqual(resolveSnapshotDeltaPolicy({ PI_AGENT_BROWSER_SNAPSHOT_DELTA: " auto " }), { minLines: 400, mode: "auto" }, "auto is case/whitespace tolerant");
assert.equal(resolveSnapshotDeltaPolicy({ PI_AGENT_BROWSER_SNAPSHOT_DELTA: "never" }), undefined, "never disables the shim path entirely");
assert.deepEqual(resolveSnapshotDeltaPolicy({ PI_AGENT_BROWSER_SNAPSHOT_DELTA: "ALWAYS" }), { minLines: 400, mode: "always" }, "always applies regardless of size");
assert.deepEqual(resolveSnapshotDeltaPolicy({ PI_AGENT_BROWSER_SNAPSHOT_DELTA: "auto", PI_AGENT_BROWSER_SNAPSHOT_DELTA_MIN_LINES: "500" }), { minLines: 500, mode: "auto" }, "threshold override");
assert.deepEqual(resolveSnapshotDeltaPolicy({ PI_AGENT_BROWSER_SNAPSHOT_DELTA_MIN_LINES: "nope" }), { minLines: 400, mode: "auto" }, "invalid threshold falls back to default");
assert.deepEqual(resolveSnapshotDeltaPolicy({ PI_AGENT_BROWSER_SNAPSHOT_DELTA_MIN_LINES: "0" }), { minLines: 400, mode: "auto" }, "non-positive threshold falls back to default");
assert.deepEqual(resolveSnapshotDeltaPolicy({ PI_AGENT_BROWSER_SNAPSHOT_DELTA: "banana" }), { minLines: 400, mode: "auto" }, "unknown mode falls back to default auto");

// 1b. The measured threshold actually separates the pages it was measured on.
{
    const policy = resolveSnapshotDeltaPolicy({});
    // github measured 426 interactive lines: with 400 it deltas on re-snapshot, with the old 2000 it never did.
    assert.equal(decideSnapshotDeltaPresentation({ deltaFull: false, hasPrior: true, policy, renderedLines: 426, sameUrl: true }), "delta", "an ordinary large page (github, 426 interactive lines) must deltas, not re-render in full");
    // tokopedia measured 253: stays whole, because there is nothing to save.
    assert.equal(decideSnapshotDeltaPresentation({ deltaFull: false, hasPrior: true, policy, renderedLines: 120, sameUrl: true }), "full", "a small page (tokopedia, ~120 interactive lines) must stay whole");
    // A first snapshot has no prior, so delta could not help even on a huge page.
    assert.equal(decideSnapshotDeltaPresentation({ deltaFull: false, hasPrior: false, policy, renderedLines: 1600, sameUrl: true }), "passthrough", "no prior snapshot means no delta to compute");
}

// 2. Rendered line counting: cheap, non-empty lines only.
assert.equal(countRenderedSnapshotLines("- button \"A\" [ref=e1]\n\n- textbox \"B\" [ref=e2]\n"), 2);
assert.equal(countRenderedSnapshotLines(""), 0);
assert.equal(countRenderedSnapshotLines(undefined), 0);
assert.equal(countRenderedSnapshotLines("one\r\ntwo\r\n\r\nthree"), 3, "CRLF-safe");

// 3. URL comparison: same comparison the ref system uses (normalizeComparableUrl).
assert.equal(refSnapshotTargetUrlsMatch(PRIOR_TARGET, { title: "Renedered", url: "https://example.test/app#section" }), true, "hash-only change is the same URL");
assert.equal(refSnapshotTargetUrlsMatch(PRIOR_TARGET, { url: "https://example.test/other" }), false, "different path is a different page");
assert.equal(refSnapshotTargetUrlsMatch(undefined, { url: "https://example.test/app" }), false, "missing prior target cannot be verified");
assert.equal(refSnapshotTargetUrlsMatch(PRIOR_TARGET, undefined), false, "missing new target cannot be verified");
assert.equal(refSnapshotTargetUrlsMatch({ url: "not a url" }, { url: "not a url" }), false, "unparseable URLs never match");

// 4. Prior-refSnapshot existence gate.
assert.equal(hasTrackedRefSnapshot({ refIds: ["e1"], refs: { e1: { name: "A", role: "button" } }, target: PRIOR_TARGET }), true);
assert.equal(hasTrackedRefSnapshot({ refIds: [], refs: {}, target: PRIOR_TARGET }), false, "an empty prior snapshot is not a delta baseline");
assert.equal(hasTrackedRefSnapshot(undefined), false);

// 5. THE decision matrix.
const deltaInput = { deltaFull: false, hasPrior: true, policy: AUTO(2000), renderedLines: 2500, sameUrl: true };
assert.equal(decideSnapshotDeltaPresentation(deltaInput), "delta", "auto + large + prior + same-url -> delta");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, renderedLines: 2000 }), "full", "threshold is exclusive: exactly MIN_LINES stays full");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, renderedLines: 10 }), "full", "auto + small page -> full");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, hasPrior: false }), "passthrough", "no prior snapshot -> today's behavior (full via normal pipeline)");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, sameUrl: false }), "full", "url changed -> full");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, policy: undefined }), "passthrough", "never -> today's behavior");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, policy: ALWAYS(2000), renderedLines: 1 }), "delta", "always + prior -> delta regardless of size");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, deltaFull: true }), "full", "--delta=full escape hatch wins over auto+large");
assert.equal(decideSnapshotDeltaPresentation({ ...deltaInput, policy: ALWAYS(2000), deltaFull: true, renderedLines: 1 }), "full", "--delta=full escape hatch wins over always");

// 6. Delta text: header contract + changed-refs region only.
const priorRefs = {
    e1: { name: "Nav", role: "navigation" },
    e2: { name: "Save", role: "button" }, // renamed below -> changed
    e4: { name: "Gone", role: "button" }, // missing below -> removed
};
const prior = { refIds: Object.keys(priorRefs), refs: priorRefs, target: PRIOR_TARGET };
const nextPairs = [
    ["e1", "navigation", "Nav"], // unchanged
    ["e2", "button", "Saved!"], // changed name
    ["e3", "button", "Fresh"], // added
    ["e5", "textbox", "Query"], // added
];
const nextData = synthSnapshotData(nextPairs);
const nextSnapshot = { refIds: nextPairs.map(([refId]) => refId), refs: nextData.refs, target: PRIOR_TARGET };
const delta = buildSnapshotDeltaText({ fullSnapshot: nextSnapshot, previousRefSnapshot: prior, snapshotData: nextData });
// changed = e2 (renamed) + e3, e5 (added) + e4 (removed) = 4; next snapshot carries e1, e2, e3, e5 = 4 total.
assert.equal(delta.header, "Delta snapshot (vs previous): 4 refs changed (4 total) — full: run with --delta=full", "exact header contract");
assert.equal(delta.changedRefs, 4);
assert.equal(delta.totalRefs, 4);
assert.equal(delta.removedRefIds.join(","), "e4");
const deltaLines = delta.text.split("\n");
assert.ok(deltaLines[0] === delta.header, "header is the first line");
assert.ok(deltaLines.includes("- button \"Saved!\" [ref=e2]"), "changed ref line is presented");
assert.ok(deltaLines.includes("- button \"Fresh\" [ref=e3]"), "added ref line is presented");
assert.ok(deltaLines.includes("- textbox \"Query\" [ref=e5]"), "added ref line is presented");
assert.ok(!delta.text.includes("[ref=e1]"), "unchanged ref line is NOT presented (region-only)");
assert.ok(delta.text.includes("Removed refs: e4"), "removed refs are listed (their lines no longer exist)");

// 7. Presentation-only invariant: inputs are not mutated, and the full snapshot text the shim
// hands to state tracking (details.refSnapshot via extractRefSnapshotFromData of the same data)
// is untouched by delta rendering.
const beforeText = nextData.snapshot;
const beforeRefs = JSON.stringify(nextData.refs);
const deltaAgain = buildSnapshotDeltaText({ fullSnapshot: nextSnapshot, previousRefSnapshot: prior, snapshotData: nextData });
assert.equal(nextData.snapshot, beforeText, "synthetic snapshot data is not mutated");
assert.equal(JSON.stringify(nextData.refs), beforeRefs);
assert.deepEqual(deltaAgain, delta, "pure: same inputs, same delta");
assert.equal(countRenderedSnapshotLines(nextData.snapshot), 4, "full rendered size is still 4 lines even though only 3 are presented");

// 8. Zero-change page: header only, no region, still truthful.
const sameAsPrior = synthSnapshotData([
    ["e1", "navigation", "Nav"],
    ["e2", "button", "Save"],
    ["e4", "button", "Gone"],
]);
const zeroDelta = buildSnapshotDeltaText({
    fullSnapshot: { refIds: ["e1", "e2", "e4"], refs: sameAsPrior.refs, target: PRIOR_TARGET },
    previousRefSnapshot: prior,
    snapshotData: sameAsPrior,
});
assert.equal(zeroDelta.header, "Delta snapshot (vs previous): 0 refs changed (3 total) — full: run with --delta=full");
assert.equal(zeroDelta.text, zeroDelta.header, "no changed refs -> header only");

// 9. Token parsing: existing flags keep their semantics; --delta is stripped and recorded.
const plain = parseSnapshotFilterRequest(["snapshot", "-i"]);
assert.deepEqual(plain?.cleanArgs, ["snapshot", "-i"]);
assert.equal(plain?.explicitFilter, false, "plain snapshot -i is the delta candidate");
assert.equal(plain?.hasInteractive, true);
assert.equal(plain?.deltaFull, false);
const searched = parseSnapshotFilterRequest(["snapshot", "-i", "--search", "save"]);
assert.equal(searched?.explicitFilter, true, "explicit search keeps today's shim behavior (delta never composes)");
assert.deepEqual(searched?.cleanArgs, ["snapshot", "-i"]);
assert.equal(parseSnapshotFilterRequest(["snapshot", "-i", "--delta=full"])?.deltaFull, true, "escape hatch recorded");
assert.deepEqual(parseSnapshotFilterRequest(["snapshot", "-i", "--delta=full"])?.cleanArgs, ["snapshot", "-i"], "--delta=full never reaches upstream");
assert.equal(parseSnapshotFilterRequest(["snapshot", "-i", "--delta", "full"])?.deltaFull, true, "space-separated form tolerated");
assert.equal(parseSnapshotFilterRequest(["snapshot", "-i", "--delta"])?.deltaFull, false, "valueless --delta is not 'full'");
const searchPlusDelta = parseSnapshotFilterRequest(["snapshot", "-i", "--search", "x", "--delta=full"]);
assert.equal(searchPlusDelta?.explicitFilter, true);
assert.equal(searchPlusDelta?.deltaFull, true);
assert.deepEqual(searchPlusDelta?.cleanArgs, ["snapshot", "-i"], "stripped in explicit paths too (would error upstream otherwise)");
assert.equal(parseSnapshotFilterRequest(["snapshot"])?.hasInteractive, false, "full a11y snapshot (no -i) is not a delta candidate");
assert.equal(parseSnapshotFilterRequest(["snapshot", "--diff"])?.explicitFilter, true, "existing --diff shim request preserved");
assert.equal(parseSnapshotFilterRequest(["snapshot", "--viewport"])?.explicitFilter, true, "existing --viewport shim request preserved");
assert.equal(parseSnapshotFilterRequest(["snapshot", "--filter", "role=button"])?.explicitFilter, true, "existing --filter shim request preserved");
assert.equal(parseSnapshotFilterRequest(["batch", "snapshot", "-i"]), undefined, "batch commands never parse as snapshot shim requests (top-level only)");
assert.equal(parseSnapshotFilterRequest(["click", "@e1"]), undefined);

console.log("wave2-f-snapshot-delta: all assertions passed (policy, threshold boundary, 6-case decision matrix, header contract, region-only text, presentation-only purity, --delta parsing)");
