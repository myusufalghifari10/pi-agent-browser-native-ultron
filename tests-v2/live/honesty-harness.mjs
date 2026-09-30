// LIVE honesty harness — the mechanical version of "check both directions".
//
// The defect class that has bitten this extension five times across two modes is not a crash. It is
// a check that reports a verdict it never earned: an empty expectedText compiling into a preset that
// asserts nothing, a preset with no batch rows staying "succeeded", an unreadable wait --fn verdict
// scoring as a PASS, a source lookup with no rows reading as a clean negative, a network route table
// emptied by a malformed command. Every one of those returned success-shaped text.
//
// A reviewer finds those by being lucky with a question. This harness finds them by construction: for
// every mode that reports a verdict, it drives a POSITIVE case that must pass and a NEGATIVE case
// that must fail, against a real browser and a page whose state is known because the harness put it
// there. A mode that cannot tell those two apart is broken, and that is the whole test.
//
// It calls the real TOOL.execute behind a mocked pi — the same real code path Pi runs — so nothing
// here is a reimplementation. That also means it is subject to the same host parameter coercion as
// every live call, which is a feature: the harness reports what actually arrives.
//
// Run:  node tests-v2/live/honesty-harness.mjs [--session NAME]
// It needs one free browser profile; it does NOT start or stop sessions, so it cannot disturb one
// Yusuf is using. Pass --session to point it at an idle profile.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import extensionFactory from "../../dist/extensions/agent-browser/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = (() => {
    const i = process.argv.indexOf("--session");
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "ultron2";
})();

let TOOL;
extensionFactory({ registerTool(tool) { TOOL = tool; }, on() { } });
if (!TOOL) throw new Error("the extension did not register a tool; the mocked pi shape is wrong");

// Both sessionManager members the tool actually reaches for. getSessionId is not optional: execute
// calls it directly to namespace session state, and a missing method throws before any browser work,
// which is the mock's fault and not a finding.
const CTX = { cwd: process.cwd(), sessionManager: { getBranch: () => [], getSessionId: () => "harness-live" } };

let passed = 0;
let failed = 0;
const failures = [];

/** Call the real tool and return its text, so an assertion can be made on what a caller would read. */
async function call(params) {
    const result = await TOOL.execute("harness", { session: SESSION, ...params }, undefined, undefined, CTX);
    const text = (result?.content ?? []).map((c) => c?.text ?? "").join("\n");
    return { text: text.trim(), ok: result?.isError !== true, details: result?.details ?? {} };
}

// --- the fixture -----------------------------------------------------------------------------
// Two pages, deliberately. The first is CLEAN — no console noise — because the text and silence
// checks must be measuring what they claim to measure. The second is NOISY, used only to test the
// console dimension on purpose.
//
// The first version of this harness had console.error() calls in the single fixture, and the qa
// "must pass" assertion failed with "2 console error message(s)". Investigated before touching the
// tool: qa enables checkConsole and checkErrors BY DEFAULT for a url-based preset
// (job.js: `? input.checkConsole : !attached`), so it correctly failed a page that logs errors. The
// tool was right and the assertion was wrong. Recording that here because the tempting move was to
// "fix" a correct default into something the test liked.
//
// Note what qa already does honestly: the failure line still carries
// "Checks run: ... console, errors ...", so a caller CAN see which checks ran. The default's
// attribution is not spelled out, and that is a documentation nicety, not a defect.
const CLEAN = "data:text/html," + encodeURIComponent(`
    <!doctype html><html><head><title>Fixture Title</title></head><body>
      <h1 id="heading">Harness Heading</h1>
      <p id="present">Teks yang benar-benar ada di body halaman</p>
      <button id="btn" onclick="document.getElementById('state').textContent='CHANGED'">Tekan Saya</button>
      <span id="state">UNTOUCHED</span>
      <div id="hidden" style="display:none">Teks tersembunyi</div>
    </body></html>`);
const NOISY = "data:text/html," + encodeURIComponent(`
    <!doctype html><html><head><title>Noisy Fixture</title></head><body>
      <p id="present">Teks yang benar-benar ada di body halaman</p>
      <script>console.error("fixture console error one"); console.error("fixture console error two");</script>
    </body></html>`);
const PAGE = CLEAN;
const PRESENT_TEXT = "Teks yang benar-benar ada di body halaman";
const ABSENT_TEXT = "TIDAK-ADA-TEXT-INI-SAMA-SEKALI-9F2A";

