// wave10: role-less full-viewport scrim detector.
// Live evidence (Thumbtack, 2026-09-29): a scrim at position:fixed; z-index:200; 0,0,1536x734;
// pointer-events:auto; background rgba(0,0,0,0.5) with NO role blocked a click while the
// accessibility snapshot reported no dialog, so the dialog-gated overlay detector never ran and the
// agent wrongly blamed a sticky header. Diagnostic only — this lane never re-clicks anything.
import assert from "node:assert/strict";

import {
    buildOverlayBlockerNextActions,
    buildScrimBlockerDiagnosticFromProbe,
    buildScrimProbeScript,
    collectSnapshotOverlayBlockerDiagnostic,
    formatOverlayBlockerText,
    isFullViewportScrimBlocker,
} from "../dist/extensions/agent-browser/lib/orchestration/browser-run/diagnostics.js";
import { buildClickDispatchNextActions } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.js";

// Live-measured Thumbtack scrim row, verbatim proportions (1536x734 viewport).
const thumbtackScrim = {
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    coverage: { height: 1, width: 1 },
    index: 0,
    isTarget: false,
    pointerEvents: "auto",
    position: "fixed",
    tag: "div",
    zIndex: "200",
};

// 1. the pure predicate is reachable with no browser, no DOM, no session
assert.equal(typeof isFullViewportScrimBlocker, "function", "predicate is exported");
assert.equal(isFullViewportScrimBlocker(thumbtackScrim), true, "full-viewport fixed scrim with pointer-events auto is a scrim");

// 2. non-full-viewport page chrome: a sticky header 100% wide but 60px tall
assert.equal(
    isFullViewportScrimBlocker({ backgroundColor: "rgb(255, 255, 255)", coverage: { height: 0.082, width: 1 }, index: 0, isTarget: false, pointerEvents: "auto", position: "sticky", tag: "header", zIndex: "10" }),
    false,
    "a 100%-wide sticky header is not a scrim",
);
assert.equal(
    isFullViewportScrimBlocker({ coverage: { height: 1, width: 0.79 }, pointerEvents: "auto", position: "fixed", tag: "div" }),
    false,
    "79% viewport width is below the 80% threshold",
);
assert.equal(
    isFullViewportScrimBlocker({ coverage: { height: 0.79, width: 1 }, pointerEvents: "auto", position: "fixed", tag: "div" }),
    false,
    "79% viewport height is below the 80% threshold",
);
assert.equal(
    isFullViewportScrimBlocker({ coverage: { height: 1, width: 1 }, pointerEvents: "auto", position: "absolute", tag: "div" }),
    false,
    "position must be fixed",
);

// 3. pointer-events:none cannot block a click
assert.equal(
    isFullViewportScrimBlocker({ coverage: { height: 1, width: 1 }, pointerEvents: "none", position: "fixed", tag: "div" }),
    false,
    "a pointer-events:none full-viewport overlay is not a blocker",
);
assert.equal(isFullViewportScrimBlocker({ coverage: { height: 1, width: 1 }, position: "fixed", tag: "div" }), false, "unknown pointer-events is not assumed blocking");
assert.equal(isFullViewportScrimBlocker(undefined), false, "a missing descriptor is not a scrim");

// 4. the click target is never its own blocker
assert.equal(isFullViewportScrimBlocker({ ...thumbtackScrim, isTarget: true }), false, "the target element is never flagged");

// 5. the probe script is a pure string builder: elementsFromPoint at the target rect centre
const probeScript = buildScrimProbeScript({ kind: "selector", selector: "#pay" });
assert.equal(typeof probeScript, "string", "probe builder is browser-free");
assert.match(probeScript, /document\.elementsFromPoint\(cx, cy\)/, "probe uses elementsFromPoint");
assert.match(probeScript, /rect\.left \+ rect\.width \/ 2/, "probe runs at the target rect centre");
assert.match(probeScript, /getComputedStyle/, "probe reads computed style");
for (const field of ["backgroundColor", "pointerEvents", "position", "tag", "zIndex", "coverage"])
    assert.ok(probeScript.includes(field), `probe row carries ${field}`);
assert.match(buildScrimProbeScript({ kind: "xpath", selector: "//button" }), /document\.evaluate/, "xpath targets resolve through document.evaluate");
assert.match(buildScrimProbeScript({ kind: "ref", name: "Pay now", role: "button" }), /candidates\.length === 1/, "ref targets need one live role/name match");

