// local patch: `debug` input mode — one-shot devtools report compiled onto upstream
// `batch --bail`. Mirrors the qa/job compilers, but the whole point is the REPORT:
// page context, console/page errors, failed requests and one bounded page expression
// in a single tool call instead of four.
import { isRecord } from "../parsing.js";
import { summarizeNetworkFailures } from "../results/network.js";
import { withOptionalSessionArgs } from "../results/next-actions.js";
import { getBatchResultItems, getCommandNameFromBatchItem } from "./shared.js";
import { AGENT_BROWSER_QA_LOAD_STATES } from "./types.js";

export const DEBUG_LOAD_STATES = [...AGENT_BROWSER_QA_LOAD_STATES];

// Bounds are exported so the schema/docs and the tests can reference one source of truth.
export const DEBUG_LIMITS = {
    consoleErrors: 20,
    evalExpressionChars: 4_000,
    evalResultChars: 2_000,
    failureTextChars: 300,
    urlChars: 500,
    maxFailures: 10,
    maxFailuresCap: 50,
    predicateTextNodes: 6_000,
    predicateElements: 3_000,
};

const DEBUG_DEFAULT_LOAD_STATE = "domcontentloaded";

function truncateText(value, maxChars) {
    const text = typeof value === "string" ? value : String(value ?? "");
    return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;
}

function getFirstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0)
            return value;
    }
    return undefined;
}

function getNonEmptyStringError(input, field, label) {
    const value = input[field];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
        return `${label}.${field} must be a non-empty string when provided.`;
    }
    return undefined;
}

function getExpectedTextEntries(input) {
    const raw = input.expectedText;
    if (raw === undefined)
        return { entries: [] };
    const entries = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;
    if (!entries || entries.some((text) => typeof text !== "string" || text.trim().length === 0)) {
        return { error: "debug.expectedText must be a non-empty string or array of non-empty strings when provided." };
    }
    return { entries };
}

// Bounded visible-text predicate. Semantics intentionally match the qa preset predicate
// (visible nodes only, whitespace-normalized, substring match) so a debug check and a qa
// check agree, but this one RETURNS a boolean instead of driving `wait --fn`: the debug
// report must survive a miss, and `--bail` would otherwise discard every diagnostic read
// that comes after a failed assertion step.
function buildExpectedTextPredicate(text) {
    return `(() => {
  try {
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
    for (let node = textWalker.nextNode(); node && visitedText < ${DEBUG_LIMITS.predicateTextNodes}; node = textWalker.nextNode(), visitedText += 1) {
      if (!hasVisibleAncestors(node)) continue;
      if (normalize(node.nodeValue).includes(expected)) return true;
    }
    const elementWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let visitedElements = 0;
    for (let node = elementWalker.nextNode(); node && visitedElements < ${DEBUG_LIMITS.predicateElements}; node = elementWalker.nextNode(), visitedElements += 1) {
      const element = node;
      if (!isVisibleElement(element) || !("value" in element)) continue;
      if (normalize(element.value).includes(expected)) return true;
    }
    return false;
  } catch {
    return false;
  }
})()`;
}

function buildExpectedSelectorPredicate(selector) {
    return `(() => {
  try {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  } catch {
    return false;
  }
})()`;
}

// The expression is evaluated once; a function VALUE is called, an already-called IIFE stays
// as-is. Everything is wrapped in try/catch so a broken expression cannot fail the batch and
// swallow the diagnostic reads that follow it.
function buildEvalExpressionSource(expression) {
    return `(() => {
  try {
    const __v = (${expression});
    const __r = typeof __v === "function" ? __v() : __v;
    return { ok: true, value: __r };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
})()`;
}