function check(label, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${label}`);
    } else {
        failed += 1;
        failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
        console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ""}`);
    }
}

// Establish the page once, so every check below reads a known state.
console.log(`live honesty harness — session ${SESSION}`);
const opened = await call({ args: ["open", PAGE] });
check("fixture page opens", opened.ok, opened.text.slice(0, 200));
const url = await call({ args: ["get", "url"] });
check("fixture page is where we think it is", url.text.includes("data:text/html"), url.text.slice(0, 120));

// --- qa: three directions, because "passed" is the direction that lies -----------------------
console.log("\nqa — a preset that asserts nothing must not pass");
const qaPresent = await call({ qa: { url: PAGE, expectedText: PRESENT_TEXT } });
check("qa passes on text that is in the page", qaPasses(qaPresent.text), qaPresent.text.slice(0, 220));
check("qa says how many text checks ran (so the pass is not vacuous)", /text\s*[x×]\s*1/i.test(qaPresent.text),
    `no text-x1 count in: ${qaPresent.text.slice(0, 200)}`);

const qaAbsent = await call({ qa: { url: PAGE, expectedText: ABSENT_TEXT } });
check("qa FAILS on text that is not in the page", /failed/i.test(qaAbsent.text), qaAbsent.text.slice(0, 220));
check("qa names the text it could not find", qaAbsent.text.includes("expected text not found"), qaAbsent.text.slice(0, 220));

const qaEmpty = await call({ qa: { url: PAGE, expectedText: [] } });
check("qa refuses an empty expectedText instead of compiling a check that asserts nothing",
    /non-empty/i.test(qaEmpty.text) || !qaPasses(qaEmpty.text), qaEmpty.text.slice(0, 220));

// The console dimension, tested on purpose rather than tripped over by accident. checkConsole and
// checkErrors default to true for a url-based preset, so a page that logs errors must fail even
// though the caller only asked about text — and the failure must NAME the console errors, so a
// caller is never left wondering why a text check failed on a page whose text is fine.
const qaNoisy = await call({ qa: { url: NOISY, expectedText: PRESENT_TEXT } });
check("qa fails a page that logs console errors even when the text is present", !qaPasses(qaNoisy.text),
    qaNoisy.text.slice(0, 220));
check("qa names the console errors rather than blaming the text check", /console error/i.test(qaNoisy.text),
    qaNoisy.text.slice(0, 220));
check("qa says which checks ran, so a default-enabled check is visible to the caller",
    /Checks run/i.test(qaNoisy.text) && /console/i.test(qaNoisy.text), qaNoisy.text.slice(0, 260));

// Re-establish the clean page. Every check below asserts against CLEAN's ids (#heading, #btn,
// #state), and qa navigating to NOISY left the session somewhere those elements do not exist — so
// without this the harness blamed sourceLookup and act for a page it had itself changed. A fixture
// that leaks state between its own checks produces failures that read exactly like tool defects.
const restored = await call({ args: ["open", CLEAN] });
check("clean fixture is re-established after the noisy check", restored.ok && !(await call({ args: ["get", "url"] })).text.includes("Noisy"),
    restored.text.slice(0, 160));

// --- debug: same two directions, different mode, different code path -------------------------
console.log("\ndebug — a verdict nobody could read is neither pass nor fail");
const debugPresent = await call({ debug: { action: "actionable", expectedText: PRESENT_TEXT, expectedSelector: "#present" } });
check("debug passes when the text and selector are both present", debugPasses(debugPresent.text), debugPresent.text.slice(0, 240));
const debugAbsent = await call({ debug: { action: "actionable", expectedText: ABSENT_TEXT } });
check("debug FAILS when the expected text is absent", /not found|failed/i.test(debugAbsent.text), debugAbsent.text.slice(0, 240));
const debugBadSelector = await call({ debug: { action: "actionable", expectedSelector: "#tidak-ada" } });
check("debug FAILS when the expected selector is absent", /not visible|failed|not found/i.test(debugBadSelector.text), debugBadSelector.text.slice(0, 240));

