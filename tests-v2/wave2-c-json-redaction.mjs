// FINAL-DESIGN.md §4 item 4 / §5.3 — offline verifier for closing the caller `--json` redaction hole.
// Hole: buildRedactedPresentationContent (final-result.js) skipped the prose-level redactSensitiveText
// pass for caller-requested --json content (exact-value pass only). Fix: redactParseableJsonText —
// structure-preserving redaction (parse → redactSensitiveValue walk → re-serialize parseable) wired
// into the JSON-mode branch. Keys stay intact for machine callers; non-JSON input passes through
// byte-identical; the pi-tool-rendering.js isError patch must still see parseable JSON post-redaction.
// Run: node tests-v2/wave2-c-json-redaction.mjs
import assert from "node:assert/strict";
import { buildRedactedPresentationContent, redactExactSensitiveText, redactParseableJsonText, } from "../dist/extensions/agent-browser/lib/orchestration/browser-run/final-result.js";
import { buildAgentBrowserToolResultPatch } from "../dist/extensions/agent-browser/lib/pi-tool-rendering.js";
import { redactSensitiveText } from "../dist/extensions/agent-browser/lib/runtime.js";

let checks = 0;
const step = () => {
    checks += 1;
};

const BEARER_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const SAML_URL = "https://idp.example.com/sso?SAMLRequest=fZJRa%2BswSIBa2Q%3D%3D&RelayState=https%3A%2F%2Fapp.example.com%2Fcb";

function collectStrings(value, out = []) {
    if (typeof value === "string") {
        out.push(value);
        return out;
    }
    if (Array.isArray(value)) {
        for (const item of value)
            collectStrings(item, out);
        return out;
    }
    if (value && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            out.push(key);
            collectStrings(item, out);
        }
    }
    return out;
}

// --- 1. Pure helper: Bearer token string value ------------------------------------------
{
    const input = JSON.stringify({ log: `auth header was Bearer ${BEARER_TOKEN}`, keep: "untouched" });
    const output = redactParseableJsonText(input);
    const parsed = JSON.parse(output); // (a) still JSON.parse-able
    step();
    assert.ok(output.includes("Bearer [REDACTED]"), "bearer token replaced with [REDACTED]");
    step();
    assert.ok(!output.includes(BEARER_TOKEN), "raw bearer token gone");
    step();
    assert.equal(parsed.keep, "untouched");
    assert.ok(parsed.log.startsWith("auth header was"));
    step();
}

// --- 2. Pure helper: password-ish key (value blanked, key intact) -------------------------
{
    const input = JSON.stringify({ password: "hunter2secret", note: "safe value" });
    const output = redactParseableJsonText(input);
    const parsed = JSON.parse(output);
    assert.ok("password" in parsed, "key must survive");
    step();
    assert.equal(parsed.password, "[REDACTED]");
    assert.equal(parsed.note, "safe value");
    step();
}

// --- 3. Pure helper: SAML query-param URL (params redacted, host/path intact) -------------
{
    const input = JSON.stringify({ url: SAML_URL });
    const output = redactParseableJsonText(input);
    JSON.parse(output);
    step();
    const parsed = JSON.parse(output);
    assert.ok(parsed.url.startsWith("https://idp.example.com/sso?"), "host/path untouched");
    step();
    assert.ok(parsed.url.includes("SAMLRequest=%5BREDACTED%5D"), "SAMLRequest value redacted");
    assert.ok(parsed.url.includes("RelayState=%5BREDACTED%5D"), "RelayState value redacted");
    step();
    assert.ok(!output.includes("fZJRa") && !output.includes("app.example.com"), "raw SAML/RelayState values gone");
    step();
}

