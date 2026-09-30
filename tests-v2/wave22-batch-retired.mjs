// wave22: `batch` is retired as a CALLER command, and must survive for everyone who compiles into it.
//
// Removing batch outright would have been the obvious move and would have been wrong. job, checkpoint
// restore, debug, login-flow and lookups all compile DOWN to a batch, and their stdin is built inside
// the wrapper in JS rather than passed as a tool parameter — so the host never reshapes it, which is
// why checkpoint restore is live-verified working while caller-supplied batch is not.
//
// So the refusal is scoped to the one broken entry point. These assertions exist because the first
// version of the guard took `job` down with it: the skip list for compiler-generated args did not
// include compiledGeneratedBatch, and job compiles to exactly the argv the guard rejects.
import assert from "node:assert/strict";

import { resolveAgentBrowserInput } from "../dist/extensions/agent-browser/lib/orchestration/input-plan.js";

const resolve = (params) => resolveAgentBrowserInput({ params, getBatchPreflightValidationError: () => undefined });

// --- refused: the caller supplying batch steps ---------------------------------------------
const withStdin = resolve({ args: ["--session", "u1", "batch", "--bail"], stdin: '[["get","url"]]' });
assert.equal(withStdin.kind, "invalid", "caller batch with stdin must be refused");
assert.match(String(withStdin.validationError), /reshape/i, "the refusal must name the cause");
assert.match(String(withStdin.validationError), /eval --stdin/, "the refusal must name the route that works");

// Refused even without stdin: raw batch args are one step per token and never worked either.
assert.equal(resolve({ args: ["--session", "u1", "batch", "--bail"] }).kind, "invalid",
    "caller batch without stdin must be refused too");

// --- must keep working ---------------------------------------------------------------------
assert.equal(resolve({ args: ["--session", "u1", "get", "url"] }).kind, "args", "a plain args call is untouched");
assert.equal(resolve({ args: ["--session", "u1", "eval", "--stdin"], stdin: "document.title" }).kind, "args",
    "eval --stdin is the documented replacement and must not be caught by the batch refusal");

// These compile DOWN to a batch. If any of them is refused, the removal took working features with it.
assert.equal(resolve({ job: { session: "u1", steps: [{ action: "open", url: "https://example.com/" }] } }).kind, "job",
    "job compiles to batch internally and must survive");
assert.equal(resolve({ checkpoint: { action: "list" } }).kind, "checkpoint",
    "checkpoint compiles to batch rows and must survive");
assert.equal(resolve({ act: { find: { text: "Reply" }, action: "click" } }).kind, "act",
    "act compiles to an eval batch and must survive");

console.log("wave22-batch-retired: all assertions passed (caller batch refused with the working route named, job/checkpoint/act survive, eval --stdin untouched)");
