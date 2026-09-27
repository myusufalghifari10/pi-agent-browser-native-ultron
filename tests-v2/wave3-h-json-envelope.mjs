// wave3-H — offline verifier for the caller `--json` parseability composition envelope.
// Gap (wave2-C follow-up): wave2's redactParseableJsonText keeps the JSON lane parseable, but two
// later append paths in buildFinalAgentBrowserToolResult still break JSON.parse on content[0].text:
// (1) the electron-launch prose wrap, (2) the P13 revealSecrets notice append. Fix: when the caller
// requested --json AND the payload parsed as JSON, surfaced prose is composed into a parseable
// envelope { result: <parsed payload>, appended: ["<redacted prose block>", ...] } — appended blocks
// pass redactSensitiveText, except P13's intentionally revealed header lines which are layered on
// top verbatim (reveal-after-redaction ordering; the P12 vault scrub still runs last). Zero appends
// → byte-identical wave2 output. Non-JSON lanes: byte-identical. pi-tool-rendering.js must still see
// the envelope as parseable JSON (isError patch adds no content rewrite).
// Run: node tests-v2/wave3-h-json-envelope.mjs
import assert from "node:assert/strict";
import { buildFinalAgentBrowserToolResult, buildRedactedPresentationContent, formatElectronLaunchText, redactExactSensitiveText, } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/final-result.js";
import { buildRevealSecretsWarning } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/reveal-secrets.js";
import { buildAgentBrowserToolResultPatch } from "../dist/extensions/agent-browser/lib/pi-tool-rendering.js";
import { redactSensitiveText } from "../dist/extensions/agent-browser/lib/runtime.js";

let checks = 0;
const step = () => {
    checks += 1;
};

const ELECTRON_TOKEN = "sk-electron-secret-token";
const REVEALED_TOKEN = "sk-live-revealed-token";
const electronRecord = { appName: `myapp Bearer ${ELECTRON_TOKEN}`, cleanupState: "launched", launchId: "el-1", port: 9222, sessionName: "electron-el-1" };
const electronLaunch = { targets: [{ id: "t1", title: "main", type: "page", url: "https://app.test/" }], version: "1.0" };
const reveal = { headers: ["authorization"], urlFilter: "/api/" };
const revealedHeaderLines = [`  → authorization: Bearer ${REVEALED_TOKEN}`];

function buildLaneContent({ data, succeeded = true, userRequestedJson }) {
    const presentation = { artifacts: undefined, batchFailure: undefined, batchSteps: undefined, content: [{ type: "text", text: "upstream row" }], data, fullOutputPath: undefined, fullOutputPaths: undefined, imagePath: undefined, imagePaths: undefined, nextActions: undefined, pageChangeSummary: undefined, recordingRecovery: undefined, readConfirmation: undefined, savedFile: undefined, savedFilePath: undefined, summary: "done" };
    const presentationEnvelope = { success: succeeded, data };
    const redactedContent = buildRedactedPresentationContent({ exactSensitiveValues: [], plainTextInspection: false, presentation, presentationEnvelope, succeeded, userRequestedJson, warningText: undefined });
    return { presentation, presentationEnvelope, redactedContent };
}