function deriveDebugNetworkScopeFilter(url) {
    if (typeof url !== "string" || url.length === 0) {
        return undefined;
    }
    try {
        const parsed = new URL(url);
        return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }
    catch {
        return undefined;
    }
}
export function compileAgentBrowserDebug(input) {
    if (!isRecord(input)) {
        return { error: "debug must be an object." };
    }
    const url = input.url;
    if (url !== undefined && (typeof url !== "string" || url.trim().length === 0)) {
        return { error: "debug.url must be a non-empty string when provided." }
    }
    // wave22: `debug` never handled `session` at all — the field was absent from the compiler entirely, so a
    // report requested for a named session silently ran against the root session. Found live: a checkConsole
    // on ultron1 reported "about:blank" with an empty title while ultron1 was on a real page, and the report
    // looked internally consistent, which is what makes it dangerous. A devtools report for the wrong tab is
    // worse than no report, because it reads as a clean bill of health.
    // sourceLookup had the identical defect and was fixed earlier in this wave; this mirrors it, and the
    // argv helper is the same one job and act use.
    const session = input.session;
    if (session !== undefined && (typeof session !== "string" || session.trim().length === 0)) {
        return { error: "debug.session must be a non-empty string when provided." };
    }
    const normalizedUrl = typeof url === "string" ? url.trim() : undefined;
    const expectedText = getExpectedTextEntries(input);
    if (expectedText.error)
        return { error: expectedText.error };
    const expectedSelectorError = getNonEmptyStringError(input, "expectedSelector", "debug");
    if (expectedSelectorError)
        return { error: expectedSelectorError };
    const evalExpressionError = getNonEmptyStringError(input, "evalExpression", "debug");
    if (evalExpressionError)
        return { error: evalExpressionError };
    const screenshotPathError = getNonEmptyStringError(input, "screenshotPath", "debug");
    if (screenshotPathError)
        return { error: screenshotPathError };
    const networkFilterError = getNonEmptyStringError(input, "networkFilter", "debug");
    if (networkFilterError)
        return { error: networkFilterError };
    for (const field of ["checkConsole", "checkErrors", "checkNetwork", "includeSnapshot"]) {
        if (input[field] !== undefined && typeof input[field] !== "boolean") {
            return { error: `debug.${field} must be a boolean when provided.` };
        }
    }
    const rawLoadState = input.loadState;
    if (rawLoadState !== undefined && (typeof rawLoadState !== "string" || !DEBUG_LOAD_STATES.includes(rawLoadState))) {
        return { error: `debug.loadState must be one of: ${DEBUG_LOAD_STATES.join(", ")}.` };
    }
    const rawMaxFailures = input.maxFailures;
    if (rawMaxFailures !== undefined && (typeof rawMaxFailures !== "number" || !Number.isInteger(rawMaxFailures) || rawMaxFailures <= 0)) {
        return { error: "debug.maxFailures must be a positive integer when provided." };
    }
    if (typeof rawMaxFailures === "number" && rawMaxFailures > DEBUG_LIMITS.maxFailuresCap) {
        return { error: `debug.maxFailures must be ${DEBUG_LIMITS.maxFailuresCap} or less.` };
    }
    const evalExpression = typeof input.evalExpression === "string" ? input.evalExpression : undefined;
    if (evalExpression !== undefined && evalExpression.length > DEBUG_LIMITS.evalExpressionChars) {
        return { error: `debug.evalExpression must be ${DEBUG_LIMITS.evalExpressionChars} characters or less.` };
    }
    const checkConsole = typeof input.checkConsole === "boolean" ? input.checkConsole : true;
    const checkErrors = typeof input.checkErrors === "boolean" ? input.checkErrors : true;
    const checkNetwork = typeof input.checkNetwork === "boolean" ? input.checkNetwork : true;
    const loadState = typeof rawLoadState === "string" ? rawLoadState : DEBUG_DEFAULT_LOAD_STATE;
    const screenshotPath = typeof input.screenshotPath === "string" ? input.screenshotPath : undefined;
    const networkFilter = typeof input.networkFilter === "string" ? input.networkFilter : undefined;
    const includeSnapshot = input.includeSnapshot === true || screenshotPath !== undefined;
    const steps = [];
    // Attached debugging (no url) has no page context to report, so read it first. With a url
    // the open row already carries url + title.
    if (!normalizedUrl) {
        steps.push({ action: "wait", args: ["get", "url"], generatedFrom: "debug.pageContext" });
        steps.push({ action: "wait", args: ["get", "title"], generatedFrom: "debug.pageContext" });
    }
    else {
        steps.push({ action: "open", args: ["open", normalizedUrl] });
        steps.push({ action: "wait", args: ["wait", "--load", loadState], generatedFrom: "debug.loadState" });
    }
    for (const text of expectedText.entries) {
        steps.push({ action: "wait", args: ["eval", buildExpectedTextPredicate(text)], generatedFrom: "debug.expectedText" });
    }
    if (typeof input.expectedSelector === "string") {
        steps.push({ action: "wait", args: ["eval", buildExpectedSelectorPredicate(input.expectedSelector)], generatedFrom: "debug.expectedSelector" });
    }
    if (evalExpression !== undefined) {
        steps.push({ action: "wait", args: ["eval", buildEvalExpressionSource(evalExpression)], generatedFrom: "debug.evalExpression" });
    }
    if (checkConsole)
        steps.push({ action: "wait", args: ["console"], generatedFrom: "debug.console" });
    if (checkErrors)
        steps.push({ action: "wait", args: ["errors"], generatedFrom: "debug.errors" });
    if (checkNetwork) {
        steps.push({
            action: "wait",
            // local patch fix: `--current-page` is a wrapper-only early-result filter that does NOT apply inside a
            // batch step (it is only parsed for a top-level `network requests` command), so a batch step must scope
            // itself the way upstream understands: a plain `--filter` derived from the URL being debugged.
            args: (networkFilter ?? deriveDebugNetworkScopeFilter(input.url)) ? ["network", "requests", "--filter", networkFilter ?? deriveDebugNetworkScopeFilter(input.url)] : ["network", "requests"],
            generatedFrom: "debug.network",
        });
    }
    if (includeSnapshot)
        steps.push({ action: "snapshot", args: ["snapshot", "-i"], generatedFrom: "debug.snapshot" });
    if (screenshotPath !== undefined)
        steps.push({ action: "screenshot", args: ["screenshot", screenshotPath], generatedFrom: "debug.screenshot" });
    return {
        compiled: {
            args: withOptionalSessionArgs(session, ["batch", "--bail"]),
            checks: {
                checkConsole,
                checkErrors,
                checkNetwork,
                expectedSelector: typeof input.expectedSelector === "string" ? input.expectedSelector : undefined,
                expectedText: expectedText.entries,
                includeSnapshot,
                loadState,
                maxFailures: typeof rawMaxFailures === "number" ? rawMaxFailures : DEBUG_LIMITS.maxFailures,
                networkFilter,
                screenshotPath,
                url: normalizedUrl,
            },
            failFast: true,
            stdin: JSON.stringify(steps.map((step) => step.args)),
            steps,
        },
    };
}

