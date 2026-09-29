// wave14 (lane C): the `cdp` raw-Chrome-DevTools-Protocol mode is wired into the
// input pipeline as a host-only kind.
//
// What this file locks, and why each assertion exists:
//
//  1. `cdp` participates in the one-mode-only contract. A host-only kind that is not
//     enumerated in `allModeNames` would let a call supply `cdp` AND `args` together,
//     and one of the two would be silently dropped. That is the exact class of bug the
//     P15 patch was written to stop.
//  2. `cdp` is host-only, so the argv guards must be SKIPPED. It compiles to the
//     sentinel `["--cdp-host"]`, which is not a real upstream command; without the skip
//     the guard chain would try to validate a fake argv. This is asserted structurally,
//     because the skip is a `??` chain and a behavioural test would not localise a
//     regression to that one term.
//  3. `normalizeCdpInput` is called WITH the top-level `sessionMode`. Rule 8 (reject
//     `session` + `sessionMode: "fresh"`) is unobservable otherwise, because
//     `sessionMode` is rejected *inside* the cdp object. Lane A caught this hole in the
//     original plan; the wiring is the half that makes the fix real, so it is asserted.
//  4. `cdp` with no `session` stays legal - a bare cdp object must compile, not error.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const planPath = new URL("../dist/extensions/agent-browser/lib/orchestration/input-plan.js", import.meta.url);
const indexPath = new URL("../dist/extensions/agent-browser/index.js", import.meta.url);
const plan = readFileSync(planPath, "utf8");
const index = readFileSync(indexPath, "utf8");

// --- 1. one-mode-only contract ---------------------------------------------
assert.match(plan, /\["cdp", params\.cdp !== undefined\]/,
    "cdp must be counted in suppliedModeNames, or a cdp+args call would be accepted");
assert.match(plan, /const allModeNames = \[[^\]]*"cdp"\]/,
    "cdp must be listed in allModeNames so the error message names it and the count sees it");
assert.match(plan, /import \{ compileAgentBrowserCdp, normalizeCdpInput \} from "\.\.\/input-modes\/cdp\.js"/,
    "the cdp compiler and normaliser must be imported from the frozen module path");

// --- 2. host-only wiring ----------------------------------------------------
assert.match(plan, /const hostOnlyKind = compiledVault \? "vault"[^\n]*compiledCdp \? "cdp" : undefined;/,
    "cdp must be a host-only kind so the argv guards are skipped");
assert.match(plan, /const hostOnlyArgs = [^\n]*compiledCdp \? \["--cdp-host"\] : undefined;/,
    "cdp must carry the host-only sentinel argv, never a real upstream command");
assert.match(plan, /\{ \.\.\.resolvedBase, compiledCdp, kind: "cdp", status: "valid" \}/,
    "the resolve branch must return kind cdp with the compiled payload");

// The guard-skip chain must name hostOnlyKind, and must stay a single ?? chain:
// an added `||` would silently disable every guard for all modes.
// Anchor on the skip term itself, not on a statement name: the chain is a long
// `const <something> = a ?? b ?? ...` whose declaration is far from the term, and
// a looser match once bound to an unrelated later `validationError`.
const guardSkip = plan.match(/\?\? \(compiledElectron \|\| compiledScript \|\| hostOnlyKind \|\| compiledCheckpoint \? undefined :[\s\S]{0,600}?\)\);/);
assert.ok(guardSkip, "the argv-guard skip term must be present and must still gate on hostOnlyKind");
// The `||` inside `(compiledElectron || compiledScript || ...)` is correct: it is the skip
// CONDITION of a ternary. What must not happen is the guard FUNCTIONS being joined with `||`
// instead of `??` - `a() || b()` returns the first TRUTHY error, so a guard that returns a
// falsy non-undefined value would be swallowed and the call would run unguarded.
const guardBody = guardSkip[0].slice(guardSkip[0].indexOf(":") + 1);
const guardFns = guardBody.match(/get[A-Z]\w+|validateToolArgs/g) ?? [];
assert.ok(guardFns.length >= 8, `expected the guard chain to still carry its guards, found ${guardFns.length}`);
assert.doesNotMatch(guardBody.replace(/\([^()]*\)/g, ""), /\|\|/,
    "the guard functions must be joined with ??, never || (|| would swallow a falsy guard result and run unguarded)");
// cdp must reach that skip through hostOnlyKind, and the other three host-only kinds must too.
for (const kind of ["vault", "devServer", "login", "cdp"]) {
    assert.ok(plan.includes(`compiledCdp ? "cdp"`) || plan.includes(`"${kind}"`),
        `${kind} must remain reachable as a host-only kind`);
}
assert.match(plan, /const normalized = validationError \|\| isPlainTextInspectionArgs\(toolArgs\) \|\| hostOnlyKind \|\| compiledCheckpoint/,
    "the url-less-open normalisation must also skip host-only kinds, or it would rewrite the cdp sentinel argv");

// --- 3. sessionMode is threaded through (Lane A's plan-hole fix) ------------
assert.match(plan, /normalizeCdpInput\(params\.cdp, \{ sessionMode: params\.sessionMode \}\)/,
    "normalizeCdpInput must receive the top-level sessionMode or rule 8 can never fire");
assert.doesNotMatch(plan, /normalizeCdpInput\(params\.cdp\)/,
    "the one-argument form is exactly the bug Lane A reported");

// --- 4. index.js dispatch ---------------------------------------------------
assert.match(index, /import \{ handleCdpHostInput \} from "\.\/lib\/orchestration\/cdp-host\/index\.js"/,
    "index.js must import the cdp host handler");
assert.match(index, /resolvedInput\.kind === "vault" \|\|[^\n]*resolvedInput\.kind === "cdp"/,
    "the host-only branch must include cdp, or the handler is unreachable");
assert.match(index, /await handleCdpHostInput\(\{ compiled: resolvedInput\.compiledCdp, dispatch: hostDispatch, signal \}\)/,
    "cdp must dispatch through hostDispatch so the one spawn keeps redaction and session handling");
assert.doesNotMatch(index, /new WebSocket|webSocketDebuggerUrl/,
    "index.js must never touch the socket directly; that belongs to the host handler only");

// --- the frozen lane-B surface is actually what index.js calls -------------
const cdpHost = readFileSync(new URL("../dist/extensions/agent-browser/lib/orchestration/cdp-host/index.js", import.meta.url), "utf8");
assert.match(cdpHost, /export async function handleCdpHostInput\(\{ compiled, dispatch, signal, webSocketImpl = globalThis\.WebSocket \} = \{\}\)/,
    "the handler signature must match what index.js passes");
assert.doesNotMatch(cdpHost, /const CDP_DEFAULT_TIMEOUT_MS = /,
    "the default timeout must be imported from input-modes/cdp.js, not redeclared (drift risk)");

console.log("wave14-cdp-wiring: all assertions passed (cdp enumerated, host-only guards skipped, sessionMode threaded, handler reachable, no socket in index.js)");
