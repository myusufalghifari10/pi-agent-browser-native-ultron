// Wave 14 Lane A — the `cdp` input mode compiler.
//
// `cdp` is the raw Chrome DevTools Protocol escape hatch: the only way to reach capabilities the
// wrapped CLI surface does not expose. That makes this validator the entire guard in front of a
// socket, so the test pins every rule of plan.md §2.2 individually, plus the two structural promises
// the host handler relies on: normalizeCdpInput never throws (it returns { error }), and
// compileAgentBrowserCdp is a pure mapping with no I/O of any kind.
//
// Every assertion below can fail: each one supplies a concrete input and a concrete expectation, and
// the negative groups deliberately pass near-miss values (32 commands, 64-char session, timeoutMs at
// the limit) so an off-by-one or a silently-ignored field is caught rather than assumed away.
//
// Run: node tests-v2/wave14-cdp-input-mode.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    CDP_ALLOWED_COMMAND_FIELDS,
    CDP_ALLOWED_FIELDS,
    CDP_DEFAULT_TIMEOUT_MS,
    CDP_MAX_COMMANDS,
    CDP_MAX_SESSION_CHARS,
    CDP_MAX_TIMEOUT_MS,
    compileAgentBrowserCdp,
    normalizeCdpInput,
} from "../dist/extensions/agent-browser/lib/input-modes/cdp.js";

let groups = 0;
function group(name, body) {
    body();
    groups += 1;
    console.log(`  group ${groups}: ${name}`);
}

const VALID_COMMAND = { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } };
const VALID_INPUT = { commands: [VALID_COMMAND] };

// ---------------------------------------------------------------------------
group("frozen interface: constants have the exact contract values", () => {
    assert.equal(CDP_MAX_COMMANDS, 32);
    assert.equal(CDP_MAX_SESSION_CHARS, 64);
    assert.equal(CDP_MAX_TIMEOUT_MS, 120000);
    assert.equal(CDP_DEFAULT_TIMEOUT_MS, 30000);
    assert.deepEqual([...CDP_ALLOWED_FIELDS].sort(), ["artifactPath", "commands", "session", "timeoutMs"]);
    assert.deepEqual([...CDP_ALLOWED_COMMAND_FIELDS].sort(), ["artifact", "method", "params"]);
});

// ---------------------------------------------------------------------------
// Rule 1 — cdp must be an object; unknown top-level fields are rejected and the
// message names the supported list.
group("rule 1: non-object cdp is an error, never a throw", () => {
    for (const bad of [undefined, null, [], "Runtime.evaluate", 7, true]) {
        const result = normalizeCdpInput(bad);
        assert.ok(result.error, `expected an error for ${JSON.stringify(bad) ?? String(bad)}`);
        assert.equal(result.value, undefined);
    }
});

group("rule 1: an unknown top-level field is rejected and the message lists the supported fields", () => {
    const result = normalizeCdpInput({ ...VALID_INPUT, ssession: "ultron1" });
    assert.match(result.error ?? "", /does not support ssession/);
    assert.match(result.error, /session, commands, artifactPath, timeoutMs/);
    assert.equal(result.value, undefined);
});

group("rule 1: cdp.sessionMode points at the top-level field instead of naming an unknown field", () => {
    const result = normalizeCdpInput({ ...VALID_INPUT, sessionMode: "fresh" });
    assert.match(result.error ?? "", /top-level agent_browser sessionMode/);
});

// ---------------------------------------------------------------------------
// Rule 2 — commands is required, a non-empty array, at most 32 entries.
group("rule 2: missing commands is an error, not a silent default", () => {
    const result = normalizeCdpInput({});
    assert.ok(result.error, "normalizeCdpInput({}) must not compile to a default plan");
    assert.match(result.error, /requires a commands array/);
    assert.equal(result.value, undefined);
});

group("rule 2: non-array commands is rejected", () => {
    for (const bad of [{}, "Runtime.evaluate", 3, null]) {
        const result = normalizeCdpInput({ commands: bad });
        assert.match(result.error ?? "", /cdp\.commands must be an array/, `expected the array error for ${JSON.stringify(bad)}`);
    }
});

