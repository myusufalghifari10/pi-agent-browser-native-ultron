// wave7 W7-1: batch stdin accepts finite numbers, because coordinates are the most common batch payload.
//
// Live origin (When2meet, 2026-09-29): selecting a date range and a time range in a calendar grid needs a
// real CDP drag - `mouse move -> down -> move xN -> up` - and those coordinates are numbers. Writing them
// unquoted gave "agent_browser batch stdin step 0 token 2 must be a string", which reads like a broken tool
// rather than a quoting rule; the model rewrote the payload instead of quoting it. Quoting works but is a
// silent trap, and drag/precise-click is now a first-class recipe.
//
// The coercion is deliberately narrow: only finite numbers. null, objects, arrays, booleans, NaN and
// Infinity are genuine shape mistakes and stay errors - now with the offending type named, so the message
// says what is wrong instead of only what is required.
import assert from "node:assert/strict";

import { parseUserBatchStdin, parseValidBatchStepEntries } from "../dist/extensions/agent-browser/lib/orchestration/batch-stdin.js";

// 1. THE FIX: a real drag payload with unquoted coordinates is accepted and coerced to strings.
{
    const drag = JSON.stringify([
        ["mouse", "move", 338, 234],
        ["mouse", "down"],
        ["mouse", "move", 350, 234],
        ["mouse", "move", 363, 234],
        ["mouse", "up"],
    ]);
    const parsed = parseUserBatchStdin(drag);
    assert.equal(parsed.error, undefined, "an unquoted-coordinate drag no longer errors");
    assert.deepEqual(parsed.steps[0], ["mouse", "move", "338", "234"], "numeric coordinates become strings");
    assert.deepEqual(parsed.steps[3], ["mouse", "move", "363", "234"], "every numeric token in the drag is coerced");
    assert.equal(parsed.steps.length, 5, "all steps survive");
}

// 2. negative numbers (scroll wheel) are finite and must be coerced, not rejected.
{
    const parsed = parseUserBatchStdin(JSON.stringify([["mouse", "wheel", -120, 0]]));
    assert.equal(parsed.error, undefined, "negative scroll delta is accepted");
    assert.deepEqual(parsed.steps[0], ["mouse", "wheel", "-120", "0"], "negative number stringifies with its sign");
}

// 3. POSITIVE CONTROL: the already-correct quoted form is byte-identical to before - no behavior change.
{
    const quoted = JSON.stringify([["mouse", "move", "338", "234"]]);
    assert.deepEqual(parseUserBatchStdin(quoted).steps, [["mouse", "move", "338", "234"]], "quoted strings pass through untouched");
    assert.deepEqual(parseUserBatchStdin(quoted).steps, parseUserBatchStdin(JSON.stringify([["mouse", "move", 338, 234]])).steps, "quoted and unquoted forms converge on the same steps");
}

// 4. decimal coordinates coerce without losing the fraction (getBoundingClientRect returns floats).
{
    const parsed = parseUserBatchStdin(JSON.stringify([["mouse", "move", 358.5, 327.25]]));
    assert.deepEqual(parsed.steps[0], ["mouse", "move", "358.5", "327.25"], "float coordinates keep their fraction");
}

// 5. GUARD: null, arrays, objects and booleans are still rejected - those are shape mistakes.
for (const [label, token] of [["null", "null"], ["array", '["a"]'], ["boolean", "true"]]) {
    const parsed = parseUserBatchStdin(`[["click",${token}]]`);
    assert.ok(parsed.error, `${label} token is still rejected`);
    assert.match(parsed.error, /must be a string/, `${label} rejection still names the requirement`);
}

// 6. The rejection now says WHAT it got and that numbers are fine, so the fix is discoverable from the error.
{
    const nullErr = parseUserBatchStdin('[["click",null]]').error;
    assert.match(nullErr, /got null/, "the error names the offending type");
    const arrayErr = parseUserBatchStdin('[["click",["a"]]]').error;
    assert.match(arrayErr, /got an array/, "arrays are named as arrays, not just 'object'");
    assert.match(nullErr, /Finite numbers are accepted\./, "the error tells the model numbers are allowed");
}

// 7. GUARD: non-finite numbers stay errors. JSON.parse can produce them from a raw literal only via
//    Number(), so this is asserted through the same validator surface.
{
    const nonFinite = parseUserBatchStdin('[["mouse","move",1e999,2]]');
    assert.ok(nonFinite.error, "an overflowing number is still rejected");
}

// 8. Unchanged rejections: an empty step and a non-array step are untouched by the coercion.
{
    assert.match(parseUserBatchStdin('[[]]').error, /must not be empty/, "zero-token step still rejected");
    assert.match(parseUserBatchStdin('["click"]').error, /non-empty array/, "non-array step still rejected");
    // POSITIVE CONTROL: a one-token step is legal upstream (it has no operands), so it must stay accepted.
    assert.deepEqual(parseUserBatchStdin('[["click"]]').steps, [["click"]], "a single-token step is still accepted");
}

// 9. The downstream entry parser sees the coerced steps, not the raw numbers.
{
    const entries = parseValidBatchStepEntries(JSON.stringify([["mouse", "move", 338, 234]]));
    assert.equal(entries.length, 1, "one valid step entry");
    assert.deepEqual(entries[0].step, ["mouse", "move", "338", "234"], "entry carries string tokens");
    assert.equal(typeof entries[0].step[2], "string", "no numeric token survives to the argv layer");
}

// 10. Command tokens are never coerced: only operand positions are, and the command itself stays a string.
{
    const parsed = parseUserBatchStdin(JSON.stringify([["snapshot", "-i", 5000]]));
    assert.equal(parsed.error, undefined, "a numeric operand alongside flags is fine");
    assert.deepEqual(parsed.steps[0], ["snapshot", "-i", "5000"], "the numeric operand is coerced, flags untouched");
    assert.equal(typeof parsed.steps[0][0], "string", "the command token is still a string");
}

console.log("wave7-batch-numeric-tokens: all assertions passed");
