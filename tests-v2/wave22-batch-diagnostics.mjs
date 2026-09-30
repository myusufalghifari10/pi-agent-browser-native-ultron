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
import { extractUpstreamCommandTokens } from "../dist/extensions/agent-browser/lib/argv-descriptor.js";
import { parseUserBatchStdin } from "../dist/extensions/agent-browser/lib/orchestration/batch-stdin.js";

// ---- 1. the comma-join diagnostic ------------------------------------------------------

// A correct array still parses. This must not regress into being rejected.
const okArray = parseBatchStdinJsonArray([["click", "@e3"], ["get", "url"]]);
assert.equal(okArray.error, undefined, "a well-formed array of steps must still parse");
assert.deepEqual(okArray.steps, [["click", "@e3"], ["get", "url"]]);

// The JSON-string form the host actually wants still parses.
const okString = parseBatchStdinJsonArray("[[\"click\",\"@e3\"]]");
assert.equal(okString.error, undefined, "the documented JSON-string form must still parse");
assert.deepEqual(okString.steps, [["click", "@e3"]]);

// ---- 0. the host's {item: ...} envelope, found by reading the received shape ---------------
//
// A correct [["get","url"]] arrives on this host as [{item:["get","url"]}]. Found by two live
// calls whose message named the received keys; two earlier theories were wrong guesses.
//
// A step is always an array of tokens, so {item: ...} can never be a legitimate step. Stripping
// the envelope therefore turns a hard failure into the call the caller meant to make.
// The wrapper is RECURSIVE: a live two-row call that unwrapped only the outer level then failed
// with "token 0 must be a string (got object)", which is what exposed the inner level. This is
// the shape as it actually arrives.
const liveTwo = parseUserBatchStdin([{ item: [{ item: "get" }, { item: "url" }] }, { item: [{ item: "get" }, { item: "title" }] }]);
assert.deepEqual(liveTwo.steps, [["get", "url"], ["get", "title"]], "the live recursive envelope must be unwrapped, not rejected");
assert.equal(liveTwo.itemEnvelopesStripped, 6, "the number of envelopes stripped must be reported, not hidden");

// Outer-only, from the first live sighting.
assert.deepEqual(parseUserBatchStdin([{ item: ["get", "url"] }]).steps, [["get", "url"]], "the outer envelope must be unwrapped too");

// A partially-enveloped batch is not a reason to refuse: stripping what IS an envelope leaves
// exactly the steps the caller wrote, and the un-enveloped rows were already valid. The earlier
// "refuse on any partial" rule was wrong for the same reason the guess was wrong — it assumed the
// envelope could be anywhere it was not.
const partial = parseUserBatchStdin([{ item: ["get", "url"] }, ["get", "title"]]);
assert.deepEqual(partial.steps, [["get", "url"], ["get", "title"]], "a mixed batch must still produce the steps that were written");
assert.equal(partial.itemEnvelopesStripped, 1, "only the real envelope counts as stripped");

// A two-key object is NOT the envelope and must survive as the invalid thing it is.
const twoKeys = parseUserBatchStdin([{ item: ["get", "url"], extra: 1 }]);
assert.ok(twoKeys.error, "an object with more than the item key is not the host envelope");
assert.match(twoKeys.error, /keys \[item, extra\]/, "all received keys must be named");

// The forms that already worked must keep working, and must report ZERO envelopes stripped.
// That is the structural safety argument made executable: batch validation requires every token to
// be a string, so no object can appear in a batch that would have validated — stripping {item:...}
// is provably a no-op on every input that already worked.
assert.deepEqual(parseUserBatchStdin([["get", "url"], ["get", "title"]]).steps, [["get", "url"], ["get", "title"]], "a plain 2-D array must be untouched");
assert.equal(parseUserBatchStdin([["get", "url"]]).itemEnvelopesStripped, 0, "a plain 2-D array must report nothing stripped");
assert.deepEqual(parseUserBatchStdin('[["get","url"]]').steps, [["get", "url"]], "the JSON-string form must be untouched");
assert.equal(parseUserBatchStdin('[["get","url"]]').itemEnvelopesStripped, 0, "the JSON-string form must report nothing stripped");

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