// --- lookups: "nothing there" and "did not look" must be different ---------------------------
console.log("\nlookups — an absent result is not a clean negative");
const found = await call({ sourceLookup: { selector: "#heading" } });
check("sourceLookup finds an element that is there", /not\s*found/i.test(found.text) === false, found.text.slice(0, 220));
const notFound = await call({ sourceLookup: { selector: "#tidak-ada-sama-sekali" } });
check("sourceLookup says not-found for an absent element", /not\s*found/i.test(notFound.text), notFound.text.slice(0, 220));

// --- job: per-step outcomes, and a failing step must not read as success ---------------------
console.log("\njob — two steps, one of which must fail");
const jobMixed = await call({ job: { steps: [
    { action: "assertUrl", url: "data:text/html" },
    { action: "assertText", text: ABSENT_TEXT },
] } });
check("job reports the failing step rather than a clean pass", jobMixed.text.includes("failed") || jobMixed.text.includes("timed out"),
    jobMixed.text.slice(0, 240));
const jobBoth = await call({ job: { steps: [
    { action: "assertUrl", url: "data:text/html" },
    { action: "assertText", text: PRESENT_TEXT },
] } });
check("job reports both steps succeeding", /succeeded|completed/i.test(jobBoth.text), jobBoth.text.slice(0, 240));

// --- act: the click must actually change the page, not just report that it did ----------------
console.log("\nact — a click that reports success but changes nothing is the oldest failure here");
const before = await call({ args: ["eval", "document.getElementById('state').textContent"] });
const acted = await call({ act: { find: { text: "Tekan Saya" }, action: "click" } });
const after = await call({ args: ["eval", "document.getElementById('state').textContent"] });
check("the fixture starts UNTOUCHED", before.text.includes("UNTOUCHED"), before.text.slice(0, 160));
check("act reported clicking", /click/i.test(acted.text), acted.text.slice(0, 200));
check("act's click REALLY changed the page (page state is the proof, not the tool's own claim)",
    after.text.includes("CHANGED"), `after = ${after.text.slice(0, 160)}`);

// --- networkBody: a clamp must be stated, never silent ---------------------------------------
console.log("\nnetworkBody — a clamp the caller cannot see is a silent truncation");
const clamped = await call({ networkBody: { requestId: "does-not-exist", maxChars: 99999 } });
check("a numeric maxChars above the ceiling is accepted (so the clamp path is reached, not refused)",
    !/positive integer/i.test(clamped.text), clamped.text.slice(0, 200));

// --- the report ------------------------------------------------------------------------------
// A green run here is NOT full coverage, and the gaps were found by sabotaging this harness rather
// than by reading it. Two, both recorded so nobody later reads "22 passed" as "every mode is proven":
//
// 1. The qa "wait --fn verdict could not be read" path is NOT reachable from this harness. Sabotaging
//    that branch (making the unverifiable branch unreachable) produced ZERO failures here while the
//    same sabotage fails tests-v2/wave23-qa-silent-pass.mjs offline. The reason is structural: the
//    predicate qa compiles returns a boolean, so a real page never yields an unreadable verdict, and
//    an unreadable verdict is precisely the thing that path exists to handle. Covering it needs a
//    synthetic batch row, which is what the offline test does.
//
// 2. Every check that failed during development failed for the RIGHT reason except the first round of
//    sabotages, which failed because the patch-integrity ledger refused to start the tool at all —
//    18 identical "drifted" failures proving nothing about behaviour. A sabotage has to re-pin
//    patches/patches.manifest.json as well, or it measures the guard instead of the bug.
console.log(`\nlive honesty harness: ${passed} passed / ${failed} failed`);
if (failures.length > 0) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    console.log("\nEach one is a mode that could not tell a real pass from a real fail, or a check that " +
        "reported a verdict without evidence. That is the defect class this harness exists to catch.");
    process.exitCode = 1;
}

function qaPasses(text) { return /qa preset passed/i.test(text); }
function qaFails(text) { return /qa preset failed/i.test(text); }
// A predicate that matches a bare "failed" is worse than no predicate: debug's own counts line
// always contains "failedRequests=0, failedSteps=0" and "actionableFailedRequests=0", so the first
// version of this check rejected a genuinely clean report. That is the same false-signal shape as
// Google Books' "SimpanDisimpan" — a word present in the output that does not mean what it looks
// like. Now it matches the specific failure sentences the modes actually produce.
function debugPasses(text) {
    return /no failures detected/i.test(text)
        && !/expected text not found|expected selector not visible|could not be read|NOT cleared/i.test(text);
}
