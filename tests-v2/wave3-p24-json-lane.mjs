// wave3: JSON-lane parseability for the P24 diagnostics-buffer dedup note (PATCHES.md P24 + wave3-H envelope).
// The dedup annotation previously string-appended onto content[0].text unconditionally, breaking
// JSON.parse for caller-requested --json console/errors/network reads. Fix: in the JSON lane with a
// parseable payload, the note composes into the wave3-H envelope contract ({result, appended});
// unparseable payloads keep the historical prose append. Details (diagnosticsBuffer) are unaffected.
// Related: FINAL-DESIGN.md §4 item 4; tests-v2/wave3-h-json-envelope.mjs (envelope contract); tests-v2/wave1-b-settle-retry.mjs.

import assert from "node:assert/strict";
import { applyDiagnosticsBufferDedup } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/process-output.js";
import { resetDiagnosticsBufferState } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/process-output.js";

let checks = 0;
function step() {
    checks += 1;
}

function baseResult(contentText) {
    return {
        content: [{ type: "text", text: contentText }],
        details: { args: ["console", "--json"], resultCategory: "success" },
        isError: false,
    };
}
const data = { messages: [{ text: "hello" }] };

// --- 1. JSON lane, plain parseable payload → fresh envelope {result, appended:[note]} -------------
resetDiagnosticsBufferState();
{
    const out = applyDiagnosticsBufferDedup({ command: "console", data, result: baseResult(JSON.stringify({ messages: [1] }, null, 2)), sessionKey: "s1", jsonLane: true });
    const envelope = JSON.parse(out.content[0].text); // must parse
    step();
    assert.equal(envelope.appended.length, 1, "plain JSON payload gets a fresh envelope with the dedup note");
    step();
    // CONTRACT CHANGE (wave23, reviewer lane): the note used to end "since the previous read." with no
    // qualifier. That is only true within one loaded process — the dedup buffer is module state with
    // no restore path, so after /reload or /resume the first read re-announces every row as new. The
    // note now names the limit rather than implying a baseline the wrapper does not have. The rest of
    // this lane (envelope shape, payload preservation, structured details) is unchanged and still
    // asserted below, so a future change to the envelope still fails here.
    assert.match(envelope.appended[0], /1 new console row\(s\) since the previous read in this process/, "note text preserved inside appended, now qualified by the process boundary");
    assert.match(envelope.appended[0], /reload or resume starts this count over/, "the note must name the reload/resume reset rather than implying an unbounded baseline");
    step();
    assert.equal(envelope.result.messages.length, 1, "payload object preserved under result");
    step();
    assert.equal(out.details.diagnosticsBuffer.newCount, 1, "structured diagnosticsBuffer details intact");
    step();
}

// --- 2. JSON lane, existing wave3-H envelope → note appended INTO appended[] ----------------------
resetDiagnosticsBufferState();
{
    const envelopeIn = { result: { messages: [1] }, appended: ["electron launch line"] };
    const out = applyDiagnosticsBufferDedup({ command: "console", data, result: baseResult(JSON.stringify(envelopeIn, null, 2)), sessionKey: "s2", jsonLane: true });
    const envelope = JSON.parse(out.content[0].text);
    step();
    assert.equal(envelope.appended.length, 2, "note joins the existing envelope appended[]");
    step();
    assert.equal(envelope.appended[0], "electron launch line", "prior appended entries preserved");
    step();
}

// --- 3. JSON lane, unparseable payload → historical prose append (pre-wave3 behavior) -------------
resetDiagnosticsBufferState();
{
    const out = applyDiagnosticsBufferDedup({ command: "console", data, result: baseResult("not json prose"), sessionKey: "s3", jsonLane: true });
    step();
    assert.throws(() => JSON.parse(out.content[0].text), "prose fallback stays parse-breaking (historical behavior)");
    assert.match(out.content[0].text, /1 new console row\(s\) since the previous read in this process/, "note appended as prose, qualified by the same process boundary as the JSON lane above (wave23 contract change)");
    step();
}

// --- 4. Non-JSON lane → prose append, byte-identical to the historical formula --------------------
resetDiagnosticsBufferState();
{
    const out = applyDiagnosticsBufferDedup({ command: "console", data, result: baseResult(JSON.stringify({ messages: [1] })), sessionKey: "s4", jsonLane: false });
    step();
    assert.throws(() => JSON.parse(out.content[0].text), "non-JSON lane keeps the prose append");
    // The shape under test is the two-newline separator and the note as the final line. Asserting the
    // exact trailing sentence here is what pinned the old unqualifiable wording, so the sentence is
    // matched in full including its new qualifier, and the separation/placement is still asserted.
    assert.match(out.content[0].text, /^[\s\S]*\n\n1 new console row\(s\) since the previous read in this process \(a Pi reload or resume starts this count over\)\.\s*$/, "prose append formula: separator and placement unchanged, wording qualified (wave23 contract change)");
    step();
}

// --- 5. Non-text content → prose prepend fallback -------------------------------------------------
resetDiagnosticsBufferState();
{
    const result = { content: [{ type: "image", data: "x" }], details: { a: 1 }, isError: false };
    const out = applyDiagnosticsBufferDedup({ command: "console", data, result, sessionKey: "s5", jsonLane: true });
    step();
    assert.equal(out.content[0].type, "text", "note prepended as a text item when content[0] is not text");
    assert.match(out.content[0].text, /1 new console row/);
    step();
}

console.log(`OK: ${checks} P24 JSON-lane checks passed (jsonLane + parseable payload → envelope {result, appended}; existing envelope → note joins appended[]; unparseable → historical prose fallback; non-JSON lane byte-identical prose; non-text content prepend intact).`);