// --- 4. Pure helper: keys + non-sensitive values untouched (deep structure) ---------------
{
    const input = {
        password: "hunter2secret",
        note: "safe value",
        nested: { api_key: "sk-123-secret", list: [`Bearer ${BEARER_TOKEN}`, 42, null, true] },
    };
    const output = redactParseableJsonText(JSON.stringify(input));
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed, {
        password: "[REDACTED]",
        note: "safe value",
        nested: { api_key: "[REDACTED]", list: ["Bearer [REDACTED]", 42, null, true] },
    });
    step();
    // Every key of the input survives verbatim (never redact keys).
    for (const key of ["password", "note", "nested", "api_key", "list"])
        assert.ok(collectStrings(parsed).includes(key), `key ${key} intact`);
    step();
}

// --- 5. Pure helper: non-JSON content passthrough byte-identical (requirement 2) ----------
for (const text of ["prose with Bearer abc123secret inline", "", "   ", "not json { unclosed", "[1, 2, unclosed"]) {
    assert.equal(redactParseableJsonText(text), text, `non-JSON passthrough unchanged: ${JSON.stringify(text.slice(0, 20))}`);
    step();
}

// --- 6. Pure helper: idempotent (no double-redaction artifacts, no un-redaction) ----------
{
    const input = JSON.stringify({ password: "hunter2secret", log: `Bearer ${BEARER_TOKEN}`, url: SAML_URL });
    const once = redactParseableJsonText(input);
    const twice = redactParseableJsonText(once);
    assert.equal(twice, once, "second pass is a no-op");
    step();
    JSON.parse(twice);
    step();
}

// --- 7. Pure helper: perf ceiling on a ~200KB payload --------------------------------------
{
    const rows = Array.from({ length: 4000 }, (_, index) => ({ name: `row-${index}`, note: `value ${index} Bearer ${BEARER_TOKEN}` }));
    const input = JSON.stringify({ rows });
    assert.ok(input.length > 150_000, "fixture is size-class relevant");
    step();
    const startedAt = Date.now();
    const output = redactParseableJsonText(input);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 250, `200KB walk must stay bounded, took ${elapsedMs}ms`);
    step();
    assert.ok(!output.includes(BEARER_TOKEN));
    step();
}

// --- 8. Ladder integration: JSON-mode content via buildRedactedPresentationContent ---------
{
    const presentation = {
        content: [{ type: "text", text: "prose form is dropped in JSON mode" }],
        data: { log: `Bearer ${BEARER_TOKEN}`, password: "hunter2secret", url: SAML_URL, keep: "safe value" },
    };
    const content = buildRedactedPresentationContent({
        exactSensitiveValues: [],
        plainTextInspection: false,
        presentation,
        presentationEnvelope: { success: true, data: presentation.data },
        succeeded: true,
        userRequestedJson: true,
        warningText: undefined,
    });
    assert.equal(content.length, 1);
    assert.equal(content[0].type, "text");
    const parsed = JSON.parse(content[0].text); // parseable end-to-end
    step();
    assert.equal(parsed.data.password, "[REDACTED]");
    assert.ok(parsed.data.log.includes("Bearer [REDACTED]"));
    assert.ok(parsed.data.url.includes("SAMLRequest=%5BREDACTED%5D"));
    assert.equal(parsed.data.keep, "safe value");
    assert.equal(parsed.success, true);
    step();
    const flat = content[0].text;
    assert.ok(!flat.includes(BEARER_TOKEN) && !flat.includes("hunter2secret") && !flat.includes("fZJRa"), "no raw secret survives the JSON lane");
    step();
    // Keys stay intact for machine callers.
    for (const key of ["data", "log", "password", "url", "keep", "success"])
        assert.ok(collectStrings(parsed).includes(key), `key ${key} intact in lane output`);
    step();
}

// --- 9. Ladder integration: exactSensitiveValues still applied in JSON mode ----------------
{
    const content = buildRedactedPresentationContent({
        exactSensitiveValues: ["hunter2exact"],
        plainTextInspection: false,
        presentation: { content: [{ type: "text", text: "x" }], data: { note: "the secret is hunter2exact yes" } },
        presentationEnvelope: { success: true },
        succeeded: true,
        userRequestedJson: true,
        warningText: undefined,
    });
    const parsed = JSON.parse(content[0].text);
    assert.equal(parsed.data.note, "the secret is [REDACTED] yes");
    step();
}