function baseOptions({ data, presentation, presentationEnvelope, redactedContent, succeeded = true, userRequestedJson, plainTextInspection = false, commandInfo = { command: "get", subcommand: "url" }, redactedArgs = ["get", "url"] }) {
    return {
        aboutBlankSessionMismatch: undefined,
        artifactCleanup: undefined,
        categoryDetails: { resultCategory: succeeded ? "success" : "failure", successCategory: undefined },
        clickDispatchDiagnostic: undefined,
        comboboxFocusDiagnostic: undefined,
        commandTokens: redactedArgs,
        compiledDebug: undefined,
        compiledLogin: undefined,
        compiledNetworkBody: undefined,
        compiledNetworkSourceLookup: undefined,
        compiledScript: undefined,
        compiledSemanticAction: undefined,
        compiledSettle: undefined,
        compiledVault: undefined,
        compatibilityWorkaround: undefined,
        currentRefSnapshot: undefined,
        currentRefSnapshotInvalidation: undefined,
        currentSessionTabTarget: undefined,
        currentSessionTabTargetUnknown: undefined,
        debugReport: undefined,
        electronBroadGetTextScopeDiagnostics: [],
        electronFailedConnectCleanup: undefined,
        electronHandoff: undefined,
        electronLaunch,
        electronLaunchRecord: undefined,
        electronLaunchRecords: new Map(),
        electronPostCommandHealth: undefined,
        electronProfileIsolationDetails: undefined,
        electronRefFreshnessDiagnostic: undefined,
        electronSessionMismatch: undefined,
        errorText: undefined,
        evalResultWarning: undefined,
        evalStdinHint: undefined,
        exactSensitiveValues: [],
        executionPlan: { commandInfo, managedSessionName: undefined, namespace: undefined, sessionName: undefined, startupScopedFlags: undefined, usedImplicitSession: false },
        fillVerificationDiagnostic: undefined,
        geolocationStubNote: undefined,
        headedLaunch: false,
        inspectionText: undefined,
        jobReceipts: undefined,
        managedSessionOutcome: undefined,
        managedSessionRestoreDisabled: undefined,
        navigationSummary: undefined,
        networkBody: undefined,
        networkSourceLookup: undefined,
        noActivePageSnapshotFailure: undefined,
        openResultTabCorrection: undefined,
        overlayBlockerDiagnostic: undefined,
        parseError: undefined,
        parseFailureOutput: {},
        plainTextInspection,
        presentation,
        presentationEnvelope,
        priorSessionTabTarget: undefined,
        processResult: { agentBrowserStarted: true, exitCode: 0, spawnError: undefined, stderr: "", timedOut: false, timeoutMs: undefined },
        qaAttachedTarget: undefined,
        qaPreset: undefined,
        recordingDependencyWarning: undefined,
        redactedArgs,
        redactedCompiledElectron: undefined,
        redactedCompiledJob: undefined,
        redactedCompiledNetworkSourceLookup: undefined,
        redactedCompiledQaPreset: undefined,
        redactedCompiledSemanticAction: undefined,
        redactedCompiledSourceLookup: undefined,
        redactedContent,
        redactedProcessArgs: redactedArgs,
        redactedRecoveryHint: undefined,
        resultArtifactManifest: undefined,
        revealSecrets: undefined,
        revealSecretsMatchedRows: 0,
        revealedHeaderLines: [],
        scrollNoopDiagnostic: undefined,
        selectorTextVisibilityDiagnostics: [],
        sessionMode: undefined,
        sessionTabCorrection: undefined,
        settleReport: undefined,
        settleRetryNote: undefined,
        settleRetryOutcome: undefined,
        sourceLookup: undefined,
        succeeded,
        timeoutPartialProgress: undefined,
        unsettledWebMcpMutation: undefined,
        userRequestedJson,
        verbosity: undefined,
        visibleRefFallbackDiagnostic: undefined,
        visibleRefFallbackSessionName: undefined,
    };
}

