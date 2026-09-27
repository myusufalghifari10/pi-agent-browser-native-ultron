// wave4 N-group: agent-ergonomics live-sweep fixes.
// W-N1: providers stringify numeric companion params (documented P28 rationale for args/stdin);
// the same stringification hit timeoutMs, so a valid integer arrived as "20000" and failed
// validation with "timeoutMs must be a positive integer when provided" (reproduced live in the
// AWS Skill Builder session before the fix). The fix de-stringifies a finite numeric string in
// prepareArguments; non-numeric strings must keep failing validation unchanged.
import assert from "node:assert/strict";

import extensionFactory from "../dist/extensions/agent-browser/index.js";
import { resolveExtinctTargetFollowTab } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/session-state.js";
import { resolveAgentBrowserInput } from "../dist/extensions/agent-browser/lib/orchestration/input-plan.js";
import { parseBatchStdinJsonArray } from "../dist/extensions/agent-browser/lib/orchestration/batch-stdin.js";
import { buildRestoreBatchRows } from "../dist/extensions/agent-browser/lib/vault/checkpoint-store.js";

let TOOL;
extensionFactory({
    registerTool(tool) { TOOL = tool; },
    on() { },
});

const prep = TOOL.prepareArguments;

// 1. numeric string → number (the AWS failure case)
assert.deepEqual(prep({ args: ["open", "https://example.com"], timeoutMs: "20000" }), { args: ["open", "https://example.com"], timeoutMs: 20000 }, "stringified integer timeoutMs is de-stringified");
// 2. already-numeric → untouched
assert.deepEqual(prep({ args: [], timeoutMs: 20000 }).timeoutMs, 20000, "numeric timeoutMs passes through");
// 3. non-numeric string → untouched so validation still rejects it with the real error
assert.equal(prep({ args: [], timeoutMs: "soon" }).timeoutMs, "soon", "non-numeric timeoutMs string is left for validation");
// 4. whitespace-numeric string → de-stringified
assert.equal(prep({ args: [], timeoutMs: " 45000 " }).timeoutMs, 45000, "whitespace-padded numeric string is de-stringified");
// 5. P28 originals intact: JSON-string args array still de-stringifies
assert.deepEqual(prep({ args: '["get","title"]' }).args, ["get", "title"], "args JSON-string de-stringify unchanged");
// 6. P28 originals intact: JSON-string mode object still de-stringifies
assert.deepEqual(prep({ checkpoint: '{"action":"list"}' }).checkpoint, { action: "list" }, "checkpoint JSON-string de-stringify unchanged");
// 7. absent timeoutMs → key stays absent (no spurious undefined)
assert.equal("timeoutMs" in prep({ args: [] }), false, "no spurious timeoutMs key");

// --- W-N3: extinct tracked target → follow the active page ---------------------------------------
const tabsLive = [
    { active: false, label: "t1", tabId: "AAA", url: "https://old.example.com/page" },
    { active: true, label: "t2", tabId: "BBB", url: "https://new.example.com/learn" },
];
const followed = resolveExtinctTargetFollowTab(tabsLive);
assert.deepEqual(
    { selectedTab: followed?.selectedTab, selectionKind: followed?.selectionKind, targetUrl: followed?.targetUrl, extinctTargetFollowed: followed?.extinctTargetFollowed },
    { selectedTab: "BBB", selectionKind: "tabId", targetUrl: "https://new.example.com/learn", extinctTargetFollowed: true },
    "extinct target follows the active tab by tabId",
);
assert.equal(resolveExtinctTargetFollowTab([{ active: true, label: "t1", url: "about:blank" }]), undefined, "about:blank active tab is never followed");
assert.equal(resolveExtinctTargetFollowTab([{ active: false, label: "t1", url: "https://x.example.com" }]), undefined, "no active tab → undefined (drift error stays)");
assert.equal(resolveExtinctTargetFollowTab([{ active: true, label: "t1" }]), undefined, "active tab without a URL → undefined");
assert.equal(resolveExtinctTargetFollowTab(undefined), undefined, "missing tab list → undefined");

// --- W-N2: `tab select` grammar dead end teaches the real grammar --------------------------------
const selectInput = resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params: { args: ["tab", "select", "t1"] } });
assert.equal(selectInput.status, "invalid", "tab select is rejected pre-spawn");
assert.match(selectInput.validationError ?? "", /no `tab select` subcommand/, "rejection names the real grammar");
assert.match(selectInput.validationError ?? "", /\["tab","t1"\]/, "rejection shows a concrete working call");
const selectBatch = resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params: { args: ["batch", "--bail"], stdin: JSON.stringify([["click", "@e1"], ["tab", "select", "t1"]]) } });
assert.equal(selectBatch.status, "invalid", "tab select as a batch step is rejected too");
assert.match(selectBatch.validationError ?? "", /batch step 2/, "batch rejection names the step");
// the working grammar still passes validation
const tabLabelInput = resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params: { args: ["tab", "t1"] } });
assert.notEqual(tabLabelInput.status, "invalid", "bare `tab <label>` stays valid");

// --- W-A1: batch stdin survives P28 de-stringify (array form) ------------------------------------
const stepsFromString = parseBatchStdinJsonArray('[["click","@e1"],["get","url"]]');
assert.deepEqual(stepsFromString.steps, [["click", "@e1"], ["get", "url"]], "documented JSON-string stdin still parses");
const stepsFromArray = parseBatchStdinJsonArray([["click", "@e1"], ["get", "url"]]);
assert.deepEqual(stepsFromArray.steps, [["click", "@e1"], ["get", "url"]], "P28-de-stringified array stdin parses instead of comma-coercing");
assert.match(parseBatchStdinJsonArray("click,x").error ?? "", /could not be parsed as JSON/, "garbage string still fails with the parse error");
assert.match(parseBatchStdinJsonArray({ nope: true }).error ?? "", /must be a JSON array/, "non-array non-string still fails with the shape error");

// full pipeline: batch with array stdin passes argv validation end-to-end
const batchInput = resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params: { args: ["batch"], stdin: [["get", "title"], ["snapshot"]] } });
assert.notEqual(batchInput.status, "invalid", "array-stdin batch passes the validation chain");

// --- W-V1: restore batch gets get url (compile) + open target (gate injection) -------------------
const compiledRows = JSON.parse(JSON.stringify([["state", "load", "/tmp/x.state"], ["get", "url"], ["snapshot"]]));
const injected = buildRestoreBatchRows(compiledRows, "https://the-internet.herokuapp.com");
assert.deepEqual(injected, [["state", "load", "/tmp/x.state"], ["open", "https://the-internet.herokuapp.com"], ["get", "url"], ["snapshot"]], "gate injection places open after load, before get url+snapshot");
assert.equal(buildRestoreBatchRows([["snapshot"]], "https://x.example.com"), undefined, "no load row → no injection");
assert.equal(buildRestoreBatchRows([["state", "load", "/tmp/x"], ["snapshot"]], ""), undefined, "empty target → no injection");
console.log("OK: 19 wave4 checks passed (W-N1 timeoutMs + P28 originals + W-N3 extinct-target follow + W-N2 tab select teaching + W-A1 batch array stdin + W-V1 restore rows).");