// Batch rows carry no `generatedFrom` and `--bail` can truncate them, so rows are
// classified by command name plus their ordinal among `eval` rows instead of by absolute
// step index. The eval ordinals are deterministic: expectedText entries, then the optional
// expectedSelector check, then the optional evalExpression.
function getExpectedEvalRoles(input) {
    const checks = isRecord(input) ? input : {};
    const expectedText = getExpectedTextEntries(checks).entries ?? [];
    const roles = expectedText.map(() => "debug.expectedText");
    if (typeof checks.expectedSelector === "string")
        roles.push("debug.expectedSelector");
    if (typeof checks.evalExpression === "string")
        roles.push("debug.evalExpression");
    return roles;
}

function extractRowString(item) {
    const result = item.result;
    if (typeof result === "string")
        return result;
    if (!isRecord(result))
        return undefined;
    return getFirstString(result.result, result.url, result.title, result.text, result.value);
}

function extractPageContext(items) {
    let url;
    let title;
    for (const item of items) {
        const commandName = getCommandNameFromBatchItem(item);
        if (commandName === "get") {
            const value = extractRowString(item);
            if (!value)
                continue;
            const subcommand = Array.isArray(item.command) && typeof item.command[1] === "string" ? item.command[1] : undefined;
            if (subcommand === "title") {
                title ??= value;
                continue;
            }
            url ??= value;
            continue;
        }
        if (commandName === "open" && isRecord(item.result)) {
            url ??= getFirstString(item.result.url);
            title ??= getFirstString(item.result.title);
        }
    }
    return { title, url };
}

function formatConsoleEntry(message) {
    if (typeof message === "string")
        return truncateText(message, DEBUG_LIMITS.failureTextChars);
    if (!isRecord(message))
        return truncateText(String(message ?? ""), DEBUG_LIMITS.failureTextChars);
    const type = getFirstString(message.type, message.level) ?? "log";
    const text = getFirstString(message.text, message.message) ?? "";
    const location = getFirstString(message.location, message.url);
    const suffix = location ? ` @ ${location}` : "";
    return truncateText(`${type}: ${text}${suffix}`, DEBUG_LIMITS.failureTextChars);
}

