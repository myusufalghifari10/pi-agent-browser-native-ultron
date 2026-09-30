// wave5 C-group: Coursera live-marathon ergonomics fixes.
// W5-1: upstream `wait` has no --ms/--timeout flags — unknown flags hang until the watchdog
// (live: ["wait","--ms","1500"] burned 25s of dead air inside a Coursera bandit batch, twice).
// The positional duration form works (live: ["wait","2000"] → "Fixed wait elapsed"). The guard
// teaches the real grammar pre-spawn, mirroring the wave4 W-N2 `tab select` guard.
import assert from "node:assert/strict";

import { resolveAgentBrowserInput } from "../dist/extensions/agent-browser/lib/orchestration/input-plan.js";

const input = (params) => resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params });

// 1. top-level wait --ms → rejected pre-spawn with the working call shown
const msTop = input({ args: ["wait", "--ms", "1500"] });
assert.equal(msTop.status, "invalid", "wait --ms is rejected pre-spawn");
assert.match(msTop.validationError ?? "", /no --ms\/--timeout flags/, "rejection names the flag defect");
assert.match(msTop.validationError ?? "", /\["wait","2000"\]/, "rejection shows the positional working call");

// 2. wait --timeout → same guard
const timeoutTop = input({ args: ["wait", "--timeout", "2"] });
assert.equal(timeoutTop.status, "invalid", "wait --timeout is rejected pre-spawn");
assert.match(timeoutTop.validationError ?? "", /no --ms\/--timeout flags/, "--timeout rejection names the same defect");

// 3. flag form inside a batch step → blocked with the step number
const msBatch = input({ args: ["batch", "--bail"], stdin: JSON.stringify([["click", "@e1"], ["wait", "--ms", "1500"], ["get", "url"]]) });
assert.equal(msBatch.status, "invalid", "wait --ms as a batch step is rejected");
assert.match(msBatch.validationError ?? "", /Blocked batch step 2/, "rejection points at the offending step");

// 4. --timeout inside a batch step → blocked too
const timeoutBatch = input({ args: ["batch"], stdin: JSON.stringify([["wait", "--timeout", "2"]]) });
assert.equal(timeoutBatch.status, "invalid", "wait --timeout as a batch step is rejected");
assert.match(timeoutBatch.validationError ?? "", /Blocked batch step 1/, "rejection points at step 1");

// CONTRACT CHANGE (wave22, requested): caller-supplied `batch` is retired on this build. The host
// reshapes the `stdin` tool parameter into an array of string arrays specifically for `batch`,
// before the tool body runs, so batch steps never arrive intact. This positive control can no
// longer be expressed through the caller path at all, so it is re-stated against the new truth
// rather than quietly deleted: the same steps are still valid, they now arrive through `eval
// --stdin`, and the step-specific guards above it are still live for job/qa/debug, which
// compile to a batch internally with stdin built inside the wrapper.
// 5. POSITIVE CONTROL: positional duration is still valid (the live-proven form), now through eval
const positional = input({ args: ["wait", "2000"] });
assert.notEqual(positional.status, "invalid", "positional wait 2000 stays valid as a top-level command");
const positionalEval = input({ args: ["eval", "--stdin"], stdin: "(() => { setTimeout(() => {}, 2000); return 1; })()" });
assert.notEqual(positionalEval.status, "invalid", "the same multi-step shape is valid through eval --stdin");

// 6. POSITIVE CONTROL: condition flag forms stay valid
const textWait = input({ args: ["wait", "--text", "Login Page"] });
assert.notEqual(textWait.status, "invalid", "wait --text stays valid");
const urlWait = input({ args: ["wait", "--url", "**/dashboard"] });
assert.notEqual(urlWait.status, "invalid", "wait --url stays valid");
const loadWait = input({ args: ["wait", "--load"] });
assert.notEqual(loadWait.status, "invalid", "wait --load stays valid");

// 7. unrelated flags on other commands are untouched (narrow guard, no speculative whitelist)
const textFlagOther = input({ args: ["snapshot", "-i", "--text", "x"] });
assert.notEqual(textFlagOther.status, "invalid", "non-wait commands with flags are not intercepted");

// 8. wave4 W-N2 regression: tab select guard still fires (chained before the new guard)
const selectBatch = input({ args: ["batch", "--bail"], stdin: JSON.stringify([["tab", "select", "t1"]]) });
assert.equal(selectBatch.status, "invalid", "tab select batch guard still fires after the wave5 chain insert");

// 9. non-wait, non-batch commands pass the guard untouched
const plain = input({ args: ["get", "title"] });
assert.notEqual(plain.status, "invalid", "plain get title unaffected");

console.log("wave5-coursera-ergonomics: all assertions passed");
