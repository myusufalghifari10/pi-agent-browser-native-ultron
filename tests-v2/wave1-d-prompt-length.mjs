// wave1-D: prompt slimming length gate (FINAL-DESIGN §2.1 — always-on Tier A ≤900 chars).
// Imports ONLY the pure builder from lib/playbook.js (leaf module; never import index.js —
// it needs the Pi host). The payload is assembled the same way index.js does:
// buildToolPromptGuidelines({ browserDefaultProfile, browserExecutablePath, docs }).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildToolPromptGuidelines } from "../dist/extensions/agent-browser/lib/playbook.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// Mirrors index.js getInstalledDocsPaths(): commandReferencePath = <packageRoot>/docs/COMMAND_REFERENCE.md
const commandReferencePath = `${packageRoot}docs/COMMAND_REFERENCE.md`;

let failed = false;
const fail = (message) => {
    console.error(`FAIL: ${message}`);
    failed = true;
};

if (!existsSync(commandReferencePath)) fail(`docs pointer target missing on disk: ${commandReferencePath}`);

// Static always-on payload (config-driven lines are env-dependent; none configured here —
// verified: no global config file, no PI_AGENT_BROWSER_CONFIG env override).
const guidelines = buildToolPromptGuidelines({
    browserDefaultProfile: undefined,
    browserExecutablePath: undefined,
    docs: { commandReferencePath },
});
const payload = guidelines.join("\n");

console.log(`guidelines: ${guidelines.length} lines`);
for (const line of guidelines) console.log(`  [${String(line.length).padStart(3)}] ${line}`);
console.log(`joined payload: ${payload.length} chars (budget 900, target ~800)`);

const REQUIRED_IN_ORDER = [
    "Use this tool for ALL browser work — never call agent-browser via bash.",
    "Never type passwords/cards/2FA codes — use vault/login modes.",
    "Verify important mutations (fresh snapshot / URL / text) before claiming success.",
    "Honor explicit user stop boundaries — never purchase, order, or submit beyond explicit authorization.",
    "Follow details.nextActions before improvising.",
    "Gates — LIHAT: snapshot/read/diff/settle/debug · LAKUKAN: semanticAction/job · KELOLA: sessions/profiles/vault/devServer/electron · OTOMASI: script/qa/webmcp.",
];
REQUIRED_IN_ORDER.forEach((expected, i) => {
    if (guidelines[i] !== expected) fail(`line ${i + 1} is not the required invariant/gate:\n  got:      ${guidelines[i]}\n  expected: ${expected}`);
});
if (guidelines.length !== REQUIRED_IN_ORDER.length + 1) fail(`expected exactly ${REQUIRED_IN_ORDER.length + 1} lines (invariants + gates + docs pointer), got ${guidelines.length}`);
if (!guidelines[guidelines.length - 1].startsWith("Full guide (read on first use, guide-gate): ") || !guidelines[guidelines.length - 1].endsWith("docs/COMMAND_REFERENCE.md")) {
    fail(`last line is not the docs guide-gate pointer: ${guidelines[guidelines.length - 1]}`);
}

// nextActions teaching machinery must stay reachable: the invariant points at it, and the
// playbook must not have lost SHARED_BROWSER_PLAYBOOK_GUIDELINES/QUICK_START (Tier B) exports.
const playbook = await import("../dist/extensions/agent-browser/lib/playbook.js");
for (const exportName of ["QUICK_START_GUIDELINES", "SHARED_BROWSER_PLAYBOOK_GUIDELINES", "TOOL_PROMPT_GUIDELINES_PREFIX"]) {
    if (!Array.isArray(playbook[exportName]) || playbook[exportName].length === 0) fail(`Tier B export missing/empty: ${exportName}`);
}

// Config-driven lines keep their place in the assembly (after the canonical block).
const withConfig = buildToolPromptGuidelines({
    browserExecutablePath: "/usr/bin/google-chrome-stable",
    docs: { commandReferencePath },
});
const configLines = withConfig.filter((line) => line.startsWith("agent_browser config sets"));
if (configLines.length !== 1 || withConfig[withConfig.length - 1] !== configLines[0]) {
    fail("config-driven line ('agent_browser config sets …') missing or not appended last");
}
// wave1-D fix-lane: configured-case length (config-driven lines included) is printed
// informationally only — the ≤900 budget is asserted on the canonical payload below.
const configuredPayload = withConfig.join("\n");
console.log(`configured payload (config-driven lines included): ${configuredPayload.length} chars (informational, not asserted)`);

if (payload.length > 900) fail(`payload ${payload.length} chars exceeds the 900-char budget`);

if (failed) {
    console.error("wave1-d-prompt-length: FAILED");
    process.exit(1);
}
console.log("wave1-d-prompt-length: PASS");
