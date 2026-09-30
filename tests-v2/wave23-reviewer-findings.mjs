// wave23: findings from a reviewer fan-out. Every one of these was CONFIRMED by running it before
// being fixed, and two of the reported claims turned out to be partly wrong — recorded below because
// "the reviewer was right" and "the reviewer's numbers were right" are different claims.
//
// The class all of them share: a path that SUCCEEDS while producing nothing, a default, or a value
// the caller did not ask for, and reports it in a way that reads like a pass.
import assert from "node:assert/strict";

import { normalizeNetworkBodyInput, compileNetworkBodyRequest, NETWORK_BODY_MAX_CHARS, NETWORK_BODY_DEFAULT_MAX_CHARS } from "../dist/extensions/agent-browser/lib/input-modes/network-body.js";
import { analyzeNetworkSourceLookupResults } from "../dist/extensions/agent-browser/lib/input-modes/lookups.js";

// --- F: maxChars clamped to the ceiling with the caller never told ---------------------
// `clampedFrom` was computed, carried on the value, and read NOWHERE: all four occurrences were
// inside the normalizer. Confirmed by grep before fixing, not by reading the diff.
const clamped = normalizeNetworkBodyInput({ requestId: "r1", maxChars: 99999 }).value;
assert.equal(clamped.maxChars, NETWORK_BODY_MAX_CHARS, "an over-ceiling maxChars is capped");
assert.equal(clamped.clampedFrom, 99999, "the original value is recorded for the caller");
assert.match(compileNetworkBodyRequest(clamped).note, /99999/, "and the caller is told it was capped");
assert.match(compileNetworkBodyRequest(clamped).note, new RegExp(String(NETWORK_BODY_MAX_CHARS)),
    "with the ceiling it was capped to");

// Not clamped means nothing said — otherwise every call would cry wolf.
const untouched = normalizeNetworkBodyInput({ requestId: "r1" }).value;
assert.equal(untouched.clampedFrom, undefined, "an in-range maxChars records no clamp");
assert.doesNotMatch(compileNetworkBodyRequest(untouched).note, /ceiling/, "an in-range maxChars says nothing about a ceiling");
const atCeiling = normalizeNetworkBodyInput({ requestId: "r1", maxChars: NETWORK_BODY_MAX_CHARS }).value;
assert.equal(atCeiling.clampedFrom, undefined, "exactly at the ceiling is not a clamp");
const aboveByOne = normalizeNetworkBodyInput({ requestId: "r1", maxChars: NETWORK_BODY_MAX_CHARS + 1 }).value;
assert.equal(aboveByOne.clampedFrom, NETWORK_BODY_MAX_CHARS + 1, "one over the ceiling IS a clamp");
// The urlFilter branch states it too, not just the requestId branch.
assert.match(compileNetworkBodyRequest({ ...clamped, requestId: undefined, urlFilter: "api" }).note, /99999/,
    "the urlFilter branch must state the clamp as well");

// PARTLY WRONG in the original report, kept so it is not repeated: it claimed maxChars 40000 truncates
// at 4000. 40000 is the ceiling and 4000 is the DEFAULT used only when maxChars is absent. Verified:
//   40000 -> 40000, no clamp.   absent -> 4000.
assert.equal(normalizeNetworkBodyInput({ requestId: "r1", maxChars: 40000 }).value.maxChars, 40000,
    "40000 is the ceiling, not a value truncated to 4000");
assert.equal(untouched.maxChars, NETWORK_BODY_DEFAULT_MAX_CHARS, "4000 is the default, only for an absent maxChars");

// PARTLY WRONG too: it claimed `direction` is validated then dropped. It is preserved on the value
// and consumed downstream by extractNetworkBodies, so it reaches the caller. Not a bug; asserted here
// so the claim is settled rather than merely re-rejected.
assert.equal(normalizeNetworkBodyInput({ requestId: "r1", direction: "request" }).value.direction, "request",
    "direction is preserved for the body extractor");

// --- F: networkSourceLookup claimed a clean network when nothing was inspected --------------
const compiled = { query: { url: "https://example.com/" } };
for (const [label, data] of [["undefined", undefined], ["null", null], ["[]", []], ["{}", {}]]) {
    const r = await analyzeNetworkSourceLookupResults(data, compiled, "/home/yusuf");
    assert.equal(r.status, "no-results", `${label} must not report a clean network`);
    assert.match(r.summary, /nothing was inspected/, `${label} must say nothing was inspected`);
    assert.doesNotMatch(r.summary, /found no failed requests/, `${label} must not claim a clean result`);
}
// An upstream that actually ran is still allowed to report cleanly. `network requests` always
// returns a `requests` array, so a populated one is a real answer even when empty.
const ranClean = await analyzeNetworkSourceLookupResults({ requests: [] }, compiled, "/home/yusuf");
assert.equal(ranClean.status, "no-failed-requests", "a real empty result is still a real empty result");
assert.match(ranClean.summary, /found no failed requests/, "and still says so");

console.log("wave23-reviewer-findings: all assertions passed (clamp stated, ceiling vs default settled, direction settled, nothing-inspected never reads as clean)");