// The received value must be quoted. This is the ONLY technique that settled any of the four
// theories, and it is what finally revealed the trailing "]" — guessing from a symptom produced
// three wrong fixes. A parse error that does not show what arrived forces a guess.
const quoted = parseUserBatchStdin('[["get","url"]]]]banana');
assert.match(String(quoted.error), /It arrived as string of length \d+/, "a parse failure must report the type and length of what arrived");
assert.match(String(quoted.error), /banana/, "a parse failure must quote the received text, not just its length");

// The COMPLETE form, one closer short. This is the shape that reaches the wrapper at all, and it
// is the opposite repair to the trim: the host only "repairs" a string that already parses, so an
// incomplete one is passed through untouched (30 characters in, 30 out, measured live).
assert.deepEqual(parseUserBatchStdin('[["get","url"],["get","title"]').steps, [["get", "url"], ["get", "title"]],
    "the live one-closer-short form must be completed, not rejected");

// Every trailing-closer shape observed live, in both directions.
assert.deepEqual(parseUserBatchStdin('[["get","url"]]]').steps, [["get", "url"]], "the live one-step double-closer form must be trimmed");
assert.deepEqual(parseUserBatchStdin('[["get","url"],["get","title"]]]').steps, [["get", "url"], ["get", "title"]],
    "the live two-step single-closer form must be trimmed");
assert.deepEqual(parseUserBatchStdin('[["get","url"],["get","title"]').steps, [["get", "url"], ["get", "title"]],
    "the complete form must stay complete");

// Genuine breakage still errors. The repairs are for one known host defect, not a licence to
// accept anything that fails to parse.
assert.ok(parseUserBatchStdin("oops").error, "text that is not JSON at all must still be refused");
assert.ok(parseUserBatchStdin('{"a":1').error, "a truncated object must not be completed into a step array");
assert.ok(parseUserBatchStdin('[["get","url"],]').error, "a syntax error in the middle must not be papered over by appending a closer");

// A genuinely non-JSON string is still a JSON parse error, not a coercion claim.
assert.match(parseBatchStdinJsonArray("click,@e3").error, /could not be parsed as JSON/,
    "a bare comma-joined string is still reported as a parse failure");

// Mixed rows are a real shape error, not a coercion symptom. parseBatchStdinJsonArray only parses;
// the per-step message comes from validation further down the pipeline. What matters here is that
// this function does NOT claim host coercion, which would be a lie about a hand-built input.
const mixed = parseBatchStdinJsonArray([["click", "a"], "oops"]);
assert.equal(mixed.error, undefined, "a mixed array is not a coercion symptom, so parse must not reject it here");
assert.ok(!/COMMA-JOINED/.test(String(mixed.error)), "never blame the host for a hand-built mixed array");

// ---- 1b. the same envelope, but on `args` -----------------------------------------------
//
// The host prints received arguments verbatim, which is how both shapes were told apart:
//     args  as an array  ->  { "item": ["--session","ultron1","get","url"] }
//     stdin as a string ->  "[[\"get\",\"url\"],[\"get\",\"title\"]]"   (intact)
// So the {item: ...} envelope is not batch-specific, and argv needs the same repair.
assert.deepEqual(extractUpstreamCommandTokens({ item: ["--session", "ultron1", "get", "url"] }), ["get", "url"],
    "the live argv envelope must be unwrapped, not treated as a command");
assert.deepEqual(extractUpstreamCommandTokens(["--session", "ultron1", "get", "url"]), ["get", "url"],
    "a plain argv array must be untouched");
assert.deepEqual(extractUpstreamCommandTokens(["batch", "--bail", "get", "url"]), ["batch", "--bail", "get", "url"],
    "a plain argv array with no session must be untouched");

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

console.log("wave22-batch-diagnostics: all assertions passed (item envelopes stripped from both stdin and argv, working forms provably untouched, a lone bare word keeps the wave11 wording, parse errors quote what arrived, missing-settle flagged only after a page-changing step)");