function getConsoleEntryType(message) {
    if (isRecord(message))
        return (getFirstString(message.type, message.level) ?? "log").toLowerCase();
    return "log";
}

function getConsoleEntryText(message) {
    if (typeof message === "string")
        return message;
    if (!isRecord(message))
        return String(message ?? "");
    return getFirstString(message.text, message.message) ?? "";
}

function formatPageError(error) {
    if (typeof error === "string")
        return truncateText(error, DEBUG_LIMITS.failureTextChars);
    if (!isRecord(error))
        return truncateText(String(error ?? ""), DEBUG_LIMITS.failureTextChars);
    const text = getFirstString(error.text, error.message) ?? "";
    const name = getFirstString(error.name, error.type);
    return truncateText(name ? `${name}: ${text}` : text, DEBUG_LIMITS.failureTextChars);
}

function getEvalPayload(item) {
    const result = item?.result;
    if (isRecord(result) && (typeof result.ok === "boolean" || "value" in result || "error" in result))
        return { error: typeof result.error === "string" ? result.error : undefined, ok: result.ok !== false, value: result.value };
    if (isRecord(result) && "result" in result)
        return { ok: item?.success !== false, value: result.result };
    return { ok: item?.success !== false, value: result };
}

function formatEvalValue(value) {
    if (value === undefined)
        return undefined;
    if (typeof value === "string")
        return truncateText(value, DEBUG_LIMITS.evalResultChars);
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === "string" ? truncateText(serialized, DEBUG_LIMITS.evalResultChars) : undefined;
    }
    catch {
        return truncateText(String(value), DEBUG_LIMITS.evalResultChars);
    }
}

