// wave 11: pin the REAL batch-stdin token contract.
//
// The wave-7 numeric-token coercion is deleted. It was unreachable: the Pi host validates the `stdin`
// tool param as an array-of-string-arrays BEFORE the wrapper's execute() body runs, so
// [["mouse","move",489,119]] is rejected by the host ("invalid type: integer 489, expected a string")
// and never reaches validateUserBatchStep. Dead code that looks alive tells a false story.
//
// The real contract: every token in a step is a string. A number is as invalid as null.
import assert from "node:assert/strict";

import { parseUserBatchStdin, parseValidBatchStepEntries, getUpstreamEffectiveBatchSteps } from "../dist/extensions/agent-browser/lib/orchestration/batch-stdin.js";

// 1. THE CONTRACT: all-string steps are accepted and passed through unchanged.
{
    const steps = [["mouse", "move", "338", "234"], ["click", "#submit"], ["get", "url"]];
    const parsed = parseUserBatchStdin(JSON.stringify(steps));
    assert.equal(parsed.error, undefined, "an all-string payload does not error");
    assert.deepEqual(parsed.steps, steps, "string tokens are returned verbatim, no re-mapping");
    assert.equal(typeof parsed.steps[0][2], "string", "a quoted coordinate stays a string");
}

// 2. THE DELETION: a numeric token is now rejected like any other non-string, and the message no
//    longer claims numbers are fine.
{
    const error = parseUserBatchStdin('[["mouse","move",489,119]]').error;
    assert.ok(error, "an unquoted coordinate is rejected");
    assert.match(error, /step 0 token 2 must be a string/, "the message names the offending position");
    assert.doesNotMatch(error, /Finite numbers are accepted/, "the deleted sentence is gone");
    assert.doesNotMatch(error, /got /, "a plain number is named by the requirement, not a parenthetical type");
}

// 3. THE DIAGNOSEABILITY GUARD: genuine shape mistakes still name the type they got.
{
    assert.match(parseUserBatchStdin('[["click",null]]').error, /got null/, "null is named");
    assert.match(parseUserBatchStdin('[["click",["a"]]]').error, /got an array/, "an array is named as an array");
    assert.match(parseUserBatchStdin('[["click",true]]').error, /got boolean/, "a boolean is named");
    assert.match(parseUserBatchStdin('[["click",{"x":1}]]').error, /got object/, "a plain object is named");
}

// 4. GUARD: a non-finite number (an overflowing JSON literal) is rejected too, with no coercion path
//    left that could accept it.
{
    assert.ok(parseUserBatchStdin('[["mouse","move",1e999,2]]').error, "an overflowing number is rejected");
}

// 5. Shape errors are unchanged: an empty step and a non-array step.
{
    assert.match(parseUserBatchStdin("[[]]").error, /must not be empty/, "zero-token step rejected");
    assert.match(parseUserBatchStdin('["click"]').error, /non-empty array/, "non-array step rejected");
    // POSITIVE CONTROL: a one-token step is legal upstream (no operands), so it must stay accepted.
    assert.deepEqual(parseUserBatchStdin('[["click"]]').steps, [["click"]], "a single-token step is accepted");
}

// 6. The downstream entry parser and the argv-layer helper agree with the same contract.
{
    assert.deepEqual(parseValidBatchStepEntries('[["get","url"],["mouse","move",1,2]]'), [{ index: 0, step: ["get", "url"] }], "a rejected step is filtered out, the valid one survives");
    assert.deepEqual(getUpstreamEffectiveBatchSteps(["batch"], '[["mouse","move",1,2]]'), [], "an invalid stdin batch yields no effective steps");
    assert.deepEqual(getUpstreamEffectiveBatchSteps(["batch"], '[["get","url"]]'), [["get", "url"]], "a valid stdin batch yields its steps");
}

console.log("wave11-batch-token-contract: all assertions passed");
