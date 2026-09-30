// wave8 live-sweep (UC1-UC8 use-case runs): W8-1 teaching guard for `type` arity.
// Live: a one-argument `type "some text"` is parsed as `type <sel>` with an empty text payload.
// Upstream still prints a success-shaped `Typed: ` line while writing nothing, so the agent
// believes the text landed (observed on a Monaco editor at OneCompiler: the model stayed on its
// template, and the run then failed on the stale code). The real grammar is `type <sel> <text>`,
// with `keyboard type <text>` for an already-focused element. Mirrors the wave5 W5-1 wait guard.
import assert from "node:assert/strict";

import { resolveAgentBrowserInput } from "../dist/extensions/agent-browser/lib/orchestration/input-plan.js";

const input = (params) => resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params });

// 1. the exact live failure: a bare text payload read as a selector
const bare = input({ args: ["type", "def split_half(nums):"] });
assert.equal(bare.status, "invalid", "one-argument type is rejected pre-spawn");
assert.match(bare.validationError ?? "", /needs two arguments/, "rejection names the arity defect");
assert.match(bare.validationError ?? "", /\["type","#email","hello"\]/, "rejection shows the two-argument working call");

// 2. the rejection points at the keyboard form for a focused element (the live Monaco recipe)
assert.match(bare.validationError ?? "", /\["keyboard","type","hello"\]/, "rejection shows the focused-element form");

// 3. it explains why the call looked successful
assert.match(bare.validationError ?? "", /"Typed: "/, "rejection names the misleading success line");

// 4. bare `type` with no arguments at all
const empty = input({ args: ["type"] });
assert.equal(empty.status, "invalid", "argument-less type is rejected");

// 5. one-argument type as a batch step → blocked with the step number
const bareBatch = input({ args: ["batch", "--bail"], stdin: JSON.stringify([["click", "@e1"], ["type", "#email"], ["get", "url"]]) });
assert.equal(bareBatch.status, "invalid", "one-argument type as a batch step is rejected");
assert.match(bareBatch.validationError ?? "", /Blocked batch step 2/, "rejection points at the offending step");

// 6. POSITIVE CONTROL: the real two-argument form stays valid
const ok = input({ args: ["type", "#email", "hello"] });
assert.notEqual(ok.status, "invalid", "type <sel> <text> stays valid");

// 7. POSITIVE CONTROL: --clear and other trailing flags still count as the text argument
const okClear = input({ args: ["type", "@e5", "replacement text", "--clear"] });
assert.notEqual(okClear.status, "invalid", "type with a trailing --clear stays valid");
// CONTRACT CHANGE (wave22, requested): caller-supplied `batch` is retired on this build. The host
// reshapes the `stdin` tool parameter into an array of string arrays specifically for `batch`,
// before the tool body runs, so batch steps never arrive intact. This positive control can no
// longer be expressed through the caller path at all, so it is re-stated against the new truth
// rather than quietly deleted: the same steps are still valid, they now arrive through `eval
// --stdin`, and the step-specific guards above it are still live for job/qa/debug, which
// compile to a batch internally with stdin built inside the wrapper.
// The two-argument `type` form is still valid; it is simply no longer reachable through a batch,
// because there is no caller batch to put it in. The arity guard itself is unchanged and still
// applies to job/qa/debug, which compile to a batch internally.
const okBatch = input({ args: ["type", "#a", "x"] });
assert.notEqual(okBatch.status, "invalid", "two-argument type stays valid as a top-level command");
const okBatchEval = input({ args: ["eval", "--stdin"], stdin: "(() => { const a='#a', b='x'; return a+b; })()" });
assert.notEqual(okBatchEval.status, "invalid", "the same two-value shape is valid through eval --stdin");

// 8. POSITIVE CONTROL: `keyboard type <text>` is the single-argument form and must NOT be caught
const kb = input({ args: ["keyboard", "type", "hello"] });
assert.notEqual(kb.status, "invalid", "keyboard type <text> stays valid (different command)");

// 9. other text-entry commands are untouched (narrow guard, no speculative whitelist)
const fill = input({ args: ["fill", "#email", "hello"] });
assert.notEqual(fill.status, "invalid", "fill is not intercepted");
const press = input({ args: ["press", "Enter"] });
assert.notEqual(press.status, "invalid", "press is not intercepted");

// 10. regression: the wave5 W5-1 wait guard still fires, and its valid forms stay valid
const waitMs = input({ args: ["wait", "--ms", "1500"] });
assert.equal(waitMs.status, "invalid", "wave5 wait --ms guard still fires");
const waitOk = input({ args: ["wait", "2000"] });
assert.notEqual(waitOk.status, "invalid", "positional wait stays valid");

// 11. regression: the wave4 W-N2 tab select guard still fires
const tabSel = input({ args: ["batch", "--bail"], stdin: JSON.stringify([["tab", "select", "t1"]]) });
assert.equal(tabSel.status, "invalid", "tab select guard still fires");

console.log("wave8-type-arity-guard: all assertions passed");
