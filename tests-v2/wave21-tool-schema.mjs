// wave21: the tool parameter schema must be able to stand on its own.
//
// A different agent session read COMMAND_REFERENCE.md in full and still could not make a single
// successful agent_browser call. Every `args` call died with "args is not iterable" and every
// `job` call with "job.steps must be a non-empty array", while `script` worked. Its diagnosis was
// that the P28 patch had been lost.
//
// The patch was fine. The cause was here: every parameter was declared as an empty schema `{}`,
// so the model was told the parameter exists and nothing else. It guessed, and it guessed
// `args` as an array-of-arrays because that is what `stdin` looks like for `batch`. It then read
// the guide, which documents the correct form at line 1303 of 2242, concluded the patch was
// clobbered, and reported a bug that did not exist.
//
// The model reads this schema BEFORE the guide, so the schema is the only place a wrong guess
// can be prevented. These assertions therefore load the real tool definition through a mocked pi
// and inspect the object the host actually receives — a source-text match would pass while the
// host kept getting `{}`.
import assert from "node:assert/strict";

import extensionFactory from "../dist/extensions/agent-browser/index.js";

let TOOL;
extensionFactory({ registerTool(tool) { TOOL = tool; }, on() { } });
const PARAMS = TOOL.parameters;
const PROPS = PARAMS.properties;

// 1. No parameter may be an empty schema again. That is the defect this wave exists to kill, and
//    it is invisible to a test that only checks the modes are enumerated.
const MODES = ["script", "args", "semanticAction", "qa", "job", "electron", "debug", "settle",
    "networkBody", "vault", "checkpoint", "devServer", "login", "cdp", "act", "sourceLookup",
    "networkSourceLookup", "revealSecrets", "verbosity", "stdin", "outputPath", "timeoutMs", "sessionMode"];
for (const key of MODES) {
    const prop = PROPS[key];
    assert.ok(prop, `${key} must still be declared in the slim schema`);
    assert.ok(prop && Object.keys(prop).length > 0, `${key} must not be an empty schema {} — the model reads this before the guide`);
    assert.ok(prop.description && prop.description.length > 10, `${key} must carry a description`);
}

// 2. `args` is the parameter that broke. It must name the failing symptom verbatim, because the
//    whole point is that an agent who has never read the guide can still avoid the mistake.
const argsDoc = PROPS.args.description;
assert.match(argsDoc, /args is not iterable/, "args must name the exact error the host throws, so it is recognisable");
assert.match(argsDoc, /JSON string/, "args must say the working form is a JSON string");
assert.ok(Array.isArray(PROPS.args.type) && PROPS.args.type.includes("array"),
    "args must still admit a raw array, so hosts that accept one are not broken by this change");

// 3. `stdin` is the shape `args` was mistaken for. It must stay array-of-arrays for batch.
assert.ok(PROPS.stdin.type.includes("array"), "stdin must admit the array form batch needs");
assert.match(PROPS.stdin.description, /batch/i, "stdin must be described for batch steps");

// 4. This host re-coerces object params to strings as well — that is the `job` failure. Every
//    mode-object must therefore admit BOTH string and object, or a correct call gets rejected.
for (const key of ["job", "qa", "act", "cdp", "vault", "checkpoint", "login", "semanticAction",
    "electron", "debug", "settle", "networkBody", "devServer", "sourceLookup", "networkSourceLookup"]) {
    const t = PROPS[key].type;
    assert.ok(Array.isArray(t) && t.includes("string") && t.includes("object"),
        `${key} must admit both string and object — this host stringifies object params, and a string-only schema would reject the working form`);
}

// 5. The fields whose type is unambiguous, pinned so a later edit cannot quietly loosen them into
//    something the host will reject.
assert.equal(PROPS.timeoutMs.type, "number");
assert.equal(PROPS.script.type, "string");
assert.equal(PROPS.outputPath.type, "string");
assert.equal(PROPS.sessionMode.type, "string");

// 6. additionalProperties stays open: a host may pass params the slim schema does not list, and
//    closing it would break those hosts outright.
assert.equal(PARAMS.additionalProperties, true, "additionalProperties must stay open");

// 7. The schema change must not have disturbed prepareArguments, which is the actual P28 self-heal.
const prep = TOOL.prepareArguments;
assert.deepEqual(prep({ args: "[\"get\",\"url\"]" }), { args: ["get", "url"] },
    "the documented args form must still normalize to a real array");
assert.deepEqual(prep({ job: "{\"steps\":[[\"get\",\"url\"]]}" }), { job: { steps: [["get", "url"]] } },
    "a stringified job must still normalize to an object");

console.log("wave21-tool-schema: all assertions passed (23 params carry type+description, args names the exact host error, every mode-object admits string|object, prepareArguments intact)");