group("rule 2: an empty commands array is rejected", () => {
    const result = normalizeCdpInput({ commands: [] });
    assert.match(result.error ?? "", /at least one command/);
});

group("rule 2: exactly 32 commands is accepted and 33 is rejected", () => {
    const atLimit = normalizeCdpInput({ commands: Array.from({ length: CDP_MAX_COMMANDS }, () => VALID_COMMAND) });
    assert.equal(atLimit.error, undefined);
    assert.equal(atLimit.value.commands.length, CDP_MAX_COMMANDS);
    const overLimit = normalizeCdpInput({ commands: Array.from({ length: CDP_MAX_COMMANDS + 1 }, () => VALID_COMMAND) });
    assert.match(overLimit.error ?? "", /32 commands or fewer \(got 33\)/);
    assert.equal(overLimit.value, undefined);
});

// ---------------------------------------------------------------------------
// Rule 3 — every command is an object with only method/params/artifact.
group("rule 3: a non-object command is rejected with its index", () => {
    const result = normalizeCdpInput({ commands: [VALID_COMMAND, "Runtime.evaluate"] });
    assert.match(result.error ?? "", /cdp\.commands\[1\] must be an object/);
});

group("rule 3: an unknown command field is rejected and the message lists the allowed command fields", () => {
    const result = normalizeCdpInput({ commands: [{ method: "Runtime.evaluate", wait: true }] });
    assert.match(result.error ?? "", /cdp\.commands\[0\] does not support wait/);
    assert.match(result.error, /method, params, artifact/);
});

// ---------------------------------------------------------------------------
// Rule 4 — method is a non-empty string, no whitespace/NUL, and carries a dot.
group("rule 4: a method without a dot is rejected", () => {
    const result = normalizeCdpInput({ commands: [{ method: "Runtime" }] });
    assert.match(result.error ?? "", /Domain\.command/);
    assert.equal(result.value, undefined);
});

group("rule 4: a missing, empty or non-string method is rejected", () => {
    for (const bad of [undefined, "", "   ", 7, null, { domain: "Runtime" }]) {
        const result = normalizeCdpInput({ commands: [{ method: bad }] });
        assert.match(result.error ?? "", /method must be a non-empty string/, `expected the method error for ${JSON.stringify(bad) ?? String(bad)}`);
    }
});

group("rule 4: whitespace or NUL inside method is rejected", () => {
    for (const bad of ["Runtime . evaluate", "Runtime.evaluate ", "Runtime\u0000.evaluate", "Runtime\tevaluate"]) {
        const result = normalizeCdpInput({ commands: [{ method: bad }] });
        assert.ok(result.error, `expected a rejection for ${JSON.stringify(bad)}`);
    }
});

group("rule 4: a well-formed Domain.command method is accepted verbatim", () => {
    const result = normalizeCdpInput({ commands: [{ method: "HeapProfiler.takeHeapSnapshot" }] });
    assert.equal(result.error, undefined);
    assert.equal(result.value.commands[0].method, "HeapProfiler.takeHeapSnapshot");
});

// ---------------------------------------------------------------------------
// Rule 5 — params, when present, must be a plain object.
group("rule 5: array, null and scalar params are rejected", () => {
    for (const bad of [[], null, "document.title", 7, true]) {
        const result = normalizeCdpInput({ commands: [{ method: "Runtime.evaluate", params: bad }] });
        assert.match(result.error ?? "", /params must be an object when provided/, `expected the params error for ${JSON.stringify(bad)}`);
    }
});

group("rule 5: valid params pass through untouched, with numeric values kept as numbers", () => {
    const params = { expression: "document.title", returnByValue: true, timeout: 500, count: 32 };
    const result = normalizeCdpInput({ commands: [{ method: "Runtime.evaluate", params }] });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.value.commands[0].params, params);
    assert.equal(typeof result.value.commands[0].params.timeout, "number");
    assert.equal(typeof result.value.commands[0].params.count, "number");
});

