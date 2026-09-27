import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Package root is five ".." above this file: lib → agent-browser → extensions → dist → pi-agent-browser-native.
const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
const PATCH_MANIFEST_PATH = join(PACKAGE_ROOT, "patches", "patches.manifest.json");

/** Verdict of the first check; manifest + hashes are cached so repeated spawns add no I/O. */
let cachedResult;

async function sha256File(path) {
    try {
        return createHash("sha256").update(await readFile(path)).digest("hex");
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return undefined;
        throw error;
    }
}

async function computePatchLedgerResult() {
    let rawManifest;
    try {
        rawManifest = await readFile(PATCH_MANIFEST_PATH, "utf8");
    }
    catch (error) {
        if (error?.code === "ENOENT") {
            // Fresh install without a ledger: nothing pinned yet, do not block spawning.
            return { ok: true, skipped: true, drifted: [], missing: [], manifestPath: PATCH_MANIFEST_PATH };
        }
        return driftResult(`patches/patches.manifest.json (unreadable: ${errorMessage(error)})`);
    }
    let manifest;
    try {
        manifest = JSON.parse(rawManifest);
    }
    catch (error) {
        return driftResult(`patches/patches.manifest.json (unparseable: ${errorMessage(error)})`);
    }
    const drifted = [];
    const missing = [];
    for (const entry of manifest.entries) {
        for (const file of entry.files) {
            const actual = await sha256File(join(PACKAGE_ROOT, file));
            if (actual === undefined)
                missing.push(file);
            else if (actual !== entry.sha256[file])
                drifted.push(file);
        }
    }
    return { ok: drifted.length === 0 && missing.length === 0, skipped: false, drifted, missing, manifestPath: PATCH_MANIFEST_PATH };
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function driftResult(offender) {
    return { ok: false, skipped: false, drifted: [offender], missing: [], manifestPath: PATCH_MANIFEST_PATH };
}

/**
 * Verify local-patch integrity against patches/patches.manifest.json (see PATCHES.md).
 * Drift is a hard refusal for the caller (no silent fallback); a missing manifest is tolerated
 * so a fresh install without a ledger still spawns.
 */
export async function verifyPatchLedger() {
    cachedResult ??= await computePatchLedgerResult();
    return cachedResult;
}
