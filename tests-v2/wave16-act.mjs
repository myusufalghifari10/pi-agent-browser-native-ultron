// wave16: `act` — a declarative find-and-act mode.
//
// The model was writing this JavaScript by hand in 169 of 435 eval calls in the sweep. This
// mode takes the intent declaratively and emits one eval spawn whose script is generated
// here, so the two properties that were being re-derived (and re-broken) every time are
// written exactly once:
//
//   1. hidden 0x0 duplicates are filtered out before matching. `find text "Run"` once landed
//      on a hidden 0x0 duplicate instead of the real button, which is why the model stopped
//      trusting `find` and started writing its own loops.
//   2. more than one match is REFUSED, never guessed. Every recorded death in this project
//      is the same shape: a plausible guess reported as success.
//
// The behavioural half of this file runs the generated script against a fake DOM, so the
// matching and refusal logic is executed rather than pattern-matched in source text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const act = await import(join(repo, "dist/extensions/agent-browser/lib/input-modes/act.js"));
const { resolveAgentBrowserInput } = await import(join(repo, "dist/extensions/agent-browser/lib/orchestration/input-plan.js"));

let failures = 0;
function group(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        failures += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

function input(value) {
    return resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params: { act: value } });
}

group("a valid intent compiles to exactly one eval spawn", () => {
    const result = input({ action: "click", find: { text: "Reply" } });
    assert.equal(result.kind, "act");
    assert.equal(result.status, "valid");
    assert.deepEqual(result.toolArgs, ["eval", "--stdin"], "one spawn, and it is the eval lane");
    assert.equal(typeof result.toolStdin, "string");
    assert.ok(result.toolStdin.length > 0, "the script must be carried on stdin");
});

group("the generated script is valid JavaScript", () => {
    for (const intent of [{ action: "click", find: { text: "Reply" } }, { action: "read", find: { role: "button" } }, { action: "click", find: { text: "a\"b'c", exact: false } }]) {
        const script = input(intent).toolStdin;
        assert.doesNotThrow(() => new Function(`return ${script}`), `generated script must parse: ${JSON.stringify(intent.find)}`);
    }
});

group("hostile strings are passed through as data, never as code", () => {
    // The script embeds the caller's text via JSON.stringify. If that were hand-concatenated
    // this is where a page could inject into the script it is being searched in.
    const nasty = '"; globalThis.__pwned = 1; //';
    const result = input({ action: "click", find: { text: nasty } });
    assert.ok(result.toolStdin.includes(JSON.stringify(nasty)), "the text must be embedded as a JSON literal");
    const sandbox = {};
    new Function("document", "globalThis", `return ${result.toolStdin}`)({ querySelectorAll: () => [] }, sandbox);
    assert.equal(sandbox.__pwned, undefined, "a text value must never become executable code");
});

