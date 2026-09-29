// Wave 9 — optional `session` on the `job` input mode and its `qa` sibling.
// Open loop W-O1: compileAgentBrowserJob used to emit bare ["batch","--bail"], so a compiled batch
// ran on the implicit pi-root session instead of the conversation's named session (live proof
// 2026-09-29: a 63-step batch drove pi-root's saucedemo tab while ultron1 stayed untouched).
//
// The session is a GLOBAL argv flag, never a per-step token, so the whole contract here is:
//   1. regression lock — a job WITHOUT session compiles byte-identically to pre-wave-9 output;
//   2. WITH session the compiled args become ["--session", <name>, "batch", ...] and the batch
//      stdin step rows are byte-identical to the no-session case;
//   3. invalid session values are rejected with a message naming the offending field;
//   4. qa inherits all of it.
// Run: node tests-v2/wave9-job-session.mjs
import assert from "node:assert/strict";
import { compileAgentBrowserJob, compileAgentBrowserQaPreset } from "../dist/extensions/agent-browser/lib/input-modes/job.js";
import { withOptionalSessionArgs } from "../dist/extensions/agent-browser/lib/results/next-actions.js";

let groups = 0;
function group(name, body) {
    body();
    groups += 1;
    console.log(`  group ${groups}: ${name}`);
}

const JOB_STEPS = [
    { action: "open", url: "https://example.com" },
    { action: "assertText", text: "Example Domain" },
    { action: "screenshot", path: ".dogfood/wave9.png" },
];
// Hand-written, not derived from the compiler: this is the pre-wave-9 stdin, pinned as a literal so
// the regression lock cannot drift with the implementation.
const EXPECTED_STDIN = JSON.stringify([
    ["open", "https://example.com"],
    ["wait", "--text", "Example Domain"],
    ["screenshot", ".dogfood/wave9.png"],
]);

// ---------------------------------------------------------------------------
group("regression lock: a job WITHOUT session compiles to the exact pre-wave-9 args and stdin", () => {
    const compiled = compileAgentBrowserJob({ steps: JOB_STEPS }).compiled;
    assert.deepEqual(compiled.args, ["batch", "--bail"]);
    assert.equal(compiled.failFast, true);
    assert.equal(compiled.stdin, EXPECTED_STDIN);
    assert.equal(compiled.steps.length, 3);
    assert.deepEqual(compiled.steps[0], { action: "open", args: ["open", "https://example.com"], generatedFrom: undefined });
});

group("regression lock: failFast:false WITHOUT session still emits bare [\"batch\"]", () => {
    const compiled = compileAgentBrowserJob({ steps: JOB_STEPS, failFast: false }).compiled;
    assert.deepEqual(compiled.args, ["batch"]);
    assert.equal(compiled.failFast, false);
    assert.equal(compiled.stdin, EXPECTED_STDIN);
});

group("regression lock: an unrelated extra top-level field never leaks into argv", () => {
    const compiled = compileAgentBrowserJob({ steps: JOB_STEPS, namespace: "ns1" }).compiled;
    assert.deepEqual(compiled.args, ["batch", "--bail"]);
    assert.equal(compiled.stdin, EXPECTED_STDIN);
});

group("WITH session: args become [\"--session\", name, \"batch\", \"--bail\"] and stdin is byte-identical", () => {
    const withSession = compileAgentBrowserJob({ session: "ultron1", steps: JOB_STEPS });
    const without = compileAgentBrowserJob({ steps: JOB_STEPS });
    assert.equal(withSession.error, undefined);
    assert.deepEqual(withSession.compiled.args, ["--session", "ultron1", "batch", "--bail"]);
    // The session is argv-level only: identical step rows, identical stdin bytes.
    assert.equal(withSession.compiled.stdin, without.compiled.stdin);
    assert.equal(withSession.compiled.stdin, EXPECTED_STDIN);
    assert.deepEqual(withSession.compiled.steps, without.compiled.steps);
});

group("WITH session and failFast:false: args become [\"--session\", name, \"batch\"]", () => {
    const compiled = compileAgentBrowserJob({ session: "ultron1", steps: JOB_STEPS, failFast: false }).compiled;
    assert.deepEqual(compiled.args, ["--session", "ultron1", "batch"]);
    assert.equal(compiled.failFast, false);
    assert.equal(compiled.stdin, EXPECTED_STDIN);
});

group("no per-step token leak: --session appears in argv only, never in stdin or any step row", () => {
    const compiled = compileAgentBrowserJob({ session: "ultron1", steps: JOB_STEPS }).compiled;
    assert.equal(JSON.stringify(compiled.steps).includes("--session"), false);
    assert.equal(compiled.stdin.includes("--session"), false);
    assert.equal(compiled.stdin.includes("ultron1"), false);
    assert.equal(compiled.args.filter((token) => token === "--session").length, 1);
});