// ---------------------------------------------------------------------------
// Rule 6 — session, when present, is a bounded whitespace/NUL-free string.
group("rule 6: a 65-character session is rejected and 64 is accepted", () => {
    const tooLong = normalizeCdpInput({ ...VALID_INPUT, session: "a".repeat(CDP_MAX_SESSION_CHARS + 1) });
    assert.match(tooLong.error ?? "", /64 characters or fewer/);
    assert.equal(tooLong.value, undefined);
    const atLimit = normalizeCdpInput({ ...VALID_INPUT, session: "a".repeat(CDP_MAX_SESSION_CHARS) });
    assert.equal(atLimit.error, undefined);
    assert.equal(atLimit.value.session, "a".repeat(CDP_MAX_SESSION_CHARS));
});

group("rule 6: a non-string or empty session is rejected", () => {
    for (const bad of [7, true, null, "", "   ", ["ultron1"], { name: "ultron1" }]) {
        const result = normalizeCdpInput({ ...VALID_INPUT, session: bad });
        assert.match(result.error ?? "", /cdp\.session/, `expected the session error for ${JSON.stringify(bad) ?? String(bad)}`);
    }
});

group("rule 6: whitespace or NUL inside session is rejected", () => {
    for (const bad of ["ultra n1", "ultron\t1", "ultron\n1", "ultra\u0000n1"]) {
        const result = normalizeCdpInput({ ...VALID_INPUT, session: bad });
        assert.match(result.error ?? "", /whitespace or NUL/, `expected a whitespace/NUL rejection for ${JSON.stringify(bad)}`);
    }
});

// ---------------------------------------------------------------------------
// Rule 7 — timeoutMs, when present, is a positive integer at most 120000.
group("rule 7: timeoutMs above 120000 is rejected and exactly 120000 is accepted", () => {
    const tooLong = normalizeCdpInput({ ...VALID_INPUT, timeoutMs: CDP_MAX_TIMEOUT_MS + 1 });
    assert.match(tooLong.error ?? "", /cdp\.timeoutMs must be 120000 or less/);
    assert.equal(tooLong.value, undefined);
    const atLimit = normalizeCdpInput({ ...VALID_INPUT, timeoutMs: CDP_MAX_TIMEOUT_MS });
    assert.equal(atLimit.error, undefined);
    assert.equal(atLimit.value.timeoutMs, CDP_MAX_TIMEOUT_MS);
});

group("rule 7: non-positive, fractional, non-numeric and string timeouts are rejected", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "30000", null, {}]) {
        const result = normalizeCdpInput({ ...VALID_INPUT, timeoutMs: bad });
        assert.match(result.error ?? "", /cdp\.timeoutMs/, `expected the timeoutMs error for ${JSON.stringify(bad) ?? String(bad)}`);
    }
});