group("match/ambiguity logic RUNS against a fake DOM", () => {
    const make = (tag, text, { width = 80, height = 24, role = null, ariaLabel = null, innerText = null, onClick = null, display = "block" } = {}) => ({
        tagName: tag.toUpperCase(),
        textContent: text,
        innerText,
        value: undefined,
        getAttribute: (name) => (name === "role" ? role : name === "aria-label" ? ariaLabel : null),
        getBoundingClientRect: () => ({ height, width, x: 10, y: 20 }),
        // A collapsed element can still report a client rect - a zero-width inline, a
        // font-size:0 label, a grid cell collapsed by its content. So getClientRects alone is
        // NOT enough to spot the hidden duplicate; the size check is what does the work, and
        // the fixture has to model that or it proves nothing.
        getClientRects: () => (display === "none" ? [] : [{}]),
        scrollIntoView: () => {},
        click: () => { onClick?.(); },
    });
    const run = (intent, elements) => {
        const script = input(intent).toolStdin;
        const document = { querySelectorAll: () => elements };
        return new Function("document", `return ${script}`)(document);
    };

    const clicked = [];
    const page = [
        make("button", "Reply", { onClick: () => clicked.push("visible") }),
        make("button", "Reply", { width: 0, height: 0, onClick: () => clicked.push("hidden") }),
    ];
    const single = run({ action: "click", find: { text: "Reply" } }, page);
    assert.equal(single.status, "matched", "the hidden duplicate must not create ambiguity");
    assert.equal(single.matched, 1, "only the visible element counts");
    assert.equal(single.considered, 2, "but the page really did have two candidates, and the count says so");
    assert.deepEqual(clicked, ["visible"], "the VISIBLE element is the one that got clicked");
    assert.deepEqual(single.target.rect, { height: 24, width: 80, x: 10, y: 20 }, "the rect comes back so the model can verify");

    const ambiguous = run({ action: "click", find: { text: "Reply" } }, [make("button", "Reply"), make("a", "Reply")]);
    assert.equal(ambiguous.status, "ambiguous", "two visible matches must be refused, not guessed");
    assert.equal(ambiguous.matched, 2);
    assert.equal(ambiguous.candidates.length, 2, "both candidates are reported so the model can narrow");
    assert.equal(ambiguous.clicked, undefined, "nothing may be clicked on an ambiguous result");

    const notFound = run({ action: "click", find: { text: "Nope" } }, [make("button", "Reply")]);
    assert.equal(notFound.status, "not-found");
    assert.equal(notFound.matched, 0);

    // innerText is consulted before textContent: a node whose text lives only in the rendered
    // layer must still match, and the text it returns is the one a human would have read. The
    // query is the full normalised string, because exact matching must not match a prefix -
    // that is the same "Reply" vs "Reply to all" rule, in the other direction.
    const readResult = run({ action: "read", find: { text: "Reply now please" } }, [make("button", "", { innerText: "  Reply   now  please  " })]);
    assert.equal(readResult.status, "matched");
    assert.equal(readResult.text, "Reply now please", "whitespace is normalised so a text match is not defeated by a stray newline");
    assert.equal(readResult.truncated, false);
    assert.equal(run({ action: "read", find: { text: "Reply" } }, [make("button", "", { innerText: "Reply now please" })]).status, "not-found", "exact matching must not accept a prefix");
    const capped = run({ action: "read", find: { text: "Reply now please" }, limit: 8 }, [make("button", "", { innerText: "Reply now please" })]);
    assert.equal(capped.text, "Reply no", "limit must actually truncate");
    assert.equal(capped.truncated, true, "and truncation must be reported, not silent");
    assert.equal(capped.totalChars, 16, "the true length comes back so the model knows what it missed");
});

group("exact matching is the default, and substring matching is opt-in", () => {
    const make = (text) => ({ tagName: "BUTTON", textContent: text, getAttribute: () => null, getBoundingClientRect: () => ({ height: 20, width: 60, x: 0, y: 0 }), getClientRects: () => [{}], click: () => {} });
    const run = (find) => new Function("document", `return ${input({ action: "click", find }).toolStdin}`)({ querySelectorAll: () => [make("Reply to all"), make("Reply")] });
    const exact = run({ text: "Reply" });
    assert.equal(exact.matched, 1, "'Reply' must not match 'Reply to all' by default");
    const loose = run({ exact: false, text: "Reply" });
    assert.equal(loose.matched, 2, "substring matching must still be available on request");
});

