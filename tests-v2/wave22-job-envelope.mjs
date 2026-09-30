// wave22: the host's {item: ...} envelope reaches the `job` object too, not just argv and batch stdin.
//
// Same host behaviour, same repair. This build stringifies every tool parameter
// (earendil-works/pi#4226) and its runner wraps a NESTED array parameter in {item: ...}
// (hermes-agent#104803), so a job whose steps is an array of objects arrives wrapped and
// every step reads as a bare string — the caller sees "job.steps must be a non-empty array"
// while looking at a perfectly correct payload.
//
// Unwrapping is safe by construction: a job step is ALWAYS an object carrying an `action`,
// so {item: ...} can never be a legitimate step and the strip is a no-op on any job that
// already worked. What these assertions exist to prevent is the strip being removed, or
// eating the real diagnostics while doing it.
import assert from "node:assert/strict";

import { compileAgentBrowserJob } from "../dist/extensions/agent-browser/lib/input-modes/job.js";

const compile = (input) => compileAgentBrowserJob(input);
const ok = (input) => (compile(input).error === undefined ? "OK" : compile(input).error);

// The shape that actually reached the wrapper: the whole job object inside the envelope.
assert.equal(ok({ item: { session: "u1", steps: [{ action: "snapshot" }] } }), "OK",
    "the live envelope on the job object must be unwrapped, not rejected");
// The envelope can also land on steps itself, or on an individual step.
assert.equal(ok({ session: "u1", steps: { item: [{ action: "snapshot" }] } }), "OK",
    "an envelope on job.steps must be unwrapped");
assert.equal(ok({ session: "u1", steps: [{ item: { action: "snapshot" } }] }), "OK",
    "an envelope on a single step must be unwrapped");

// A plain job must be untouched.
const plain = compile({ session: "u1", steps: [{ action: "snapshot" }] });
assert.equal(plain.error, undefined, "a plain job must still compile");
assert.deepEqual(plain.compiled.args, ["--session", "u1", "batch", "--bail"],
    "the compiled argv must be byte-identical to the pre-patch form");

// The repair is for one known host defect, not a licence to accept anything.
assert.match(ok({ session: "u1" }), /steps must be a non-empty array/, "a job with no steps must still say so");
assert.match(ok({ session: "u1", steps: [] }), /steps must be a non-empty array/, "an empty steps array must still be refused");
assert.match(ok(5), /job must be an object/, "a non-object job must still be refused");
assert.match(ok({ session: "u1", steps: [{ action: "nope" }] }), /action must be one of/, "an unknown action must still be refused");
assert.match(ok({ session: "u1", steps: [{ action: "snapshot", bogus: 1 }] }), /does not support bogus/, "an unsupported step field must still be named");
// The envelope strip must not make `failFast` validation disappear.
assert.match(ok({ item: { failFast: "yes", steps: [{ action: "snapshot" }] } }), /failFast must be a boolean/,
    "field validation must still run on the unwrapped payload");

console.log("wave22-job-envelope: all assertions passed (envelope unwrapped at all three levels, compiled argv unchanged, every real diagnostic preserved)");
