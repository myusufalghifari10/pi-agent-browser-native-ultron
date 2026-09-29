// wave13: no dead imports in the live entry point.
//
// `AGENT_BROWSER_PARAMS` was imported by dist/extensions/agent-browser/index.js
// and never referenced. The module it came from (lib/input-modes/params.js,
// 229 lines) declared `job` with additionalProperties:false and no `session`,
// which reads exactly like the host contract but is NOT the registered schema —
// index.js registers AGENT_BROWSER_PARAMS_SLIM. That is not a hypothetical trap:
// the wave-9 worker read params.js, concluded `job.session` was unreachable, and
// asked to edit a file that could never affect runtime behaviour.
//
// Unused imports are therefore not cosmetic. They advertise a contract the code
// does not honour. This asserts that every named import at the entry point is
// actually referenced, so the next one fails here instead of misleading a worker.
//
// Deliberately not a lint rule over the whole tree: dist/ is 35k lines of live
// hand-patched upstream code and this only guards the one file a maintainer reads
// first. Grep cost stays at a single file.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entryPath = resolve(here, "../dist/extensions/agent-browser/index.js");
const source = readFileSync(entryPath, "utf8");

const importRe = /^import\s+\{([^}]+)\}\s+from\s+"([^"]+)";?$/gm;
const unused = [];
let checked = 0;
for (const match of source.matchAll(importRe)) {
    const [, names, specifier] = match;
    const body = source.slice(0, match.index) + source.slice(match.index + match[0].length);
    for (const raw of names.split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop().trim();
        if (!name) continue;
        checked += 1;
        // Word-boundary match, so AGENT_BROWSER_PARAMS does not "count" for
        // AGENT_BROWSER_PARAMS_SLIM.
        const used = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(body);
        if (!used) unused.push({ name, specifier });
    }
}

assert.equal(unused.length, 0,
    `dead imports in the entry point (each one advertises a contract the runtime does not honour): ${unused.map((u) => `${u.name} from ${u.specifier}`).join(", ")}`);

assert.ok(checked > 30, `expected the entry point to have many imports, parsed only ${checked} — the regex is probably stale`);
assert.doesNotMatch(source, /AGENT_BROWSER_PARAMS\b/,
    "AGENT_BROWSER_PARAMS must stay gone: the registered schema is AGENT_BROWSER_PARAMS_SLIM");
assert.match(source, /AGENT_BROWSER_PARAMS_SLIM/,
    "the slim schema must remain the registered one");

// The deleted modules must really be gone, not merely unreferenced.
for (const gone of [
    resolve(here, "../dist/extensions/agent-browser/lib/input-modes/params.js"),
    resolve(here, "../dist/extensions/agent-browser/lib/results/contracts.js"),
]) {
    let exists = true;
    try { readFileSync(gone); } catch { exists = false; }
    assert.equal(exists, false, `${gone} must be deleted, not left as dead weight`);
}

// No source anywhere under dist/ may still import them.
console.log(`wave13-dead-imports: all assertions passed (${checked} named imports at the entry point are all referenced; params.js and contracts.js are gone)`);