group("role matching understands the implicit mapping, not just explicit role attributes", () => {
    const el = (tag, role) => ({ tagName: tag.toUpperCase(), textContent: "x", getAttribute: (n) => (n === "role" ? role : null), getBoundingClientRect: () => ({ height: 20, width: 60, x: 0, y: 0 }), getClientRects: () => [{}], click: () => {} });
    const run = (role, elements) => new Function("document", `return ${input({ action: "click", find: { role } }).toolStdin}`)({ querySelectorAll: () => elements });
    assert.equal(run("button", [el("button", null), el("div", null)]).matched, 1, "a <button> is a button even with no role attribute");
    assert.equal(run("link", [el("a", null), el("button", null)]).matched, 1, "an <a> is a link");
    // An explicit role REPLACES the implicit one. An <a role="menuitem"> is a menu item, not a
    // link, and matching it as a link is how a click ends up on the wrong control.
    assert.equal(run("link", [el("a", "menuitem"), el("a", null)]).matched, 1, "an explicit role wins over the tag default");
    assert.equal(run("menuitem", [el("a", "menuitem")]).matched, 1, "the re-roled element is findable by its real role");
    // A plain <a> still counts as a menuitem through the implicit mapping, so both match here.
    // What must NOT happen is the re-roled link being reported as a link.
    assert.equal(run("link", [el("a", "menuitem")]).matched, 0, "a re-roled link is not a link any more");
});

group("maxMatches above 1 is allowed deliberately and still reports every candidate", () => {
    const el = () => ({ tagName: "BUTTON", textContent: "Go", getAttribute: () => null, getBoundingClientRect: () => ({ height: 20, width: 60, x: 0, y: 0 }), getClientRects: () => [{}], click: () => {} });
    const result = new Function("document", `return ${input({ action: "read", find: { text: "Go" }, maxMatches: 3 }).toolStdin}`)({ querySelectorAll: () => [el(), el(), el()] });
    assert.equal(result.status, "matched", "with maxMatches 3 the caller accepted ambiguity on purpose");
    assert.equal(result.matched, 3);
});

group("validation refuses an intent that cannot mean anything", () => {
    assert.match(input({ action: "click", find: {} }).validationError, /needs a text or a role/, "matching everything is never the ask");
    assert.match(input({ action: "poke", find: { text: "x" } }).validationError, /act\.action must be one of click, read/);
    assert.match(input({ action: "click" }).validationError, /act\.find must be an object/);
    assert.match(input({ action: "click", find: { text: "x", colour: "red" } }).validationError, /act\.find does not support colour/);
    assert.match(input({ action: "click", find: { text: "x" }, nope: 1 }).validationError, /act does not support nope/);
    assert.match(input({ action: "click", find: { text: "" } }).validationError, /non-empty string/);
    assert.match(input({ action: "click", find: { text: 7 } }).validationError, /non-empty string/);
    assert.match(input({ action: "click", find: { text: "x" }, limit: 0 }).validationError, /positive integer/);
    assert.match(input({ action: "click", find: { text: "x" }, maxMatches: 999 }).validationError, /or less/);
    assert.match(input({ action: "click", find: { text: "x" }, session: "bad name" }).validationError, /whitespace/);
    assert.match(input("nope").validationError, /act must be an object/);
});

group("act is exactly one input mode, like every other mode", () => {
    const both = resolveAgentBrowserInput({ getBatchPreflightValidationError: () => undefined, params: { act: { action: "click", find: { text: "x" } }, args: ["get", "url"] } });
    assert.match(both.validationError, /supplied args and act/);
    const alone = input({ action: "click", find: { text: "x" } });
    assert.equal(alone.status, "valid", "act on its own must be accepted");
});

group("act is enumerated everywhere the host has to know about it", () => {
    const source = readFileSync(join(repo, "dist/extensions/agent-browser/index.js"), "utf8");
    assert.match(source, /"cdp", "act", "sourceLookup"/, "act must be in the registered slim schema, or the host drops the param");
    assert.match(source, /"login", "cdp", "act", "sourceLookup", "networkSourceLookup"\]\)/, "act must be in the P28 de-stringify list, or a string payload stays a string");
    const plan = readFileSync(join(repo, "dist/extensions/agent-browser/lib/orchestration/input-plan.js"), "utf8");
    assert.match(plan, /\["act", params\.act !== undefined\]/, "act must be counted in suppliedModeNames");
    assert.match(plan, /"cdp", "act"\];/, "act must be in allModeNames");
});

if (failures > 0) {
    console.log(`\nwave16-act: ${failures} group(s) FAILED`);
    process.exit(1);
}
console.log("\nwave16-act: all assertions passed");
