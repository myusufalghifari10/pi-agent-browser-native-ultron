import { isRecord, parseRefId } from "../../parsing.js";
import { redactSensitiveText } from "../../runtime.js";
import { withOptionalSessionArgs } from "../../results/next-actions.js";
import { runSessionCommandData } from "./session-state.js";
const CLICK_DISPATCH_MARKER_PREFIX = "__piAgentBrowserClickDispatchProbe_";
const CLICK_DISPATCH_CLEANUP_TIMEOUT_MS = 2_000;
const ACCESSIBLE_REF_CLICK_DISPATCH_ROLES = new Set(["button", "checkbox", "menuitem", "radio", "switch", "tab"]);
function normalizeAccessibleName(name) {
    return name.replace(/\s+/g, " ").trim().toLowerCase();
}
function getClickDispatchProbeTarget(commandTokens, refSnapshot) {
    if (commandTokens[0] !== "click" || commandTokens.includes("--new-tab"))
        return undefined;
    const selector = commandTokens[1];
    if (!selector || selector.startsWith("-"))
        return undefined;
    const refId = parseRefId(selector);
    if (refId) {
        const ref = refSnapshot?.refs?.[refId];
        if (!ref || !ACCESSIBLE_REF_CLICK_DISPATCH_ROLES.has(ref.role))
            return undefined;
        const matchingRefs = Object.values(refSnapshot?.refs ?? {}).filter((candidate) => candidate.role.toLowerCase() === ref.role.toLowerCase() && normalizeAccessibleName(candidate.name) === normalizeAccessibleName(ref.name));
        if (matchingRefs.length !== 1)
            return undefined;
        return { kind: "accessible", name: ref.name, refId, role: ref.role };
    }
    if (selector.startsWith("xpath="))
        return { kind: "xpath", selector: selector.slice("xpath=".length) };
    return undefined;
}
function getEvalResultRecord(data) {
    return isRecord(data) && isRecord(data.result) ? data.result : undefined;
}
function buildClickDispatchProbeInstallScript(probe) {
    const target = probe.target;
    const resolveTarget = target.kind === "selector"
        ? `(() => { try { return document.querySelector(${JSON.stringify(target.selector)}); } catch { return null; } })()`
        : target.kind === "xpath"
            ? `(() => { try { return document.evaluate(${JSON.stringify(target.selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch { return null; } })()`
            : `(() => {
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
  const expectedRole = ${JSON.stringify(target.role)};
  const expectedName = normalize(${JSON.stringify(target.name)});
  const inferRole = (element) => {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tagName = element.tagName.toLowerCase();
    if (tagName === "button" || tagName === "select" || tagName === "textarea") return tagName;
    if (tagName === "a" && element.hasAttribute("href")) return "link";
    if (tagName === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    return "";
  };
  const inferName = (element) => normalize(element.getAttribute("aria-label") || element.getAttribute("title") || element.value || element.textContent || "");
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    return element.getClientRects().length > 0;
  };
  const candidates = Array.from(document.querySelectorAll("button,a[href],input,select,textarea,summary,[role],[onclick],[tabindex]")).filter((element) => inferRole(element) === expectedRole && inferName(element) === expectedName && isVisible(element));
  return candidates.length === 1 ? candidates[0] : null;
})()`;
    return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const element = ${resolveTarget};
if (!element) return { status: "target-not-found", marker };
const cssEscape = (value) => {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
};
const getSelector = (node) => {
  if (!(node instanceof Element)) return undefined;
  if (node.id) return "#" + cssEscape(node.id);
  const testId = node.getAttribute("data-testid") || node.getAttribute("data-test-id");
  if (testId) return '[data-testid="' + cssEscape(testId) + '"]';
  const parts = [];
  let current = node;
  while (current && current !== document.body && parts.length < 4) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
    current = parent;
  }
  return parts.length > 0 ? parts.join(" > ") : undefined;
};
const rectInfo = (rect) => ({ bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top });
const targetRect = element ? element.getBoundingClientRect() : undefined;
const targetOutsideViewport = targetRect ? targetRect.bottom < 0 || targetRect.right < 0 || targetRect.top > window.innerHeight || targetRect.left > window.innerWidth : undefined;
let nearestScrollContainer;
if (element && targetRect) {
  for (let current = element.parentElement; current && current !== document.body; current = current.parentElement) {
    if (current.scrollHeight > current.clientHeight + 1 || current.scrollWidth > current.clientWidth + 1) {
      const containerRect = current.getBoundingClientRect();
      nearestScrollContainer = {
        selector: getSelector(current),
        tagName: current.tagName.toLowerCase(),
        targetOutsideContainer: targetRect.bottom < containerRect.top || targetRect.top > containerRect.bottom || targetRect.right < containerRect.left || targetRect.left > containerRect.right,
        targetOutsideViewport,
        rect: rectInfo(containerRect),
        scrollLeft: current.scrollLeft,
        scrollTop: current.scrollTop,
      };
      break;
    }
  }
}
const state = { events: [], target: { tagName: element.tagName.toLowerCase(), nearestScrollContainer, rect: rectInfo(targetRect), targetOutsideViewport } };
const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
const listeners = eventTypes.map((type) => {
  const listener = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const eventTarget = event.target;
    const targetMatched = path.includes(element) || eventTarget === element || (eventTarget instanceof Node && element.contains(eventTarget));
    state.events.push({ type: event.type, isTrusted: event.isTrusted === true, targetMatched });
  };
  document.addEventListener(type, listener, true);
  return [type, listener];
});
state.cleanup = () => listeners.forEach(([type, listener]) => document.removeEventListener(type, listener, true));
window[marker] = state;
return { status: "installed", marker, target: state.target };
})()`;
}
function buildClickDispatchProbeCheckScript(probe) {
    return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const state = window[marker];
const finish = (payload) => {
  if (state && typeof state.cleanup === "function") state.cleanup();
  try { delete window[marker]; } catch {}
  return payload;
};
if (!state || !Array.isArray(state.events)) return finish({ status: "probe-missing", nativeEventCount: 0, pressEventCount: 0, terminalEventCount: 0 });
const matched = state.events.filter((event) => event && event.isTrusted === true && event.targetMatched === true);
// A press that starts is NOT proof that the click landed. Only a terminal event
// (pointerup/mouseup/click reaching the target) proves the gesture completed.
// Counting pointerdown/mousedown here hid every silent block where the target was
// re-rendered or moved between press and release - see wave12 test + DEATHS.
const PRESS_EVENTS = new Set(["pointerdown", "mousedown"]);
const terminalEventCount = matched.filter((event) => !PRESS_EVENTS.has(event.type)).length;
const pressEventCount = matched.length - terminalEventCount;
const counts = { nativeEventCount: matched.length, pressEventCount, terminalEventCount };
if (terminalEventCount > 0) return finish({ status: "native-event-observed", ...counts, target: state.target });
if (pressEventCount > 0) return finish({ status: "press-observed-click-missing", ...counts, target: state.target });
return finish({ status: "no-native-event-observed", ...counts, target: state.target });
})()`;
}
function buildClickDispatchProbeCleanupScript(probe) {
    return `(() => {
const marker = ${JSON.stringify(probe.marker)};
const state = window[marker];
if (state && typeof state.cleanup === "function") state.cleanup();
try { delete window[marker]; } catch {}
return { status: "cleaned-up" };
})()`;
}
function redactClickDispatchTarget(target) {
    if (target.kind === "selector" || target.kind === "xpath") {
        return { ...target, selector: redactSensitiveText(target.selector) };
    }
    return { ...target, name: redactSensitiveText(target.name) };
}
export function formatClickDispatchDiagnosticText(diagnostic) {
    return `Click dispatch diagnostic: ${diagnostic.summary}`;
}
export function buildClickDispatchNextActions(options) {
    const retryArgs = options.commandTokens[0] === "click" || options.commandTokens[0] === "find" ? options.commandTokens : ["click", ...options.commandTokens];
    const actions = [
        {
            id: "inspect-click-dispatch-miss",
            params: { args: withOptionalSessionArgs(options.sessionName, ["snapshot", "-i"]) },
            reason: "Refresh interactive refs and verify the intended click target before retrying upstream click.",
            safety: "Read-only snapshot; the wrapper does not replay clicks in-page when upstream reports success without DOM events.",
            tool: "agent_browser",
        },
    ];
    if (options.diagnostic?.scrollContainer) {
        actions.push({
            id: "scroll-target-into-view-after-dispatch-miss",
            params: { args: withOptionalSessionArgs(options.sessionName, ["scrollintoview", retryArgs[1]].filter((item) => typeof item === "string")) },
            reason: options.diagnostic.scrollContainer.selector
                ? `The target may be outside nested scroll container ${options.diagnostic.scrollContainer.selector}; scroll the target into view before retrying the click.`
                : "The target may be inside an offscreen nested scroll container; scroll the target into view before retrying the click.",
            safety: "Use only for the same current page and target; run snapshot -i again if the page rerendered.",
            tool: "agent_browser",
        });
    }
    actions.push({
        id: "retry-click-after-dispatch-miss",
        params: { args: withOptionalSessionArgs(options.sessionName, retryArgs) },
        reason: "Retry the same upstream click after confirming the target is visible; do not assume the prior success mutated the page.",
        safety: "Only retry when the target is still intended; use page-change evidence or a fresh snapshot before continuing the workflow.",
        tool: "agent_browser",
    });
    return actions;
}
export async function prepareClickDispatchProbe(options) {
    if (!options.sessionName || options.commandTokens[0] !== "click" || options.commandTokens.includes("--new-tab"))
        return undefined;
    const target = getClickDispatchProbeTarget(options.commandTokens, options.refSnapshot);
    if (!target)
        return undefined;
    const probe = { marker: `${CLICK_DISPATCH_MARKER_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`, target };
    const installData = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal, stdin: buildClickDispatchProbeInstallScript(probe) });
    const installResult = getEvalResultRecord(installData);
    return installResult?.status === "installed" ? probe : undefined;
}
function getClickDispatchScrollContainerDiagnostic(result) {
    const target = isRecord(result.target) ? result.target : undefined;
    const scrollContainer = isRecord(target?.nearestScrollContainer) ? target.nearestScrollContainer : undefined;
    const targetOutsideViewport = typeof target?.targetOutsideViewport === "boolean" ? target.targetOutsideViewport : undefined;
    const targetOutsideContainer = typeof scrollContainer?.targetOutsideContainer === "boolean" ? scrollContainer.targetOutsideContainer : undefined;
    if (!scrollContainer && !targetOutsideViewport)
        return undefined;
    if (targetOutsideContainer !== true && targetOutsideViewport !== true)
        return undefined;
    const selector = typeof scrollContainer?.selector === "string" ? redactSensitiveText(scrollContainer.selector) : undefined;
    const summary = selector
        ? `Target appears outside nested scroll container ${selector}; use scrollintoview on the target or scroll that container before retrying.`
        : "Target appears outside the viewport or a nested scroll container; use scrollintoview on the target before retrying.";
    return { selector, summary, targetOutsideContainer, targetOutsideViewport };
}
export async function collectClickDispatchDiagnostic(options) {
    if (!options.probe || !options.sessionName)
        return undefined;
    const data = await runSessionCommandData({ args: ["eval", "--stdin"], cwd: options.cwd, namespace: options.namespace, sessionName: options.sessionName, signal: options.signal, stdin: buildClickDispatchProbeCheckScript(options.probe) });
    const result = getEvalResultRecord(data);
    if (!result)
        return undefined;
    options.probe.cleaned = true;
    const status = typeof result.status === "string" ? result.status : undefined;
    const PRESS_ONLY_MISS = "press-observed-click-missing";
    if (status !== "no-native-event-observed" && status !== PRESS_ONLY_MISS)
        return undefined;
    const nativeEventCount = typeof result.nativeEventCount === "number" ? result.nativeEventCount : 0;
    const pressEventCount = typeof result.pressEventCount === "number" ? result.pressEventCount : 0;
    const terminalEventCount = typeof result.terminalEventCount === "number" ? result.terminalEventCount : 0;
    const scrollContainer = getClickDispatchScrollContainerDiagnostic(result);
    // Pressing without a completing click is the signature of a target that moved or was
    // re-rendered between mousedown and mouseup, so say that instead of the generic miss.
    const pressOnly = status === PRESS_ONLY_MISS;
    const targetLabel = pressOnly
        ? `the press reached the element (${pressEventCount} press event(s)) and the click never completed (0 terminal events)`
        : "no trusted DOM event reached the selected element";
    const summary = pressOnly
        ? `Upstream click reported success but ${targetLabel} (0 terminal events). The element was most likely re-rendered, replaced, or moved between press and release - re-snapshot to get fresh refs, then click the new node by its current position.`
        : scrollContainer
            ? `Upstream click reported success but ${targetLabel}. ${scrollContainer.summary}`
            : `Upstream click reported success but ${targetLabel}. Gather evidence with snapshot or page-change checks, then retry upstream click or report the workflow issue; the wrapper does not replay clicks in-page.`;
    return {
        nativeEventCount,
        ...(pressEventCount > 0 ? { pressEventCount } : {}),
        ...(terminalEventCount > 0 ? { terminalEventCount } : {}),
        reason: pressOnly ? "native-press-without-terminal-click-event" : "native-click-produced-no-target-dom-event",
        ...(pressOnly ? { pressOnly: true } : {}),
        ...(scrollContainer ? { scrollContainer } : {}),
        status,
        summary,
        target: redactClickDispatchTarget(options.probe.target),
    };
}
export async function cleanupClickDispatchProbe(options) {
    if (!options.probe || options.probe.cleaned || !options.sessionName)
        return;
    await runSessionCommandData({
        args: ["eval", "--stdin"],
        cwd: options.cwd,
        namespace: options.namespace,
        sessionName: options.sessionName,
        stdin: buildClickDispatchProbeCleanupScript(options.probe),
        timeoutMs: CLICK_DISPATCH_CLEANUP_TIMEOUT_MS,
    }).catch(() => undefined);
}