export function analyzeDebugPresetResults(rows, input) {
    const items = getBatchResultItems(rows);
    const checks = isRecord(input) ? input : {};
    const expectedEvalRoles = getExpectedEvalRoles(checks);
    let evalCursor = 0;
    const maxFailures = typeof checks.maxFailures === "number" && Number.isInteger(checks.maxFailures) && checks.maxFailures > 0
        ? Math.min(checks.maxFailures, DEBUG_LIMITS.maxFailuresCap)
        : DEBUG_LIMITS.maxFailures;
    const failureChecks = [];
    const warnings = [];
    const consoleErrors = [];
    const pageErrors = [];
    const failedRequests = [];
    let actionableFailures = 0;
    let benignFailures = 0;
    let overflowFailures = 0;
    let evalResult;
    let evalError;
    let expectedTextMissing = false;
    let expectedSelectorMissing = false;
    let expectedTextChecked = 0;
    let failedSteps = 0;
    for (const item of items) {
        const commandName = getCommandNameFromBatchItem(item);
        // Eval roles are consumed in plan order even when the row itself failed, so a failed
        // check cannot shift every later eval row onto the wrong role.
        const evalRole = commandName === "eval" ? expectedEvalRoles[evalCursor++] : undefined;
        if (item.success === false) {
            failedSteps += 1;
            failureChecks.push(`${commandName ?? "step"} failed`);
            continue;
        }
        const result = isRecord(item.result) ? item.result : undefined;
        if (evalRole === "debug.expectedText") {
            expectedTextChecked += 1;
            const passed = item.result === true || result?.result === true;
            if (!passed)
                expectedTextMissing = true;
            continue;
        }
        if (evalRole === "debug.expectedSelector") {
            const passed = item.result === true || result?.result === true;
            if (!passed)
                expectedSelectorMissing = true;
            continue;
        }
        if (evalRole === "debug.evalExpression") {
            const payload = getEvalPayload(item);
            if (payload.ok === false && payload.error) {
                evalError = truncateText(payload.error, DEBUG_LIMITS.failureTextChars);
                warnings.push(`debug.evalExpression did not run: ${evalError}`);
            }
            else {
                evalResult = formatEvalValue(payload.value);
            }
            continue;
        }
        if (commandName === "console" && Array.isArray(result?.messages)) {
            for (const message of result.messages) {
                const type = getConsoleEntryType(message);
                if (type === "pageerror") {
                    pageErrors.push(formatConsoleEntry(message));
                    continue;
                }
                if (/error/i.test(type))
                    consoleErrors.push(formatConsoleEntry(message));
            }
        }
        if (commandName === "errors" && Array.isArray(result?.errors)) {
            for (const error of result.errors)
                pageErrors.push(formatPageError(error));
        }
        if (commandName === "network" && Array.isArray(result?.requests)) {
            const summary = summarizeNetworkFailures(result.requests);
            actionableFailures += summary.actionableCount;
            benignFailures += summary.benignCount;
            // Method lives on the request row, not on the classification, so keep one lookup
            // instead of re-scanning the array per failure.
            const methodByUrl = new Map();
            for (const request of result.requests) {
                if (!isRecord(request))
                    continue;
                const requestUrl = getFirstString(request.url);
                const method = getFirstString(request.method);
                if (requestUrl && method && !methodByUrl.has(requestUrl))
                    methodByUrl.set(requestUrl, method);
            }
            for (const failure of summary.failures) {
                if (failure.impact !== "actionable")
                    continue;
                if (failedRequests.length >= maxFailures) {
                    overflowFailures += 1;
                    continue;
                }
                failedRequests.push({
                    status: failure.status,
                    method: failure.url ? methodByUrl.get(failure.url) : undefined,
                    url: failure.url,
                });
            }
        }
    }
    const boundedConsoleErrors = consoleErrors.slice(0, DEBUG_LIMITS.consoleErrors);
    const boundedPageErrors = pageErrors.slice(0, DEBUG_LIMITS.consoleErrors);
    if (boundedPageErrors.length > 0)
        failureChecks.push(`${pageErrors.length} page error(s)`);
    if (boundedConsoleErrors.length > 0)
        failureChecks.push(`${consoleErrors.length} console error(s)`);
    if (actionableFailures > 0)
        failureChecks.push(`${actionableFailures} actionable failed network request(s)`);
    if (expectedTextMissing)
        failureChecks.push("expected text not found");
    if (expectedSelectorMissing)
        failureChecks.push("expected selector not visible");
    if (benignFailures > 0)
        warnings.push(`${benignFailures} benign network request failure(s) ignored`);
    if (overflowFailures > 0)
        warnings.push(`${overflowFailures} further failed request(s) omitted (debug.maxFailures=${maxFailures})`);
    const uniqueFailures = [...new Set(failureChecks)];
    const uniqueWarnings = [...new Set(warnings)];
    const { title, url } = extractPageContext(items);
    const counts = {
        actionableFailedRequests: actionableFailures,
        benignFailedRequests: benignFailures,
        consoleErrors: consoleErrors.length,
        expectedTextChecked,
        failedRequests: failedRequests.length,
        failedSteps,
        pageErrors: pageErrors.length,
        steps: items.length,
    };
    const summaryParts = [`${counts.consoleErrors} console error(s)`, `${counts.pageErrors} page error(s)`, `${counts.actionableFailedRequests} actionable failed request(s)`];
    const pageLabel = url ? ` on ${truncateText(url, DEBUG_LIMITS.urlChars)}` : "";
    if (uniqueFailures.length === 0) {
        const summary = items.length === 0
            ? "Debug report: no batch steps were returned, so nothing was inspected."
            : `Debug report: no failures detected${pageLabel} (${summaryParts.join(", ")}; ${items.length} step(s)).`;
        return {
            failedChecks: [],
            report: {
                consoleErrors: boundedConsoleErrors,
                counts,
                evalResult,
                expectedSelectorMissing,
                expectedTextMissing,
                failedRequests,
                pageErrors: boundedPageErrors,
                summary,
                title,
                url,
            },
            warnings: uniqueWarnings,
        };
    }
    return {
        failedChecks: uniqueFailures,
        report: {
            consoleErrors: boundedConsoleErrors,
            counts,
            evalResult,
            expectedSelectorMissing,
            expectedTextMissing,
            failedRequests,
            pageErrors: boundedPageErrors,
            summary: `Debug report: ${uniqueFailures.join("; ")}${pageLabel} (${summaryParts.join(", ")}; ${items.length} step(s)).`,
            title,
            url,
        },
        warnings: uniqueWarnings,
    };
}