// --- 1. JSON lane, electron + reveal appends → parseable envelope {result, appended} ----------
{
    const data = { requests: [{ url: "https://api.test/api/x" }], success: true };
    const lane = buildLaneContent({ data, userRequestedJson: true });
    const result = buildFinalAgentBrowserToolResult({
        ...baseOptions({ ...lane, userRequestedJson: true, redactedArgs: ["network", "requests", "--json"], commandInfo: { command: "network", subcommand: "requests" } }),
        electronLaunchRecord: electronRecord,
        revealSecrets: reveal,
        revealSecretsMatchedRows: 1,
        revealedHeaderLines,
    });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].type, "text");
    const envelope = JSON.parse(result.content[0].text); // parseable end-to-end despite two prose appends
    step();
    assert.deepEqual(Object.keys(envelope).sort(), ["appended", "result"], "envelope shape is exactly {result, appended}");
    step();
    assert.deepEqual(envelope.result, JSON.parse(lane.redactedContent[0].text), "envelope.result preserves the wave2-redacted payload object");
    step();
    assert.equal(envelope.appended.length, 2, "both surfacing prose blocks collected, in order");
    step();
    // appended[0]: electron launch prose, redacted (the raw token must not smuggle into the JSON).
    const expectedElectronProse = redactSensitiveText(formatElectronLaunchText({ handoff: undefined, record: electronRecord, targets: electronLaunch.targets, upstreamText: "" }));
    assert.equal(envelope.appended[0], expectedElectronProse);
    step();
    assert.ok(envelope.appended[0].includes("Electron launch:"), "electron prose is the launch text");
    assert.ok(envelope.appended[0].includes("Bearer [REDACTED]") && !envelope.appended[0].includes(ELECTRON_TOKEN), "electron prose passed redactSensitiveText");
    step();
    // appended[1]: P13 notice — warning prose redacted, intentionally revealed header line verbatim.
    const warning = buildRevealSecretsWarning(reveal, { matchedRows: 1 });
    assert.equal(envelope.appended[1], [redactSensitiveText(warning), ["Revealed value(s):", ...revealedHeaderLines].join("\n")].join("\n"));
    step();
    assert.ok(envelope.appended[1].includes("Secrets revealed by explicit request"), "reveal warning prose surfaces");
    assert.ok(envelope.appended[1].includes(REVEALED_TOKEN), "P13 intentional reveal survives (reveal-after-redaction ordering kept)");
    step();
    assert.equal(result.content.length, 1, "no stray content items added");
    step();
}

// --- 2. JSON lane, zero appends → byte-identical to wave2 output -----------------------------
{
    const data = { url: "https://example.com/dashboard", keep: "safe value" };
    const lane = buildLaneContent({ data, userRequestedJson: true });
    const result = buildFinalAgentBrowserToolResult(baseOptions({ ...lane, userRequestedJson: true, redactedArgs: ["get", "url", "--json"] }));
    assert.equal(result.content[0].text, lane.redactedContent[0].text, "no-appends JSON lane is byte-identical to the wave2 (redactedContent) output");
    step();
    assert.ok(JSON.parse(result.content[0].text));
    step();
    assert.equal(JSON.parse(result.content[0].text).data.keep, "safe value");
    step();
}

// --- 3. Prose lane unchanged: electron wrap + P13 notice append keep the pre-envelope formulas --
{
    const prose = `call result: Bearer ${ELECTRON_TOKEN} page text`;
    const lane = buildLaneContent({ data: undefined, userRequestedJson: false });
    lane.redactedContent = [{ type: "text", text: redactSensitiveText(redactExactSensitiveText(prose, [])) }];
    const options = baseOptions({ ...lane, userRequestedJson: false });
    const result = buildFinalAgentBrowserToolResult({
        ...options,
        electronLaunchRecord: electronRecord,
        revealSecrets: reveal,
        revealSecretsMatchedRows: 1,
        revealedHeaderLines,
    });
    const baseProse = redactSensitiveText(redactExactSensitiveText(prose, []));
    const wrapped = redactSensitiveText(formatElectronLaunchText({ handoff: undefined, record: electronRecord, targets: electronLaunch.targets, upstreamText: baseProse }));
    const notice = [buildRevealSecretsWarning(reveal, { matchedRows: 1 }), `Revealed value(s):`, ...revealedHeaderLines].filter((line) => line !== undefined).join("\n");
    assert.equal(result.content[0].text, `${wrapped}\n\n${notice}`, "prose lane: electron wrap + verbatim P13 notice, byte-identical to the pre-envelope composition");
    step();
    // plainTextInspection JSON mode is a prose lane too (jsonLane gate parity with wave2).
    const inspectionOptions = { ...baseOptions({ ...lane, userRequestedJson: true, plainTextInspection: true }), electronLaunchRecord: electronRecord };
    const inspectionResult = buildFinalAgentBrowserToolResult(inspectionOptions);
    assert.equal(inspectionResult.content[0].text, wrapped, "plainTextInspection lane keeps the prose electron wrap (not an envelope)");
    step();
}

