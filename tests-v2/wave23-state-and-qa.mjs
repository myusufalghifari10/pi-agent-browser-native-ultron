// wave23: the third and fourth reviewer lanes. Confirmed by running each one before fixing.
import assert from "node:assert/strict";
import { applyNetworkRouteRecords, buildNetworkRouteDiagnostics } from "../dist/extensions/agent-browser/lib/results/network-routes.js";
import { isBrowserIndependentRead, getExplicitReadUrl } from "../dist/extensions/agent-browser/lib/command-policy.js";

// --- malformed network route commands used to destroy all route state -------------------
const armed = applyNetworkRouteRecords(undefined, ["network", "route", "**/api/*"], true);
assert.equal(armed.length, 1, "a real route is armed");
// `!pattern` returned undefined, and the caller deletes the session's whole entry on undefined.
for (const bad of [["network", "route"], ["network", "unroute", ""], ["network", "unroute"], ["network", "route", "--abort"]]) {
    const after = applyNetworkRouteRecords(armed, bad, true);
    assert.equal(after?.length, 1, `${JSON.stringify(bad)} must not erase the armed route`);
    assert.equal(after?.[0]?.pattern, "**/api/*", `${JSON.stringify(bad)} must leave the route armed`);
}
// The flag itself used to be persisted as a URL pattern.
assert.equal(applyNetworkRouteRecords(armed, ["network", "route", "--abort"], true).some((r) => r.pattern === "--abort"), false,
    "a flag must never be stored as a pattern");
// A genuine unroute still works, and clearing the last route still collapses to undefined.
assert.equal(applyNetworkRouteRecords(armed, ["network", "unroute", "**/api/*"], true), undefined,
    "unrouting the only real pattern still empties the table");
assert.deepEqual(applyNetworkRouteRecords(armed, ["network", "unroute", "**/other/*"], true), armed,
    "unrouting a pattern that is not armed is a no-op");
assert.equal(applyNetworkRouteRecords(armed, ["get", "url"], true), armed, "a non-route command never touches the table");
assert.equal(applyNetworkRouteRecords(armed, ["network", "route", "**/api/*"], false), armed, "a failed command never touches the table");
// The point of the whole table: diagnostics must still fire afterwards. Getting this to fire needs a
// row the diagnostic actually reasons about — an empty or 200 row yields undefined either way, which
// is how a broken table could pass a naive check. A status-less row is "pending" and a 500 is
// "unfulfilled"; both are shapes the wrapper reports.
const pending = { requests: [{ url: "https://x.com/api/items" }] };
const failed = { requests: [{ url: "https://x.com/api/items", status: 500 }] };
assert.ok(buildNetworkRouteDiagnostics(pending, armed), "sanity: an armed route does report a pending request");
for (const bad of [["network", "unroute"], ["network", "unroute", ""], ["network", "route"], ["network", "route", "--abort"]]) {
    const after = applyNetworkRouteRecords(armed, bad, true);
    assert.ok(buildNetworkRouteDiagnostics(pending, after), `${JSON.stringify(bad)} must leave route diagnostics firing`);
    assert.ok(buildNetworkRouteDiagnostics(failed, after), `${JSON.stringify(bad)} must leave unfulfilled diagnostics firing too`);
}

// --- a malformed `read` was classified as a browser-independent read ---------------------
// `null !== undefined` is true, so every invalid read was browser-independent: the exact opposite
// of the comment on that function, which says null "must not trigger page helpers". That skipped
// needsManagedSession's ownership check and page-target validation for a call already known malformed.
for (const bad of [["read", "--llms", "bogus", "https://example.com"], ["read", "--bogus", "https://x.com"],
                   ["read", "https://a.com", "https://b.com"], ["read", "--timeout", "0", "https://x.com"]]) {
    assert.equal(getExplicitReadUrl(bad), null, `${JSON.stringify(bad)} is invalid native syntax`);
    assert.equal(isBrowserIndependentRead(bad), false, `${JSON.stringify(bad)} must not be browser-independent`);
    assert.equal(isBrowserIndependentRead(bad), isBrowserIndependentRead(["get", "url"]),
        `${JSON.stringify(bad)} must classify exactly like a command that is not a read at all`);
}
assert.equal(isBrowserIndependentRead(["read", "--llms", "full", "https://example.com"]), true, "a valid read is still browser-independent");
assert.equal(isBrowserIndependentRead(["batch", "--bail"], '[["read","--llms","full","https://a.com"]]'), true, "a batch of valid reads still is");
assert.equal(isBrowserIndependentRead(["batch", "--bail"], '[["read","--llms","full","https://a.com"],["read","--bogus","https://b.com"]]'), false,
    "one malformed step disqualifies the batch, since a partial browser-independent read would skip the guard for the rest");
assert.equal(isBrowserIndependentRead(["read", "https://example.com"]), true, "a plain read with no flags still is");

console.log("wave23-state-and-qa: all assertions passed (malformed route commands never destroy state, a malformed read is never browser-independent)");

// --- the diagnostics dedup buffer outlived the browser it belonged to --------------------
// Structural, and honestly labelled as such: process-output.js is a large module whose close path
// cannot be driven in isolation, so this asserts the call exists on the close branch rather than
// executing it. The fix was invisible to the suite before this assertion existed, which is why the
// sabotage below (deleting the line) has to fail for the coverage to be real.
import { readFileSync } from "node:fs";
const processOutput = readFileSync(new URL("../dist/extensions/agent-browser/lib/orchestration/browser-run/process-output.js", import.meta.url), "utf8");
// The close branch clears every other piece of per-session state; the dedup buffer was the one left
// behind, and resetDiagnosticsBufferState (which clears all of them) had zero callers anywhere.
const closeBranch = processOutput.slice(processOutput.indexOf("if (sessionClosed) {"));
assert.ok(closeBranch.length > 0, "the close branch must exist");
assert.match(closeBranch, /diagnosticsBufferBySession\.delete\(sessionStateKey\)/,
    "closing a session must drop its dedup buffer, or a reopened browser's rows read as already-reported");
for (const alsoCleared of ["attachedSessionKeys.delete", "networkRoutesBySession.delete", "sessionPageState.clearSession"]) {
    assert.match(closeBranch, new RegExp(alsoCleared.replace(".", "\\.")),
        `${alsoCleared} is cleared on close and the dedup buffer must be handled in the same place`);
}
// The whole-map variant is a real function that nothing called; it must not be the only path again.
assert.match(processOutput, /export function resetDiagnosticsBufferState/, "the module-level reset still exists for full teardown");
assert.ok(!/resetDiagnosticsBufferState\(\)[^;]*;/.test(processOutput.replace(/export function resetDiagnosticsBufferState/, "")),
    "resetDiagnosticsBufferState is the full-map escape hatch; the per-session close path must delete its own key instead of relying on it");
