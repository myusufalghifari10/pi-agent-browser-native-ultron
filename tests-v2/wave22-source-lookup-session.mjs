// wave22: sourceLookup accepted `session` and then dropped it on the floor.
//
// Found by live testing, not by reading code. A sourceLookup naming a session reported
// "Element not found" for an element that was demonstrably present in that session, and the
// next-action it offered pointed at the ROOT session — proof the named session was never used.
// The compiled argv was a bare ["batch"] with no --session at all, and the field was not even
// validated, so a typo passed silently.
//
// networkSourceLookup in the same file already threaded session correctly, so this mirrors it
// rather than inventing a convention. What must not regress: a lookup with no session must still
// compile to exactly ["batch"], because callers rely on that argv.
import assert from "node:assert/strict";

import { compileAgentBrowserSourceLookup, compileAgentBrowserNetworkSourceLookup } from "../dist/extensions/agent-browser/lib/input-modes/lookups.js";

// The bug: session was dropped.
assert.deepEqual(compileAgentBrowserSourceLookup({ selector: "#a", session: "ultron1" }).compiled.args,
    ["--session", "ultron1", "batch"],
    "a named session must reach the compiled argv");
assert.equal(compileAgentBrowserSourceLookup({ selector: "#a", session: "ultron1" }).compiled.query.session, "ultron1",
    "the session must be recorded on the query so the run can be attributed to it");

// Must not change the sessionless form.
assert.deepEqual(compileAgentBrowserSourceLookup({ selector: "#a" }).compiled.args, ["batch"],
    "a lookup with no session must still compile to a bare [\"batch\"]");

// Silently accepting junk was part of the defect, so a bad session must now be named.
assert.match(compileAgentBrowserSourceLookup({ selector: "#a", session: "  " }).error ?? "", /sourceLookup\.session/,
    "a blank session must be refused and named");
assert.match(compileAgentBrowserSourceLookup({ selector: "#a", session: 5 }).error ?? "", /sourceLookup\.session/,
    "a non-string session must be refused and named");

// The pre-existing diagnostics must be untouched.
assert.match(compileAgentBrowserSourceLookup({ session: "ultron1" }).error ?? "", /requires selector/,
    "the missing-selector error must survive");

// The sibling mode is the reference implementation, asserted so the two cannot drift apart.
const netArgs = compileAgentBrowserNetworkSourceLookup({ url: "https://example.com/", session: "ultron1" }).compiled.args;
assert.deepEqual(netArgs, ["--session", "ultron1", "batch"],
    "networkSourceLookup must keep threading session the same way");

console.log("wave22-source-lookup-session: all assertions passed (session reaches argv, sessionless form unchanged, bad input named, sibling mode pinned)");