// 6. probe result -> scrim detail, alongside (never replacing) the dialog path
const rows = [
    thumbtackScrim,
    { backgroundColor: "rgb(255, 255, 255)", coverage: { height: 0.5, width: 0.2 }, index: 1, isTarget: false, pointerEvents: "auto", position: "static", tag: "span", zIndex: "auto" },
    { backgroundColor: "rgb(0, 0, 0)", coverage: { height: 1, width: 1 }, index: 2, isTarget: true, pointerEvents: "auto", position: "fixed", tag: "main", zIndex: "1" },
];
const scrim = buildScrimBlockerDiagnosticFromProbe({ result: { rows, status: "ok" } });
assert.ok(scrim, "a role-less scrim over the target produces a diagnostic");
assert.equal(scrim.blockerKind, "scrim", "detail is tagged blockerKind scrim");
assert.deepEqual(scrim.coverage, { height: 1, width: 1 }, "measured coverage is reported");
assert.equal(scrim.blockers.length, 1, "only the real scrim is listed (the target itself is excluded)");
assert.equal(scrim.blockers[0].tag, "div", "the scrim row is preserved");
assert.deepEqual(scrim.candidates, [], "a scrim detail offers no close/dismiss click candidates");
assert.equal(buildScrimBlockerDiagnosticFromProbe({ result: { status: "ok", rows: rows.slice(1) } }), undefined, "no scrim means no diagnostic");
assert.equal(buildScrimBlockerDiagnosticFromProbe({ result: { status: "target-not-found" } }), undefined, "an unresolvable target means no diagnostic");
assert.equal(buildScrimBlockerDiagnosticFromProbe({ result: {} }), undefined, "a malformed probe result means no diagnostic");

// 7. an ordinary dialog still goes through the EXISTING path, shape unchanged
const dialogSnapshot = {
    refs: {
        e1: { name: "Checkout", role: "dialog" },
        e2: { name: "Close", role: "button" },
    },
};
const dialog = collectSnapshotOverlayBlockerDiagnostic(dialogSnapshot);
assert.ok(dialog, "a dialog snapshot still produces the existing diagnostic");
assert.deepEqual(Object.keys(dialog).sort(), ["candidates", "snapshot", "summary"], "existing dialog diagnostic shape is untouched");
assert.equal(dialog.candidates.length, 1, "existing close-candidate behaviour is unchanged");
assert.deepEqual(dialog.candidates[0].args, ["click", "@e2"], "existing candidate args are unchanged");
assert.match(formatOverlayBlockerText(dialog), /^Possible overlay blockers:\n- @e2 button "Close": /, "existing text format is unchanged");
assert.equal(collectSnapshotOverlayBlockerDiagnostic({ refs: { e1: { name: "Header", role: "banner" } } }), undefined, "ordinary chrome without a dialog still yields nothing");

// 8. a scrim's nextActions are INSPECT only — never a blind retry
const scrimActions = buildOverlayBlockerNextActions({ diagnostic: scrim, sessionName: "ultron1" });
assert.deepEqual(scrimActions.map((action) => action.id), ["inspect-overlay-state"], "a scrim offers exactly one inspect action");
assert.deepEqual(scrimActions[0].params.args, ["--session", "ultron1", "snapshot", "-i"], "the scrim action refreshes refs");
assert.ok(!JSON.stringify(scrimActions).includes("\"click\""), "no click action is suggested for a scrim");
const scrimText = formatOverlayBlockerText(scrim);
assert.match(scrimText, /position=fixed/, "scrim text names the blocking element");
assert.match(scrimText, /does not replay blocked clicks/, "scrim text forbids blind replay");

// 9. the click-dispatch miss path also carries the scrim, with an inspect-first action
const dispatchActions = buildClickDispatchNextActions({
    commandTokens: ["click", "@e2"],
    diagnostic: { scrimBlocker: scrim },
    sessionName: undefined,
});
assert.equal(dispatchActions[0].id, "inspect-click-dispatch-miss", "inspect stays first");
assert.equal(dispatchActions[1].id, "inspect-scrim-blocker-after-dispatch-miss", "the scrim gets its own inspect action");
assert.match(dispatchActions[1].reason, /100%x100% of the viewport/, "the scrim action reports the measured coverage");
const plainDispatchActions = buildClickDispatchNextActions({ commandTokens: ["click", "@e2"], diagnostic: { nativeEventCount: 0 }, sessionName: undefined });
assert.deepEqual(plainDispatchActions.map((action) => action.id), ["inspect-click-dispatch-miss", "retry-click-after-dispatch-miss"], "non-scrim click-dispatch nextActions are unchanged");

console.log("wave10-scrim-detector: all assertions passed");
