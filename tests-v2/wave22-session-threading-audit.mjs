// wave22: two modes accepted `session` and dropped it, so a report/lookup ran against the wrong tab.
//
//   debug        — the field was absent from the compiler entirely; argv was a bare ["batch","--bail"]
//   sourceLookup — the field was read by nobody; argv was a bare ["batch"]
//
// Both were found LIVE, not by reading code, and both fail in the most dangerous possible way: the
// run SUCCEEDS against the wrong tab and reports a clean result. A devtools report for the wrong
// page is worse than no report, because "0 console errors, 0 page errors" reads as a pass.
//
// This test is an AUDIT, not a spot check. Spot checks miss the next mode with the same defect, so
// the assertion is structural: every mode compiler that accepts a session must either name the flag
// in its own source or route through the shared helper that does.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import { compileAgentBrowserDebug } from "../dist/extensions/agent-browser/lib/input-modes/debug.js";
import { compileAgentBrowserSourceLookup } from "../dist/extensions/agent-browser/lib/input-modes/lookups.js";

// --- the two that were broken -------------------------------------------------------------
assert.deepEqual(compileAgentBrowserDebug({ action: "checkConsole", session: "ultron1" }).compiled.args,
    ["--session", "ultron1", "batch", "--bail"], "debug must thread session into argv");
assert.deepEqual(compileAgentBrowserSourceLookup({ selector: "#a", session: "ultron1" }).compiled.args,
    ["--session", "ultron1", "batch"], "sourceLookup must thread session into argv");

// --- the sessionless forms must not shift --------------------------------------------------
assert.deepEqual(compileAgentBrowserDebug({ action: "checkConsole" }).compiled.args, ["batch", "--bail"],
    "a debug call with no session must still compile to a bare [\"batch\",\"--bail\"]");
assert.deepEqual(compileAgentBrowserSourceLookup({ selector: "#a" }).compiled.args, ["batch"],
    "a lookup with no session must still compile to a bare [\"batch\"]");

// --- a bad session must be named, not ignored ----------------------------------------------
for (const [label, bad] of [["blank", "  "], ["non-string", 5]]) {
    assert.match(compileAgentBrowserDebug({ action: "checkConsole", session: bad }).error ?? "", /debug\.session/,
        `debug must reject a ${label} session by name`);
    assert.match(compileAgentBrowserSourceLookup({ selector: "#a", session: bad }).error ?? "", /sourceLookup\.session/,
        `sourceLookup must reject a ${label} session by name`);
}

// --- the audit itself ---------------------------------------------------------------------
// Enumerate the same way a reviewer would, so a NEW mode with the same defect fails this test.
//
// Scope matters, and getting it wrong produced a false positive on the first run: `cdp` declares a
// session and never names `--session` in its compiler, but it builds no argv at all — it is
// host-only and resolves the endpoint itself (`cdp-host/index.js:96` builds
// ["--session", session, "get", "cdp-url"]). A mode that never builds argv cannot drop a flag from
// it, so auditing it is meaningless noise. The population is exactly the compilers that CONSTRUCT
// argv, which is what the defect requires.
const MODES_DIR = new URL("../dist/extensions/agent-browser/lib/input-modes/", import.meta.url).pathname;
const NON_BROWSER_MODES = new Set(["params", "types", "shared"]);   // schema table, types, helpers
const off = [];
const skippedHostOnly = [];
for (const file of readdirSync(MODES_DIR).filter((f) => f.endsWith(".js"))) {
    const name = file.replace(/\.js$/, "");
    if (NON_BROWSER_MODES.has(name)) continue;
    const src = readFileSync(join(MODES_DIR, file), "utf8");
    const buildsArgv = /args: \[[\s\S]{0,200}?\]/.test(src);
    if (!buildsArgv) { skippedHostOnly.push(name); continue; }
    const declaresSession = /"session"/.test(src) && /input\.session|\{ session[,}]|session,/.test(src);
    if (!declaresSession) continue;
    // Either it builds `--session` itself, or it routes through the shared helper that does.
    const threads = src.includes('"--session"') || src.includes("withOptionalSessionArgs");
    if (!threads) off.push(name);
}
// The skip list must not grow silently: a mode that stops building argv stops being audited, which
// is exactly how a regression would hide here.
assert.ok(skippedHostOnly.length > 0, "the audit should still be finding modes to skip, not silently covering nothing");
assert.deepEqual(off, [],
    `these mode compilers accept a session but never reach argv — same defect as debug and sourceLookup: ${off.join(", ")}`);

console.log("wave22-session-threading-audit: all assertions passed (debug + sourceLookup thread session, sessionless forms unchanged, whole input-modes directory audited for the same defect)");