// --- 4. JSON lane, payload NOT parseable → falls back to the prose wrap (invariant scoped) ------
{
    const redactedContent = [{ type: "text", text: "not json prose" }];
    const result = buildFinalAgentBrowserToolResult({ ...baseOptions({ data: undefined, presentation: { content: redactedContent }, presentationEnvelope: undefined, redactedContent, userRequestedJson: true }), electronLaunchRecord: electronRecord });
    const expected = redactSensitiveText(formatElectronLaunchText({ handoff: undefined, record: electronRecord, targets: electronLaunch.targets, upstreamText: "not json prose" }));
    assert.equal(result.content[0].text, expected, "non-parsing JSON-lane payload keeps the pre-wave3 prose wrap");
    step();
}

// --- 5. pi-tool-rendering: envelope stays parseable → isError patch adds no content rewrite ----
{
    const data = { requests: [{ url: "https://api.test/api/x" }] };
    const lane = buildLaneContent({ data, succeeded: false, userRequestedJson: true });
    const result = buildFinalAgentBrowserToolResult({
        ...baseOptions({ ...lane, userRequestedJson: true, succeeded: false, redactedArgs: ["network", "requests", "--json"], commandInfo: { command: "network", subcommand: "requests" } }),
        revealSecrets: reveal,
        revealSecretsMatchedRows: 1,
        revealedHeaderLines,
    });
    const envelope = JSON.parse(result.content[0].text); // envelope survives the failure path too
    step();
    assert.equal(envelope.appended.length, 1);
    step();
    const patch = buildAgentBrowserToolResultPatch({
        toolName: "agent_browser",
        input: { args: ["network", "requests", "--json"] },
        details: { args: ["network", "requests", "--json"], resultCategory: "failure", failureCategory: "stale-ref" },
        content: result.content,
        isError: undefined,
    });
    assert.deepEqual(patch, { isError: true }, "parseable envelope → hard error marker only, NO content rewrite");
    step();
}

// --- 7. review round 1 minor 1: JSON lane, payload NOT parseable + revealSecrets → notice must
// surface via the wave2 prose fallback (never silently dropped), no envelope built ----------------
{
    const redactedContent = [{ type: "text", text: "not json prose" }];
    const result = buildFinalAgentBrowserToolResult({ ...baseOptions({ data: undefined, presentation: { content: redactedContent }, presentationEnvelope: undefined, redactedContent, userRequestedJson: true }), revealSecrets: reveal, revealSecretsMatchedRows: 1, revealedHeaderLines });
    const text = result.content[0].text;
    const notice = [buildRevealSecretsWarning(reveal, { matchedRows: 1 }), "Revealed value(s):", ...revealedHeaderLines].filter((line) => line !== undefined).join("\n");
    assert.ok(text.includes(notice), "P13 notice surfaces in content via the prose fallback when the JSON-lane payload is unparseable");
    step();
    assert.throws(() => JSON.parse(text), "fallback prose is intentionally parse-breaking (pre-wave3 behavior), not an envelope");
    step();
}

console.log(`OK: ${checks} JSON-envelope checks passed (electron+reveal prose composed into a parseable {result, appended} envelope with redacted appended blocks and P13 reveals preserved verbatim; zero-appends JSON lane byte-identical to wave2; prose and plainTextInspection lanes byte-identical to the pre-envelope composition; non-parsing payload falls back to prose wrap incl. the revealSecrets case; pi-tool-rendering isError patch adds no content rewrite).`);
