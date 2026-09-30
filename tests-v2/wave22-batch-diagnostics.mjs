// wave22: two diagnostics the AWS Skill Builder exam run proved were missing.
//
// A different agent drove a real 65-question exam with this tool. wave21 made the tool usable at
// all; these are the two failures it hit next, and in both cases the tool's message pointed at the
// wrong thing.
//
// 1. `batch` stdin. A correct [[..],[..]] does not survive this host's param re-serialization:
//    the steps arrive as plain strings rather than arrays. The live shape is FLATTENING —
//    [["get","url"]] turns up as ["get","url"], the 2D level lost. Comma-joining is the other
//    observed shape. The old error said only "step 0 must be a non-empty array of string command
//    tokens": precise about the shape, silent about the cause, so the caller could not find that
//    the fix is to pass stdin as a JSON string. An agent burned many calls rediscovering it.
//
// 2. Batch step timing. Steps run back to back. A click that navigates, followed immediately by a
//    step targeting an element that only exists on the new page, reports "Element not found" — and
//    the caller naturally concludes the selector is wrong. The failing batch step is correct; the
//    missing wait is the bug, and the tool never said so.
//
// These are asserted against the real functions, not against source text.
import assert from "node:assert/strict";

import { parseBatchStdinJsonArray } from "../dist/extensions/agent-browser/lib/orchestration/batch-stdin.js";
import { getBatchFailureDetails } from "../dist/extensions/agent-browser/lib/results/presentation/batch.js";

// ---- 1. the comma-join diagnostic ------------------------------------------------------

// A correct array still parses. This must not regress into being rejected.
const okArray = parseBatchStdinJsonArray([["click", "@e3"], ["get", "url"]]);
assert.equal(okArray.error, undefined, "a well-formed array of steps must still parse");
assert.deepEqual(okArray.steps, [["click", "@e3"], ["get", "url"]]);

// The JSON-string form the host actually wants still parses.
const okString = parseBatchStdinJsonArray("[[\"click\",\"@e3\"]]");
assert.equal(okString.error, undefined, "the documented JSON-string form must still parse");
assert.deepEqual(okString.steps, [["click", "@e3"]]);

// The shape that ACTUALLY happens on this host, observed live after a restart: a correct
// [["get","url"]] arrives as ["get","url"] — the 2D level is lost. The first version of this fix
// assumed comma-joining and did not fire on the real failure; only the live test caught that.
const flattened = parseBatchStdinJsonArray(["get", "url"]);
assert.ok(flattened.error, "a flattened 2D stdin must be rejected");
assert.match(flattened.error, /2 plain strings/, "the error must report what actually arrived");
assert.match(flattened.error, /was flattened on the way in/, "a multi-token argv is confidently host flattening");
assert.match(flattened.error, /JSON STRING/, "the error must state the working form");
assert.doesNotMatch(flattened.error, /step \d+ must be a non-empty array/, "the old shape-only message must be gone for this case");

// Comma-joined is a real alternative shape and is covered by the same branch.
const joined = parseBatchStdinJsonArray(["get,url,get,title"]);
assert.ok(joined.error, "comma-joined steps must be rejected");
assert.match(joined.error, /was flattened on the way in/, "a comma is proof enough to name the host");

// Do not accuse the host without evidence. One lone bare word is a hand-built mistake far more
// likely than a flattening event — flattening [[..]] always yields at least that step's own
// tokens, so a single word means a one-token step. Claiming the host did it would send the caller
// to debug their host instead of their own call, so this case must stay hedged.
const lone = parseBatchStdinJsonArray(["click"]);
assert.ok(lone.error, "a lone bare word is still invalid and must be rejected");
assert.ok(!/was flattened on the way in/.test(String(lone.error)), "a lone bare word must NOT be confidently blamed on the host");
assert.match(String(lone.error), /non-empty array/, "the hedged case keeps the old wording, which wave11 pins");
assert.match(String(lone.error), /JSON STRING/, "even the hedged case must state the working form");

// A genuinely non-JSON string is still a JSON parse error, not a coercion claim.
assert.match(parseBatchStdinJsonArray("click,@e3").error, /could not be parsed as JSON/,
    "a bare comma-joined string is still reported as a parse failure");

// Mixed rows are a real shape error, not a coercion symptom. parseBatchStdinJsonArray only parses;
// the per-step message comes from validation further down the pipeline. What matters here is that
// this function does NOT claim host coercion, which would be a lie about a hand-built input.
const mixed = parseBatchStdinJsonArray([["click", "a"], "oops"]);
assert.equal(mixed.error, undefined, "a mixed array is not a coercion symptom, so parse must not reject it here");
assert.ok(!/COMMA-JOINED/.test(String(mixed.error)), "never blame the host for a hand-built mixed array");

// ---- 2. the missing-settle diagnostic ---------------------------------------------------

const step = (ok, commandText) => ({ details: { success: ok, commandText, index: 0 } });

// The real failure shape: click next-question-button succeeds, then the option selector is
// reported missing because the new page has not rendered yet.
const navigated = getBatchFailureDetails([
    step(true, 'click [data-testid=next-question-button]'),
    step(false, 'click [data-testid=radio-group-75e61795]'),
]);
assert.deepEqual(navigated.missingSettleHint, ["click"], "a failure right after a click must be flagged as possibly a timing failure");

// Without a preceding click it is an ordinary selector problem and must NOT be excused.
const plain = getBatchFailureDetails([
    step(true, 'get url'),
    step(false, 'click [data-testid=radio-group-75e61795]'),
]);
assert.equal(plain.missingSettleHint, undefined, "no preceding click means the selector really is wrong; do not blame timing");

// A click is not the only way to change the page — `open` navigates too.
const opened = getBatchFailureDetails([
    step(true, 'open https://example.com'),
    step(false, 'click #submit'),
]);
assert.deepEqual(opened.missingSettleHint, ["open"], "a step after `open` also needs a settle before the next one");

// The hint must NAME the command that preceded it. The first live run of this printed "That step
// follows a click" when the preceding step was `open` — a message that is wrong in the same way
// this whole wave exists to remove, so the command name is part of the contract now.
const named = getBatchFailureDetails([
    step(true, 'open https://example.com/'),
    step(true, 'click #a'),
    step(false, 'click #missing'),
]);
assert.deepEqual(named.missingSettleHint, ["open", "click"], "the hint must list the page-changing commands, not just a flag");

// Two different page-changers both get named rather than collapsed into a generic "a click".
const oneOfEach = getBatchFailureDetails([
    step(true, 'open https://example.com/'),
    step(false, 'click #missing'),
]);
assert.deepEqual(oneOfEach.missingSettleHint, ["open"], "an `open` predecessor must be reported as open, never as click");

// The very first step cannot be a timing victim: there is nothing before it.
const first = getBatchFailureDetails([step(false, 'click #submit')]);
assert.equal(first.missingSettleHint, undefined, "a first-step failure has no preceding click to blame");

// A fully successful batch has no failure details at all.
assert.equal(getBatchFailureDetails([step(true, 'click a'), step(true, 'click b')]), undefined, "a clean batch reports no failure");

console.log("wave22-batch-diagnostics: all assertions passed (flattening cause named, working forms still parse, a lone bare word keeps the wave11 wording plus a hint, missing-settle flagged only after a page-changing step)");