// --- 10. Non-JSON lane byte-identical: prose branch still redactSensitiveText(exact(text)) --
{
    const prose = `call result: Bearer ${BEARER_TOKEN} and password=hunter2secret in page text`;
    const exactSensitiveValues = [];
    for (const options of [
        { exactSensitiveValues, plainTextInspection: false, userRequestedJson: false, warningText: undefined },
        { exactSensitiveValues, plainTextInspection: true, userRequestedJson: true, warningText: undefined },
    ]) {
        const content = buildRedactedPresentationContent({
            ...options,
            presentation: { content: [{ type: "text", text: prose }], data: undefined },
            presentationEnvelope: undefined,
            succeeded: true,
        });
        const expected = redactSensitiveText(redactExactSensitiveText(prose, exactSensitiveValues));
        assert.equal(content[0].text, expected, `prose lane byte-identical (userRequestedJson=${options.userRequestedJson}, plainTextInspection=${options.plainTextInspection})`);
        step();
    }
}

// --- 11. JSON-mode lane unchanged output for a clean payload (formatting preserved) --------
{
    const clean = JSON.stringify({ data: { keep: "safe value" }, success: true }, null, 2);
    const content = buildRedactedPresentationContent({
        exactSensitiveValues: [],
        plainTextInspection: false,
        presentation: { content: [{ type: "text", text: "x" }], data: { keep: "safe value" } },
        presentationEnvelope: { success: true, data: { keep: "safe value" } },
        succeeded: true,
        userRequestedJson: true,
        warningText: undefined,
    });
    assert.equal(JSON.parse(content[0].text).data.keep, "safe value");
    assert.equal(content[0].text, redactParseableJsonText(redactExactSensitiveText(clean, [])));
    step();
}

// --- 12. pi-tool-rendering: isError patch still sees parseable JSON post-redaction ---------
{
    const redactedJson = redactParseableJsonText(JSON.stringify({ data: { url: "https://x.test/" }, success: false, error: "stale ref @1/e" }));
    const event = {
        toolName: "agent_browser",
        input: { args: ["get", "url", "--json"] },
        details: { args: ["get", "url", "--json"], resultCategory: "failure", failureCategory: "stale-ref" },
        content: [{ type: "text", text: redactedJson }],
        isError: undefined,
    };
    const patch = buildAgentBrowserToolResultPatch(event);
    assert.deepEqual(patch, { isError: true }, "parseable JSON post-redaction → hard error marker, NO content rewrite");
    step();

    // Counter-case: non-parseable --json content still gets the model-visible failure notice.
    const proseEvent = { ...event, content: [{ type: "text", text: "plain failure prose" }] };
    const prosePatch = buildAgentBrowserToolResultPatch(proseEvent);
    assert.ok(prosePatch?.content?.[0]?.text.includes("Result category: failure"), "non-parseable lane still appends the failure notice");
    step();
    assert.equal(prosePatch.isError, true);
    step();

    // Success JSON results get no patch at all.
    const successEvent = { ...event, details: { ...event.details, resultCategory: undefined }, content: [{ type: "text", text: redactParseableJsonText(JSON.stringify({ success: true })) }] };
    assert.equal(buildAgentBrowserToolResultPatch(successEvent), undefined);
    step();
}

console.log(`OK: ${checks} JSON-redaction checks passed (helper redactParseableJsonText: bearer/password-key/SAML-URL redaction with keys intact, non-JSON passthrough, idempotency, 200KB perf ceiling; ladder integration: JSON lane parseable+redacted, exact values, prose lane byte-identical, clean-payload stability; pi-tool-rendering isError patch composition).`);