group("rule 7: an omitted timeoutMs defaults to 30000", () => {
    const result = normalizeCdpInput(VALID_INPUT);
    assert.equal(result.value.timeoutMs, CDP_DEFAULT_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// Rule 8 — a named session plus sessionMode "fresh" is a contradiction.
group("rule 8: session plus sessionMode \"fresh\" is rejected", () => {
    const result = normalizeCdpInput({ ...VALID_INPUT, session: "ultron1" }, { sessionMode: "fresh" });
    assert.match(result.error ?? "", /cdp\.session cannot be combined with sessionMode "fresh"/);
    assert.equal(result.value, undefined);
});

group("rule 8: a session alone and sessionMode \"fresh\" alone are both fine", () => {
    const named = normalizeCdpInput({ ...VALID_INPUT, session: "ultron1" }, { sessionMode: "auto" });
    assert.equal(named.error, undefined);
    assert.equal(named.value.session, "ultron1");
    const fresh = normalizeCdpInput(VALID_INPUT, { sessionMode: "fresh" });
    assert.equal(fresh.error, undefined);
    assert.equal(fresh.value.session, undefined);
});

// ---------------------------------------------------------------------------
group("artifact: a per-command artifact name is a single path segment; artifactPath is a non-empty name", () => {
    const ok = normalizeCdpInput({ ...VALID_INPUT, artifactPath: "artifacts", commands: [{ method: "HeapProfiler.takeHeapSnapshot", artifact: "heap.heapsnapshot" }] });
    assert.equal(ok.error, undefined);
    assert.equal(ok.value.artifactPath, "artifacts");
    assert.equal(ok.value.commands[0].artifact, "heap.heapsnapshot");
    for (const bad of ["nested/heap.heapsnapshot", "../escape", "..", "", 7]) {
        const result = normalizeCdpInput({ ...VALID_INPUT, commands: [{ method: "HeapProfiler.takeHeapSnapshot", artifact: bad }] });
        assert.ok(result.error, `expected an artifact rejection for ${JSON.stringify(bad) ?? String(bad)}`);
    }
    const badPath = normalizeCdpInput({ ...VALID_INPUT, artifactPath: "../out" });
    assert.match(badPath.error ?? "", /cdp\.artifactPath/);
});

// ---------------------------------------------------------------------------
group("compileAgentBrowserCdp returns exactly kind, commands, session?, artifactPath?, timeoutMs", () => {
    const minimal = compileAgentBrowserCdp(normalizeCdpInput(VALID_INPUT).value);
    assert.deepEqual(Object.keys(minimal).sort(), ["commands", "kind", "timeoutMs"]);
    assert.equal(minimal.kind, "cdp");
    assert.equal(minimal.timeoutMs, CDP_DEFAULT_TIMEOUT_MS);

    const full = compileAgentBrowserCdp(normalizeCdpInput({ ...VALID_INPUT, session: "ultron1", artifactPath: "artifacts", timeoutMs: 5000 }).value);
    assert.deepEqual(Object.keys(full).sort(), ["artifactPath", "commands", "kind", "session", "timeoutMs"]);
    assert.equal(full.session, "ultron1");
    assert.equal(full.artifactPath, "artifacts");
    assert.equal(full.timeoutMs, 5000);
    assert.equal(full.kind, "cdp");
});

group("compileAgentBrowserCdp is a pure mapping: no I/O, no clock, no WebSocket in the module", () => {
    // Scan code, not prose: the header comment names these modules on purpose (explaining what this
    // module deliberately does NOT do), so comments are stripped before the I/O check.
    const source = readFileSync(fileURLToPath(new URL("../dist/extensions/agent-browser/lib/input-modes/cdp.js", import.meta.url)), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/^\s*\/\/.*$/, ""))
        .join("\n");
    for (const forbidden of ["node:fs", "node:net", "node:child_process", "node:http", "WebSocket", "Date.now", "performance.now"]) {
        assert.equal(source.includes(forbidden), false, `cdp.js must not reference ${forbidden}`);
    }
    // Two compiles of the same plan are structurally identical (the compile is a pure mapping, so it
    // neither reorders nor re-derives anything). No defensive copy of `commands` is made: the host
    // handler only iterates it, and copying would be a promise nothing depends on.
    const plan = normalizeCdpInput(VALID_INPUT).value;
    const first = compileAgentBrowserCdp(plan);
    const second = compileAgentBrowserCdp(plan);
    assert.deepEqual(first, second);
    assert.deepEqual(first.commands, [VALID_COMMAND]);
});

// ---------------------------------------------------------------------------
group("positive case: the plan.md example compiles without throwing", () => {
    const example = {
        session: "ultron1",
        commands: [
            { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } },
            { method: "HeapProfiler.takeHeapSnapshot", params: {}, artifact: "heap.heapsnapshot" },
        ],
        artifactPath: "artifacts",
        timeoutMs: 60000,
    };
    const normalized = normalizeCdpInput(example);
    assert.equal(normalized.error, undefined);
    const compiled = compileAgentBrowserCdp(normalized.value);
    assert.equal(compiled.kind, "cdp");
    assert.equal(compiled.commands.length, 2);
    assert.equal(compiled.commands[0].method, "Runtime.evaluate");
    assert.deepEqual(compiled.commands[0].params, { expression: "document.title", returnByValue: true });
    assert.equal(compiled.commands[1].artifact, "heap.heapsnapshot");
    assert.equal(compiled.session, "ultron1");
    assert.equal(compiled.artifactPath, "artifacts");
    assert.equal(compiled.timeoutMs, 60000);
    // Multi-command sequencing is Lane B's job; here we only pin that order is preserved.
    assert.deepEqual(compiled.commands.map((command) => command.method), ["Runtime.evaluate", "HeapProfiler.takeHeapSnapshot"]);
});

console.log(`wave14-cdp-input-mode: all assertions passed (${groups} assertion groups)`);
