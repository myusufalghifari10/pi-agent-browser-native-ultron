import { isRecord } from "../parsing.js";
import { withOptionalSessionArgs } from "../results/next-actions.js";
import { summarizeNetworkFailures } from "../results/network.js";
import { getBatchResultItems, getCommandNameFromBatchItem, getSelectValues } from "./shared.js";
import { compileAgentBrowserSemanticAction } from "./semantic-action.js";
import { AGENT_BROWSER_JOB_STEP_ACTIONS, AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS, AGENT_BROWSER_QA_LOAD_STATES, } from "./types.js";
// wave9 (open loop W-O1): an optional `session` on job/qa makes the compiled batch run on a
// caller-named session instead of the implicit pi-root session. It is a GLOBAL argv flag, so it
// only changes compiled args — the batch stdin step rows stay byte-identical. MAX_SESSION_CHARS
// mirrors vault-mode.js and checkpoint.js.
const MAX_SESSION_CHARS = 64;
function normalizeOptionalJobSession(input, label) {
    const value = input.session;
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `${label} must be a non-empty string when provided.` };
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_SESSION_CHARS) {
        return { error: `${label} must be ${MAX_SESSION_CHARS} characters or fewer.` };
    }
    if (/\s/.test(trimmed) || trimmed.includes("\u0000")) {
        return { error: `${label} must not contain whitespace or NUL bytes.` };
    }
    return { value: trimmed };
}
function getRequiredJobString(step, field, action) {
    const value = step[field];
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `job step ${action} requires a non-empty ${field} string.` };
    }
    return { value };
}
function compileJobClickOrFillStep(step, action) {
    const hasSelector = typeof step.selector === "string" && step.selector.trim().length > 0;
    const hasLocator = step.locator !== undefined || step.role !== undefined || step.name !== undefined || step.value !== undefined;
    if (hasSelector && hasLocator) {
        return { error: `job step ${action} must use either selector or semantic locator fields, not both.` };
    }
    if (hasSelector) {
        if (action === "click")
            return { args: ["click", step.selector] };
        const text = getRequiredJobString(step, "text", action);
        if (text.error)
            return { error: text.error };
        return { args: ["fill", step.selector, text.value] };
    }
    if (!hasLocator) {
        return { error: `job step ${action} requires either a non-empty selector string or semantic locator fields.` };
    }
    const compiled = compileAgentBrowserSemanticAction({
        action,
        locator: step.locator,
        name: step.name,
        role: step.role,
        text: step.text,
        value: step.value,
    });
    if (compiled.error)
        return { error: compiled.error.replaceAll("semanticAction", `job step ${action}`) };
    return { args: compiled.compiled?.args };
}
function getUnsupportedJobStepField(step, allowedFields) {
    return Object.keys(step).find((field) => !allowedFields.has(field));
}
function getUnsupportedJobStepFieldError(step, action, allowedFields) {
    const unsupportedField = getUnsupportedJobStepField(step, allowedFields);
    if (!unsupportedField)
        return undefined;
    const supportedFields = [...allowedFields].filter((field) => field !== "action");
    const supportedText = supportedFields.length > 0 ? `supported fields are ${supportedFields.join(", ")}.` : "no additional fields are supported.";
    return `job step ${action} does not support ${unsupportedField}; ${supportedText}`;
}
const JOB_STEP_ALLOWED_FIELDS = {
    assertText: new Set(["action", "text"]),
    assertUrl: new Set(["action", "url"]),
    click: new Set(["action", "locator", "name", "role", "selector", "value"]),
    fill: new Set(["action", "locator", "name", "role", "selector", "text", "value"]),
    open: new Set(["action", "loadState", "url"]),
    screenshot: new Set(["action", "path"]),
    select: new Set(["action", "selector", "value", "values"]),
    snapshot: new Set(["action"]),
    type: new Set(["action", "delayMs", "press", "selector", "text"]),
    wait: new Set(["action", "milliseconds"]),
    waitForDownload: new Set(["action", "path"]),
};
function compileJobTypeSteps(step) {
    const text = getRequiredJobString(step, "text", "type");
    if (text.error)
        return { error: text.error };
    const selector = step.selector;
    if (selector !== undefined && (typeof selector !== "string" || selector.trim().length === 0)) {
        return { error: "job step type selector must be a non-empty string when provided." };
    }
    const delayMs = step.delayMs;
    if (delayMs !== undefined && (typeof delayMs !== "number" || !Number.isInteger(delayMs) || delayMs <= 0)) {
        return { error: "job step type delayMs must be a positive integer when provided." };
    }
    const press = step.press;
    if (press !== undefined && (typeof press !== "string" || press.trim().length === 0)) {
        return { error: "job step type press must be a non-empty key string when provided." };
    }
    const typedText = text.value;
    const typedChars = Array.from(typedText);
    if (typedChars.length === 0)
        return { error: "job step type requires non-empty text." };
    if (delayMs !== undefined && typedChars.length > AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS) {
        return { error: `job step type delayMs supports at most ${AGENT_BROWSER_JOB_TYPE_DELAYED_TEXT_MAX_CHARACTERS} characters; split longer text into shorter calls or omit delayMs.` };
    }
    const compiledSteps = [];
    if (delayMs === undefined) {
        compiledSteps.push({ action: "type", args: typeof selector === "string" ? ["type", selector, typedText] : ["keyboard", "type", typedText] });
    }
    else {
        if (typeof selector === "string")
            compiledSteps.push({ action: "type", args: ["focus", selector], generatedFrom: "type.selector" });
        for (const [index, char] of typedChars.entries()) {
            compiledSteps.push({ action: "type", args: ["keyboard", "type", char], generatedFrom: "type.delayMs" });
            if (index < typedChars.length - 1)
                compiledSteps.push({ action: "wait", args: ["wait", String(delayMs)], generatedFrom: "type.delayMs" });
        }
    }
    if (typeof press === "string")
        compiledSteps.push({ action: "type", args: ["press", press], generatedFrom: "type.press" });
    return { steps: compiledSteps };
}
function compileOpenJobStep(step, index) {
    const result = getRequiredJobString(step, "url", "open");
    if (result.error)
        return { error: result.error };
    const extraSteps = [];
    if (step.loadState !== undefined) {
        if (typeof step.loadState !== "string" || !AGENT_BROWSER_QA_LOAD_STATES.includes(step.loadState)) {
            return { error: `job.steps[${index}].loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
        }
        extraSteps.push({ action: "wait", args: ["wait", "--load", step.loadState], generatedFrom: "open.loadState" });
    }
    return { args: ["open", result.value], extraSteps };
}
function compileClickJobStep(step) {
    return compileJobClickOrFillStep(step, "click");
}
function compileFillJobStep(step) {
    return compileJobClickOrFillStep(step, "fill");
}
function compileTypeJobStep(step) {
    const result = compileJobTypeSteps(step);
    if (result.error)
        return { error: result.error };
    const [firstStep, ...extraSteps] = result.steps;
    return { args: firstStep.args, extraSteps, generatedFrom: firstStep.generatedFrom };
}
function compileSelectJobStep(step, index) {
    const selector = getRequiredJobString(step, "selector", "select");
    if (selector.error)
        return { error: selector.error };
    const values = getSelectValues(step, `job.steps[${index}]`);
    if (values.error)
        return { error: values.error };
    return { args: ["select", selector.value, ...values.values] };
}
function compileWaitJobStep(step) {
    const milliseconds = step.milliseconds;
    if (typeof milliseconds !== "number" || !Number.isInteger(milliseconds) || milliseconds <= 0) {
        return { error: "job step wait requires a positive integer milliseconds value." };
    }
    return { args: ["wait", String(milliseconds)] };
}
function compileAssertTextJobStep(step) {
    const result = getRequiredJobString(step, "text", "assertText");
    if (result.error)
        return { error: result.error };
    return { args: ["wait", "--text", result.value] };
}
function compileAssertUrlJobStep(step) {
    const result = getRequiredJobString(step, "url", "assertUrl");
    if (result.error)
        return { error: result.error };
    return { args: ["wait", "--url", result.value] };
}
function compilePathArtifactJobStep(step, action) {
    const result = getRequiredJobString(step, "path", action);
    if (result.error)
        return { error: result.error };
    return { args: action === "waitForDownload" ? ["wait", "--download", result.value] : ["screenshot", result.value] };
}
// FINAL-DESIGN.md pillar A reshape item 2 (§5 step 4): job++ verification receipts. An optional
// per-step `probe` compiles to one extra upstream verification row appended right after the
// step's own rows. Probe rows are wrapper-generated evidence — additive receipts, never a
// license for blind execution (the settle-retry ladder stays the recovery path).
const JOB_STEP_PROBE_TYPES = ["url", "text", "visible", "value"];
const JOB_PROBE_ALLOWED_FIELDS = new Set(["type", "value"]);
const JOB_STEP_PROBE_ROWS = {
    url: (value) => ({ action: "wait", args: ["wait", "--url", value, "--timeout", "5000"] }),
    text: (value) => ({ action: "wait", args: ["wait", "--text", value, "--timeout", "5000"] }),
    visible: (value) => ({ action: "is", args: ["is", "visible", value] }),
    value: (value) => ({ action: "get", args: ["get", "value", value] }),
};
function compileJobStepProbeRows(step, jobAction, index) {
    if (step.probe === undefined)
        return { rows: [] };
    if (!isRecord(step.probe))
        return { error: "probe must be an object." };
    const unsupportedField = Object.keys(step.probe).find((field) => !JOB_PROBE_ALLOWED_FIELDS.has(field));
    if (unsupportedField)
        return { error: `probe does not support ${unsupportedField}; supported fields are type, value.` };
    if (typeof step.probe.type !== "string" || !JOB_STEP_PROBE_TYPES.includes(step.probe.type))
        return { error: `probe.type must be one of: ${JOB_STEP_PROBE_TYPES.join(", ")}.` };
    if (typeof step.probe.value !== "string" || step.probe.value.trim().length === 0)
        return { error: `probe.value is required for ${step.probe.type} probes and must be a non-empty string.` };
    const row = JOB_STEP_PROBE_ROWS[step.probe.type](step.probe.value);
    return {
        rows: [{
            action: row.action,
            args: row.args,
            generatedFrom: "job.probe",
            // Wrapper-generated row marker + owner attribution (mirrors compiledQaPreset's generatedFrom).
            probe: { stepAction: jobAction, stepIndex: index, type: step.probe.type, value: step.probe.value },
        }],
    };
}
// ponytail: allowedFields for each action live in JOB_STEP_ALLOWED_FIELDS (same key
// alignment enforced by Record<AgentBrowserJobStepAction, …>), so the compiler map no
// longer mirrors that set per entry; the call site looks it up by action.
const JOB_STEP_COMPILERS = {
    assertText: compileAssertTextJobStep,
    assertUrl: compileAssertUrlJobStep,
    click: compileClickJobStep,
    fill: compileFillJobStep,
    open: compileOpenJobStep,
    screenshot: (step) => compilePathArtifactJobStep(step, "screenshot"),
    select: compileSelectJobStep,
    snapshot: () => ({ args: ["snapshot", "-i"] }),
    type: compileTypeJobStep,
    wait: compileWaitJobStep,
    waitForDownload: (step) => compilePathArtifactJobStep(step, "waitForDownload"),
};
/** The host's array-parameter envelope: an object whose ONLY key is `item`. */
function isItemEnvelope(value) {
    return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).length === 1
        && "item" in value;
}
export function compileAgentBrowserJob(input) {
    if (!isRecord(input)) {
        return { error: "job must be an object." };
    }
    // wave22: this host wraps a NESTED array parameter in an {item: ...} envelope, so a job whose
    // `steps` is an array of arrays arrives as {item: [...]} and every step reads as a bare string
    // rather than an object. That is the same host behaviour that makes caller-supplied `batch`
    // unusable, reaching it through the job object instead; it is a documented runner bug
    // (hermes-agent#104803) and this Pi build stringifies parameters at the same time
    // (earendil-works/pi#4226).
    //
    // Unwrapping is safe by construction: a job step is ALWAYS an object carrying an `action`, so
    // {item: ...} can never be a legitimate step, and the strip is a no-op on any job that already
    // worked. It is recursive because the host wraps array elements at every depth, and it is
    // applied BEFORE the shape checks so those still see the real structure.
    const unwrappedInput = isItemEnvelope(input) ? input.item : input;
    if (!isRecord(unwrappedInput)) {
        return { error: "job must be an object." };
    }
    const rawFailFast = unwrappedInput.failFast;
    if (rawFailFast !== undefined && typeof rawFailFast !== "boolean") {
        return { error: "job.failFast must be a boolean when provided." };
    }
    const failFast = rawFailFast !== false;
    const session = normalizeOptionalJobSession(unwrappedInput, "job.session");
    if (session.error) {
        return { error: session.error };
    }
    const rawStepsEnvelope = unwrappedInput.steps;
    if (!isItemEnvelope(rawStepsEnvelope) && (!Array.isArray(rawStepsEnvelope) || rawStepsEnvelope.length === 0)) {
        return { error: "job.steps must be a non-empty array." };
    }
    // The envelope can sit on the job itself or on `steps`; the host has been seen to use both.
    const rawSteps = isItemEnvelope(rawStepsEnvelope) ? rawStepsEnvelope.item : rawStepsEnvelope;
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { error: "job.steps must be a non-empty array." };
    }
    const steps = [];
    for (const [index, rawStep] of rawSteps.entries()) {
        const stepInput = isItemEnvelope(rawStep) ? rawStep.item : rawStep;
        if (!isRecord(stepInput)) {
            return { error: `job.steps[${index}] must be an object.` };
        }
        const action = stepInput.action;
        if (typeof action !== "string" || !AGENT_BROWSER_JOB_STEP_ACTIONS.includes(action)) {
            return { error: `job.steps[${index}].action must be one of: ${AGENT_BROWSER_JOB_STEP_ACTIONS.join(", ")}.` };
        }
        const jobAction = action;
        const compile = JOB_STEP_COMPILERS[jobAction];
        // `probe` is valid on every step, so it joins the allowed fields at the check site.
        const unsupportedFieldError = getUnsupportedJobStepFieldError(stepInput, jobAction, new Set([...JOB_STEP_ALLOWED_FIELDS[jobAction], "probe"]));
        if (unsupportedFieldError)
            return { error: `job.steps[${index}]: ${unsupportedFieldError}` };
        const probeSteps = compileJobStepProbeRows(rawStep, jobAction, index);
        if (probeSteps.error)
            return { error: `job.steps[${index}]: ${probeSteps.error}` };
        const compiledStep = compile(rawStep, index);
        if (compiledStep.error)
            return { error: compiledStep.error.startsWith(`job.steps[${index}]`) ? compiledStep.error : `job.steps[${index}]: ${compiledStep.error}` };
        steps.push({ action: jobAction, args: compiledStep.args, generatedFrom: compiledStep.generatedFrom }, ...(compiledStep.extraSteps ?? []), ...probeSteps.rows);
    }
    return { compiled: { args: withOptionalSessionArgs(session.value, failFast ? ["batch", "--bail"] : ["batch"]), failFast, stdin: JSON.stringify(steps.map((step) => step.args)), steps } };
}
// FINAL-DESIGN.md pillar A reshape item 2 (§5 step 4): receipts for job-mode verification probes.
// Probe rows sit in compiled.steps right after their owning step, so batch rows correlate by
// position exactly like analyzeQaPresetResults; --bail truncates rows after the first failing
// step, so a missing row means the probe never ran (earlier step failed or the run ended early).
// Receipts are additive evidence, not a verdict: a failed probe fails the job only because the
// probe row IS a failed batch row under the existing batch verdict path.
export function analyzeJobReceipts(steps, batchSteps, presentation) {
    if (!Array.isArray(steps))
        return undefined;
    // No presentation means the run never produced per-row evidence; every probe stays unverified.
    const rows = presentation === undefined || !Array.isArray(batchSteps) ? [] : batchSteps;
    const receipts = [];
    for (const [rowIndex, step] of steps.entries()) {
        if (!isRecord(step) || step.generatedFrom !== "job.probe" || !isRecord(step.probe))
            continue;
        const row = rows[rowIndex];
        receipts.push({
            action: typeof step.probe.stepAction === "string" ? step.probe.stepAction : undefined,
            index: typeof step.probe.stepIndex === "number" ? step.probe.stepIndex : rowIndex,
            probe: { type: step.probe.type, value: step.probe.value },
            result: row === undefined ? "skipped" : row.success === false ? "fail" : "pass",
        });
    }
    return receipts.length > 0 ? receipts : undefined;
}
function describeQaChecksRun(checks) {
    const parts = [`load:${checks.loadState}`];
    if (checks.expectedText.length > 0)
        parts.push(`text×${checks.expectedText.length}`);
    if (checks.expectedSelector)
        parts.push("selector");
    if (checks.checkNetwork)
        parts.push("network");
    if (checks.checkConsole)
        parts.push("console");
    if (checks.checkErrors)
        parts.push("errors");
    if (checks.diagnosticsResetAtStart)
        parts.push("diagnostics-reset");
    else if (checks.checkNetwork || checks.checkConsole || checks.checkErrors)
        parts.push("attached-diagnostics-preserved");
    if (checks.screenshotPath)
        parts.push("screenshot");
    return parts.join(", ");
}
export function extractQaPageContext(options) {
    if (options.attachedTarget?.title || options.attachedTarget?.url) {
        return { title: options.attachedTarget.title, url: options.attachedTarget.url };
    }
    for (const item of getBatchResultItems(options.batchData)) {
        if (getCommandNameFromBatchItem(item) !== "open" || !isRecord(item.result))
            continue;
        const url = typeof item.result.url === "string" ? item.result.url : undefined;
        const title = typeof item.result.title === "string" ? item.result.title : undefined;
        if (url || title)
            return { title, url };
    }
    if (options.compiled?.checks.url) {
        return { url: options.compiled.checks.url };
    }
    return {};
}
export function buildQaCompactPassText(options) {
    const lines = [options.qaPreset.summary];
    const pageParts = [options.page?.title, options.page?.url].filter((part) => typeof part === "string" && part.length > 0);
    if (pageParts.length > 0)
        lines.push(`Page: ${pageParts.join(" — ")}`);
    lines.push(`Checks run: ${describeQaChecksRun(options.checks)} (${options.batchStepCount} batch step${options.batchStepCount === 1 ? "" : "s"})`);
    if (options.checks.diagnosticsResetAtStart && (options.checks.checkNetwork || options.checks.checkConsole || options.checks.checkErrors)) {
        lines.push("Diagnostic isolation: URL QA requests clears of enabled diagnostic buffers before opening the target.");
    }
    if (options.checks.attached && !options.checks.diagnosticsResetAtStart && (options.checks.checkNetwork || options.checks.checkConsole || options.checks.checkErrors)) {
        lines.push("Attached diagnostics: existing upstream session console/network/error buffers were preserved; rows may include events from before qa.attached started.");
    }
    if (options.checks.screenshotPath) {
        const verification = options.artifactVerification;
        lines.push(verification
            ? `Screenshot: ${options.checks.screenshotPath} (${verification.verifiedCount}/${verification.artifacts.length} verified on disk)`
            : `Screenshot: ${options.checks.screenshotPath}`);
    }
    lines.push("Full diagnostic matrix: see details.qaPreset and details.batchSteps.");
    return lines.join("\n");
}
export function buildQaCompactFailureText(options) {
    const lines = [options.qaPreset.summary];
    const pageParts = [options.page?.title, options.page?.url].filter((part) => typeof part === "string" && part.length > 0);
    if (pageParts.length > 0)
        lines.push(`Page: ${pageParts.join(" — ")}`);
    if (options.qaPreset.failedChecks.length > 0)
        lines.push("Failed checks:", ...options.qaPreset.failedChecks.map((failure) => `- ${failure}`));
    if (options.qaPreset.warnings.length > 0)
        lines.push("Warnings:", ...options.qaPreset.warnings.map((warning) => `- ${warning}`));
    lines.push(`Checks run: ${describeQaChecksRun(options.checks)} (${options.batchStepCount} batch step${options.batchStepCount === 1 ? "" : "s"})`);
    lines.push("Full diagnostic matrix: see details.qaPreset and details.batchSteps.");
    return lines.join("\n");
}
const QA_VISIBLE_TEXT_TIMEOUT_MS = 5_000;
function formatQaExpectedTextPreview(text) {
    return JSON.stringify(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}
function buildQaVisibleTextPredicate(text) {
    return `(() => {
  const expected = ${JSON.stringify(text)}.replace(/\\s+/g, " ").trim();
  if (!expected) return false;
  const root = document.body || document.documentElement;
  if (!root) return false;
  const skipTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG"]);
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const isVisibleElement = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    if (skipTags.has(element.tagName)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  };
  const hasVisibleAncestors = (node) => {
    for (let element = node.parentElement; element; element = element.parentElement) {
      if (!isVisibleElement(element)) return false;
      if (element === root) break;
    }
    return true;
  };
  const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let visitedText = 0;
  for (let node = textWalker.nextNode(); node && visitedText < 6000; node = textWalker.nextNode(), visitedText += 1) {
    if (!hasVisibleAncestors(node)) continue;
    if (normalize(node.nodeValue).includes(expected)) return true;
  }
  const elementWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let visitedElements = 0;
  for (let node = elementWalker.nextNode(); node && visitedElements < 3000; node = elementWalker.nextNode(), visitedElements += 1) {
    const element = node;
    if (!isVisibleElement(element) || !("value" in element)) continue;
    if (normalize(element.value).includes(expected)) return true;
  }
  return false;
})()`;
}
function qaVisibleTextWaitPassed(item, step) {
    if (step.args[0] !== "wait" || step.args[1] !== "--fn")
        return undefined;
    if (!item || item.success === false)
        return false;
    if (typeof item.result === "boolean")
        return item.result;
    if (isRecord(item.result) && typeof item.result.result === "boolean")
        return item.result.result;
    return true;
}
function extractQaTextAssertionResultText(item) {
    if (!item || item.success === false)
        return undefined;
    const result = item.result;
    if (typeof result === "string")
        return result;
    if (!isRecord(result))
        return undefined;
    for (const key of ["result", "text", "value"]) {
        const value = result[key];
        if (typeof value === "string")
            return value;
    }
    return undefined;
}
function qaErrorSignature(error) {
    if (typeof error === "string")
        return error;
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
function subtractQaBaselineErrors(errors, baselineErrors) {
    const baselineCounts = new Map();
    for (const error of baselineErrors) {
        const signature = qaErrorSignature(error);
        baselineCounts.set(signature, (baselineCounts.get(signature) ?? 0) + 1);
    }
    let matchedCount = 0;
    const novelErrors = errors.filter((error) => {
        const signature = qaErrorSignature(error);
        const count = baselineCounts.get(signature) ?? 0;
        if (count === 0)
            return true;
        baselineCounts.set(signature, count - 1);
        matchedCount += 1;
        return false;
    });
    return { matchedCount, novelErrors };
}
function isDiagnosticResetCommand(item) {
    const command = item.command;
    if (!Array.isArray(command) || !command.every((token) => typeof token === "string"))
        return false;
    const [name, subcommand] = command;
    return command.includes("--clear") && (name === "console" || name === "errors" || (name === "network" && subcommand === "requests"));
}
export function analyzeQaPresetTimeout(compiled) {
    if (compiled.checks.expectedText.length === 0)
        return undefined;
    const failedChecks = compiled.checks.expectedText.map((text) => `expected text was not verified before timeout: ${formatQaExpectedTextPreview(text)}`);
    return {
        failedChecks,
        passed: false,
        summary: `QA preset failed: ${failedChecks.join("; ")}.`,
        warnings: ["The wrapper timed out before expected-text evidence could be verified; inspect timeoutPartialProgress and retry with a narrower readiness condition if the page was still loading."],
    };
}
export function analyzeQaPresetResults(data, compiled) {
    const items = getBatchResultItems(data);
    if (items.length === 0)
        return undefined;
    const failedChecks = [];
    const warnings = [];
    const baselineErrorIndex = compiled?.checks.diagnosticsResetAtStart && compiled.checks.checkErrors
        ? compiled.steps.findIndex((step) => step.generatedFrom === "qa.errorBaselineAfterClear")
        : -1;
    const baselineErrorItem = baselineErrorIndex >= 0 ? items[baselineErrorIndex] : undefined;
    const baselineErrorResult = isRecord(baselineErrorItem?.result) ? baselineErrorItem.result : undefined;
    const baselineErrors = Array.isArray(baselineErrorResult?.errors) ? baselineErrorResult.errors : [];
    for (const [index, item] of items.entries()) {
        if (item.success === false) {
            failedChecks.push(`${getCommandNameFromBatchItem(item) ?? "step"} failed`);
        }
        if (index === baselineErrorIndex)
            continue;
        const result = isRecord(item.result) ? item.result : undefined;
        const commandName = getCommandNameFromBatchItem(item);
        if (compiled?.checks.diagnosticsResetAtStart && isDiagnosticResetCommand(item)) {
            continue;
        }
        if (commandName === "errors" && Array.isArray(result?.errors) && result.errors.length > 0) {
            const { matchedCount, novelErrors } = subtractQaBaselineErrors(result.errors, baselineErrors);
            if (novelErrors.length > 0)
                failedChecks.push(`${novelErrors.length} page error(s)`);
            if (matchedCount > 0)
                failedChecks.push(`page-error check could not be verified (${matchedCount} row(s) matched the post-clear baseline; old residue and identical new errors are indistinguishable)`);
        }
        if (commandName === "console" && Array.isArray(result?.messages)) {
            const errorCount = result.messages.filter((message) => isRecord(message) && /error/i.test(String(message.type ?? message.level ?? ""))).length;
            if (errorCount > 0)
                failedChecks.push(`${errorCount} console error message(s)`);
        }
        if (commandName === "network" && Array.isArray(result?.requests)) {
            const networkFailures = summarizeNetworkFailures(result.requests);
            if (networkFailures.actionableCount > 0)
                failedChecks.push(`${networkFailures.actionableCount} actionable failed network request(s)`);
            if (networkFailures.benignCount > 0)
                warnings.push(`${networkFailures.benignCount} benign network request failure(s) ignored`);
        }
    }
    if (compiled?.checks.expectedText.length) {
        let expectedTextIndex = 0;
        compiled.steps.forEach((step, index) => {
            if (step.action !== "assertText")
                return;
            const expected = compiled.checks.expectedText[expectedTextIndex++];
            if (!expected)
                return;
            const visibleTextPassed = qaVisibleTextWaitPassed(items[index], step);
            if (visibleTextPassed === true)
                return;
            const actual = extractQaTextAssertionResultText(items[index]);
            if (!actual || !actual.includes(expected))
                failedChecks.push(`expected text not found: ${formatQaExpectedTextPreview(expected)}`);
        });
    }
    const uniqueFailures = [...new Set(failedChecks)];
    const uniqueWarnings = [...new Set(warnings)];
    return {
        failedChecks: uniqueFailures,
        passed: uniqueFailures.length === 0,
        summary: uniqueFailures.length === 0
            ? uniqueWarnings.length === 0 ? "QA preset passed." : `QA preset passed with warnings: ${uniqueWarnings.join("; ")}.`
            : `QA preset failed: ${uniqueFailures.join("; ")}.`,
        warnings: uniqueWarnings,
    };
}
export function compileAgentBrowserQaPreset(input) {
    if (!isRecord(input)) {
        return { error: "qa must be an object." };
    }
    const session = normalizeOptionalJobSession(input, "qa.session");
    if (session.error) {
        return { error: session.error };
    }
    const attached = input.attached === true;
    if (input.attached !== undefined && typeof input.attached !== "boolean") {
        return { error: "qa.attached must be a boolean when provided." };
    }
    const url = input.url;
    if (attached && url !== undefined) {
        return { error: "qa.url must be omitted when qa.attached is true." };
    }
    if (!attached && (typeof url !== "string" || url.trim().length === 0)) {
        return { error: "qa.url must be a non-empty string." };
    }
    const normalizedUrl = typeof url === "string" ? url.trim() : undefined;
    const expectedText = input.expectedText === undefined
        ? []
        : typeof input.expectedText === "string"
            ? [input.expectedText]
            : Array.isArray(input.expectedText)
                ? input.expectedText
                : undefined;
    if (!expectedText || expectedText.some((text) => typeof text !== "string" || text.trim().length === 0)) {
        return { error: "qa.expectedText must be a non-empty string or array of non-empty strings when provided." };
    }
    const expectedSelector = input.expectedSelector;
    if (expectedSelector !== undefined && (typeof expectedSelector !== "string" || expectedSelector.trim().length === 0)) {
        return { error: "qa.expectedSelector must be a non-empty string when provided." };
    }
    const screenshotPath = input.screenshotPath;
    if (screenshotPath !== undefined && (typeof screenshotPath !== "string" || screenshotPath.trim().length === 0)) {
        return { error: "qa.screenshotPath must be a non-empty string when provided." };
    }
    for (const field of ["checkConsole", "checkErrors", "checkNetwork"]) {
        if (input[field] !== undefined && typeof input[field] !== "boolean") {
            return { error: `qa.${field} must be a boolean when provided.` };
        }
    }
    const rawLoadState = input.loadState;
    if (rawLoadState !== undefined && (typeof rawLoadState !== "string" || !AGENT_BROWSER_QA_LOAD_STATES.includes(rawLoadState))) {
        return { error: `qa.loadState must be one of: ${AGENT_BROWSER_QA_LOAD_STATES.join(", ")}.` };
    }
    const checkConsole = typeof input.checkConsole === "boolean" ? input.checkConsole : !attached;
    const checkErrors = typeof input.checkErrors === "boolean" ? input.checkErrors : !attached;
    const checkNetwork = typeof input.checkNetwork === "boolean" ? input.checkNetwork : !attached;
    const loadState = rawLoadState ?? "domcontentloaded";
    const diagnosticsResetAtStart = !attached;
    const steps = [];
    if (diagnosticsResetAtStart && checkNetwork)
        steps.push({ action: "wait", args: ["network", "requests", "--clear"] });
    if (diagnosticsResetAtStart && checkConsole)
        steps.push({ action: "wait", args: ["console", "--clear"] });
    if (diagnosticsResetAtStart && checkErrors) {
        steps.push({ action: "wait", args: ["errors", "--clear"] });
        steps.push({ action: "wait", args: ["errors"], generatedFrom: "qa.errorBaselineAfterClear" });
    }
    if (!attached && normalizedUrl)
        steps.push({ action: "open", args: ["open", normalizedUrl] });
    steps.push({ action: "wait", args: ["wait", "--load", loadState] });
    if (checkConsole || checkErrors)
        steps.push({ action: "wait", args: ["wait", "150"], generatedFrom: "qa.diagnosticSettle" });
    for (const text of expectedText) {
        steps.push({ action: "assertText", args: ["wait", "--fn", buildQaVisibleTextPredicate(text), "--timeout", String(QA_VISIBLE_TEXT_TIMEOUT_MS)] });
    }
    if (typeof expectedSelector === "string") {
        steps.push({ action: "wait", args: ["wait", expectedSelector] });
    }
    if (checkNetwork)
        steps.push({ action: "wait", args: ["network", "requests"] });
    if (checkConsole)
        steps.push({ action: "wait", args: ["console"] });
    if (checkErrors)
        steps.push({ action: "wait", args: ["errors"] });
    if (typeof screenshotPath === "string")
        steps.push({ action: "screenshot", args: ["screenshot", screenshotPath] });
    return {
        compiled: {
            args: withOptionalSessionArgs(session.value, ["batch", "--bail"]),
            checks: { attached, checkConsole, checkErrors, checkNetwork, diagnosticsResetAtStart, expectedSelector, expectedText, loadState, screenshotPath, url: normalizedUrl },
            failFast: true,
            stdin: JSON.stringify(steps.map((step) => step.args)),
            steps,
        },
    };
}
