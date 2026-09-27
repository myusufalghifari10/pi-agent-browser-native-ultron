// local patch: model-visible verbosity control (PATCHES.md P14).
//
// Why this exists: every result appended ~21 diagnostic prose blocks, which is useful when debugging
// the wrapper and expensive on routine calls. `verbosity` makes that cost explicit per call. It only
// ever gates *prose*; structured `details`, category fields, nextActions and every security warning
// stay intact, so a quieter result is never a less truthful one.
export const VERBOSITY_LEVELS = ["quiet", "normal", "verbose"];
export const VERBOSITY_ENV = "PI_AGENT_BROWSER_VERBOSITY";

export function normalizeVerbosity(value) {
    if (value === undefined || value === null) {
        return {};
    }
    if (typeof value !== "string") {
        return { error: `verbosity must be one of ${VERBOSITY_LEVELS.join(", ")}.` };
    }
    const normalized = value.trim().toLowerCase();
    if (!VERBOSITY_LEVELS.includes(normalized)) {
        return { error: `verbosity must be one of ${VERBOSITY_LEVELS.join(", ")}, not "${value}".` };
    }
    return { value: normalized };
}

export function resolveVerbosity({ params, env = process.env } = {}) {
    const fromParams = normalizeVerbosity(params?.verbosity);
    if (fromParams.value) {
        return fromParams.value;
    }
    const fromEnv = normalizeVerbosity(env?.[VERBOSITY_ENV]);
    return fromEnv.value ?? "normal";
}

/** Diagnostic prose blocks (Page state, Artifact lifecycle, scroll/click evidence, and similar). */
export function shouldAppendDiagnosticBlocks(verbosity) {
    return verbosity !== "quiet";
}

/** The compact list of next actions. `details.nextActions` is always present. */
export function shouldAppendNextActionText(verbosity) {
    return verbosity !== "quiet";
}

/** Long-form section headings such as the batch step matrix. */
export function shouldAppendDetailedSections(verbosity) {
    return verbosity === "verbose";
}

/**
 * Warnings that must never be suppressed: secrets were revealed, a credential was filled, an artifact
 * is unverified, or a recording is still pending. A quiet result still has to be an honest one.
 */
export function isCriticalNotice(text) {
    if (typeof text !== "string") {
        return false;
    }
    return /Secrets revealed by explicit request|credential|Credential|vault|Vault|unverified|Unverified|pending|recording|Refused|refused|Blocked|blocked/.test(text);
}

export function shouldAppendNotice(verbosity, text) {
    return verbosity !== "quiet" || isCriticalNotice(text);
}