group("session is trimmed, and exactly MAX_SESSION_CHARS (64) is accepted", () => {
    const trimmed = compileAgentBrowserJob({ session: "  ultron2  ", steps: JOB_STEPS });
    assert.deepEqual(trimmed.compiled.args, ["--session", "ultron2", "batch", "--bail"]);
    const atLimit = compileAgentBrowserJob({ session: "a".repeat(64), steps: JOB_STEPS });
    assert.equal(atLimit.error, undefined);
    assert.deepEqual(atLimit.compiled.args[1], "a".repeat(64));
});

group("invalid session type is rejected and the message names job.session", () => {
    for (const bad of [7, true, null, ["ultron1"], { name: "ultron1" }]) {
        const result = compileAgentBrowserJob({ session: bad, steps: JOB_STEPS });
        assert.match(result.error ?? "", /job\.session/);
        assert.equal(result.compiled, undefined);
    }
});

group("empty or whitespace-only session is rejected and the message names job.session", () => {
    for (const bad of ["", "   ", "\t\n"]) {
        const result = compileAgentBrowserJob({ session: bad, steps: JOB_STEPS });
        assert.match(result.error ?? "", /job\.session/);
    }
});

group("internal whitespace and NUL byte are rejected and the message names job.session", () => {
    for (const bad of ["ultra n1", "ultron\t1", "ultron\n1", "ultra\u0000n1"]) {
        const result = compileAgentBrowserJob({ session: bad, steps: JOB_STEPS });
        assert.match(result.error ?? "", /job\.session/, `expected job.session error for ${JSON.stringify(bad)}`);
        assert.match(result.error, /whitespace or NUL/);
    }
});

group("session longer than 64 characters is rejected and the message names job.session", () => {
    const result = compileAgentBrowserJob({ session: "a".repeat(65), steps: JOB_STEPS });
    assert.match(result.error ?? "", /job\.session/);
    assert.match(result.error, /64 characters or fewer/);
});

group("qa inherits the same behaviour: bare [\"batch\",\"--bail\"] without session, prefixed with it", () => {
    const qa = { url: "https://example.com", expectedText: "Example Domain" };
    const without = compileAgentBrowserQaPreset(qa).compiled;
    const withSession = compileAgentBrowserQaPreset({ ...qa, session: "ultron3" });
    assert.deepEqual(without.args, ["batch", "--bail"]);
    assert.equal(withSession.error, undefined);
    assert.deepEqual(withSession.compiled.args, ["--session", "ultron3", "batch", "--bail"]);
    assert.equal(withSession.compiled.stdin, without.stdin);
    assert.equal(withSession.compiled.stdin.includes("--session"), false);
    assert.deepEqual(withSession.compiled.steps, without.steps);
});

group("qa.attached + session compiles the same way, still with identical stdin", () => {
    const attached = { attached: true, expectedText: "Explorer" };
    const without = compileAgentBrowserQaPreset(attached).compiled;
    const withSession = compileAgentBrowserQaPreset({ ...attached, session: "ultron1" }).compiled;
    assert.deepEqual(without.args, ["batch", "--bail"]);
    assert.deepEqual(withSession.args, ["--session", "ultron1", "batch", "--bail"]);
    assert.equal(withSession.stdin, without.stdin);
});

group("invalid qa.session is rejected and the message names qa.session", () => {
    const base = { url: "https://example.com" };
    const cases = [
        [7, /qa\.session/],
        ["", /qa\.session/],
        ["ultra n1", /whitespace or NUL/],
        ["a".repeat(65), /64 characters or fewer/],
    ];
    for (const [bad, pattern] of cases) {
        const result = compileAgentBrowserQaPreset({ ...base, session: bad });
        assert.match(result.error ?? "", pattern, `expected ${pattern} for ${JSON.stringify(bad)}`);
        assert.equal(result.compiled, undefined);
    }
});

group("the reused helper withOptionalSessionArgs does exactly what the fix relies on", () => {
    // No session -> untouched args (this is what keeps every existing caller byte-identical).
    const bare = ["batch", "--bail"];
    assert.equal(withOptionalSessionArgs(undefined, bare), bare);
    // No double-prefixing when argv already names a session, directly or after --namespace.
    assert.deepEqual(withOptionalSessionArgs("ultron1", ["--session", "other", "batch"]), ["--session", "other", "batch"]);
    assert.deepEqual(withOptionalSessionArgs("ultron1", ["--namespace", "ns", "--session", "other", "batch"]), ["--namespace", "ns", "--session", "other", "batch"]);
    // And it inserts after --namespace rather than before it.
    assert.deepEqual(withOptionalSessionArgs("ultron1", ["--namespace", "ns", "batch"]), ["--namespace", "ns", "--session", "ultron1", "batch"]);
    assert.deepEqual(withOptionalSessionArgs("ultron1", bare), ["--session", "ultron1", "batch", "--bail"]);
});

console.log(`wave9-job-session: all assertions passed (${groups} assertion groups)`);
