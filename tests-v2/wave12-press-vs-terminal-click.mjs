// wave12: a click that starts pressing is not a click that landed.
//
// The click-dispatch probe counted EVERY trusted event that reached the target
// equally, so a pointerdown alone satisfied it. That made the probe blind to the
// single most common real-browser false success: the element is re-rendered or
// moved between mousedown and mouseup, the click never completes, and the app
// does nothing - while upstream still reports "Clicked: @e2".
//
// Proven live on 2026-09-30 against a purpose-built fixture (node replaces
// itself on mousedown; hover shifts the target 120px): upstream reported
// success, the page log stayed "not clicked", and the probe reported
// "native-event-observed" because pointerdown had reached the original node.
//
// This file pins the terminal-event rule. It asserts the SCRIPT TEXT (the probe
// runs in the page, so the predicate is only reachable as source) plus the
// collector's status routing, so a future edit cannot quietly restore the bug.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = new URL("../dist/extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.js", import.meta.url);
const source = readFileSync(file, "utf8");

const grab = (name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.indexOf("\nfunction ", start + 1);
    return source.slice(start, end === -1 ? undefined : end);
};
const checkScript = grab("buildClickDispatchProbeCheckScript");
const collector = grab("collectClickDispatchDiagnostic");

// --- the probe must distinguish press from terminal events -------------------
assert.match(checkScript, /PRESS_EVENTS\s*=\s*new Set\(\["pointerdown",\s*"mousedown"\]\)/,
    "probe must define exactly pointerdown/mousedown as press events");
assert.match(checkScript, /terminalEventCount\s*=\s*matched\.filter\(\(event\)\s*=>\s*!PRESS_EVENTS\.has\(event\.type\)\)\.length/,
    "terminal events must be counted as the non-press matched events");
assert.match(checkScript, /pressEventCount\s*=\s*matched\.length\s*-\s*terminalEventCount/,
    "press count must be the remainder, not a second independent count");

// --- the regression itself: pointerdown alone must NOT clear a miss ----------
assert.doesNotMatch(checkScript, /if \(nativeEventCount > 0\) return finish\(\{ status: "native-event-observed"/,
    "the old bug: nativeEventCount (which includes pointerdown) must no longer decide the observed verdict");
assert.match(checkScript, /if \(terminalEventCount > 0\) return finish\(\{ status: "native-event-observed"/,
    "only a terminal event may clear a miss");
assert.match(checkScript, /if \(pressEventCount > 0\) return finish\(\{ status: "press-observed-click-missing"/,
    "press-without-terminal must be reported as its own miss status");
assert.match(checkScript, /return finish\(\{ status: "no-native-event-observed"/,
    "no event at all must keep the original no-native-event-observed status");

// --- the counts must travel back so the wrapper can explain the miss ----------
for (const field of ["nativeEventCount", "pressEventCount", "terminalEventCount"]) {
    assert.match(checkScript, new RegExp(`counts = \\{ nativeEventCount: matched\\.length, pressEventCount, terminalEventCount \\}`),
        "every finish() path must return the full count triple");
    assert.ok(checkScript.includes(`{ status: "probe-missing", nativeEventCount: 0, pressEventCount: 0, terminalEventCount: 0 }`),
        `probe-missing must report ${field} = 0 rather than undefined`);
}

// --- the collector must treat the new status as a miss ----------------------
assert.match(collector, /PRESS_ONLY_MISS\s*=\s*"press-observed-click-missing"/,
    "collector must name the new status once");
assert.match(collector, /status !== "no-native-event-observed" && status !== PRESS_ONLY_MISS\)\s*\n\s*return undefined;/,
    "the collector must return a diagnostic for BOTH miss statuses, and only those");
assert.match(collector, /reason: pressOnly \? "native-press-without-terminal-click-event" : "native-click-produced-no-target-dom-event"/,
    "the two misses need distinct machine-readable reasons");
assert.match(collector, /pressOnly: true/,
    "the press-only miss must be machine-flagged so callers can branch on it");
assert.match(collector, /re-rendered, replaced, or moved between press and release/,
    "the press-only summary must name the actual likely cause, not repeat the generic miss");

// --- behaviour preservation -------------------------------------------------
assert.match(collector, /const scrollContainer = getClickDispatchScrollContainerDiagnostic\(result\);/,
    "scroll-container diagnosis must still run");
assert.match(collector, /target: redactClickDispatchTarget\(options\.probe\.target\)/,
    "the target must still be redacted");
assert.match(collector, /wrapper does not replay clicks in-page/,
    "the no-auto-replay safety line must survive for the generic miss");
assert.doesNotMatch(collector, /\breplayClick|dispatchEvent\(new MouseEvent/,
    "the wrapper must never synthesise a click in-page");

// --- the probe still cannot fire inside a batch -----------------------------
assert.match(grab("getClickDispatchProbeTarget"), /commandTokens\[0\] !== "click"/,
    "guard preserved: only a top-level click can carry a probe");

console.log("wave12-press-vs-terminal-click: all assertions passed (press no longer counts as dispatch, both miss statuses routed, no auto-replay)");
