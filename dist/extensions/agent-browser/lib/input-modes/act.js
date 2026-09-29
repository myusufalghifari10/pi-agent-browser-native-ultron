// wave16: `act` — a declarative find-and-act mode.
//
// Why this mode exists, measured rather than guessed. Of 435 eval --stdin calls in the 14
// use-case sweep, 169 (39%) were the model hand-writing the same thing: walk the candidates,
// pick the one whose text matches, call .click() on it. It kept doing that because upstream's
// `find` takes the FIRST match, and that has already bitten this project - `find text "Run"`
// once landed on a hidden 0x0 duplicate instead of the real button. The model learned `find`
// was unreliable and worked around it, in JavaScript, by hand, every time.
//
// `find` belongs to the upstream CLI, so the wrapper cannot change its semantics. What the
// wrapper CAN own is the JavaScript. This mode takes a declarative intent and emits one eval
// spawn whose script is generated here, so the visibility filter and the ambiguity refusal
// are written once instead of 169 times, badly.
//
// The refusal is the point. If more than one element matches, this does not pick one: the
// recorded deaths in this project are all "guessed quietly and reported success". It returns
// the candidates and their rects so the model can narrow the query, which is a real answer.
import { withOptionalSessionArgs } from "../results/next-actions.js";
import { isRecord } from "../parsing.js";

export const ACT_ALLOWED_FIELDS = new Set(["session", "find", "action", "maxMatches", "limit"]);
export const ACT_ALLOWED_FIND_FIELDS = new Set(["text", "role", "exact"]);
export const ACT_ACTIONS = new Set(["click", "read"]);
export const ACT_DEFAULT_MAX_MATCHES = 1;
export const ACT_MAX_MATCHES = 20;
export const ACT_DEFAULT_READ_LIMIT = 2000;
export const ACT_MAX_READ_LIMIT = 20000;
export const ACT_MAX_TEXT_CHARS = 200;
export const ACT_MAX_SESSION_CHARS = 64;
export const ACT_MAX_CANDIDATES_REPORTED = 10;

// A selector broad enough that `find` is not needed, narrow enough that the page's own layout
// text does not drown the result. It is a starting point, not a promise: role and text filter it.
const ACT_CANDIDATE_SELECTOR = "a,button,input,textarea,select,summary,label,[role],[onclick],[tabindex]";
const ROLE_TAG_EQUIVALENTS = new Map([["button", "button"], ["link", "a"], ["checkbox", "input"], ["radio", "input"], ["textbox", ["input", "textarea"]], ["tab", ["a", "button"]], ["menuitem", ["a", "button"]]]);

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function validateSession(value) {
    if (value === undefined) {
        return {};
    }
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: "act.session must be a non-empty string when provided." };
    }
    const trimmed = value.trim();
    if (trimmed.length > ACT_MAX_SESSION_CHARS) {
        return { error: `act.session must be ${ACT_MAX_SESSION_CHARS} characters or fewer.` };
    }
    if (/\s/.test(trimmed) || trimmed.includes("\u0000")) {
        return { error: "act.session must not contain whitespace or NUL bytes." };
    }
    return { value: trimmed };
}

export function normalizeActInput(input) {
    if (!isRecord(input)) {
        return { error: "act must be an object with at least a find and an action." };
    }
    for (const key of Object.keys(input)) {
        if (!ACT_ALLOWED_FIELDS.has(key)) {
            return { error: `act does not support ${key}; supported fields are ${[...ACT_ALLOWED_FIELDS].join(", ")}.` };
        }
    }
    if (!isRecord(input.find)) {
        return { error: "act.find must be an object; give it a text, a role, or both." };
    }
    for (const key of Object.keys(input.find)) {
        if (!ACT_ALLOWED_FIND_FIELDS.has(key)) {
            return { error: `act.find does not support ${key}; supported fields are ${[...ACT_ALLOWED_FIND_FIELDS].join(", ")}.` };
        }
    }
    if (typeof input.action !== "string" || !ACT_ACTIONS.has(input.action)) {
        return { error: `act.action must be one of ${[...ACT_ACTIONS].join(", ")}.` };
    }
    const find = {};
    if (input.find.text !== undefined) {
        if (typeof input.find.text !== "string" || input.find.text.trim().length === 0) {
            return { error: "act.find.text must be a non-empty string when provided." };
        }
        if (input.find.text.length > ACT_MAX_TEXT_CHARS) {
            return { error: `act.find.text must be ${ACT_MAX_TEXT_CHARS} characters or fewer.` };
        }
        find.text = input.find.text.trim();
    }
    if (input.find.role !== undefined) {
        if (typeof input.find.role !== "string" || input.find.role.trim().length === 0) {
            return { error: "act.find.role must be a non-empty string when provided." };
        }
        find.role = input.find.role.trim().toLowerCase();
    }
    if (find.text === undefined && find.role === undefined) {
        // Matching every candidate on a page is how you get an unbounded result and no answer.
        return { error: "act.find needs a text or a role. Matching every element on the page is never what you want." };
    }
    if (input.find.exact !== undefined && typeof input.find.exact !== "boolean") {
        return { error: "act.find.exact must be a boolean when provided." };
    }
    if (input.find.exact !== undefined) {
        find.exact = input.find.exact;
    }
    let maxMatches = ACT_DEFAULT_MAX_MATCHES;
    if (input.maxMatches !== undefined) {
        if (!isPositiveInteger(input.maxMatches)) {
            return { error: "act.maxMatches must be a positive integer when provided." };
        }
        if (input.maxMatches > ACT_MAX_MATCHES) {
            return { error: `act.maxMatches must be ${ACT_MAX_MATCHES} or less.` };
        }
        maxMatches = input.maxMatches;
    }
    let limit = ACT_DEFAULT_READ_LIMIT;
    if (input.limit !== undefined) {
        if (!isPositiveInteger(input.limit)) {
            return { error: "act.limit must be a positive integer when provided." };
        }
        if (input.limit > ACT_MAX_READ_LIMIT) {
            return { error: `act.limit must be ${ACT_MAX_READ_LIMIT} or less.` };
        }
        limit = input.limit;
    }
    const session = validateSession(input.session);
    if (session.error) {
        return session;
    }
    const value = { action: input.action, find, limit, maxMatches };
    if (session.value !== undefined) {
        value.session = session.value;
    }
    return { value };
}

function describeElement(element) {
    const rect = typeof element.getBoundingClientRect === "function" ? element.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    const tag = String(element.tagName || "").toLowerCase();
    const label = String(element.getAttribute?.("aria-label") || element.textContent || element.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return { label, rect: { height: Math.round(rect.height || 0), width: Math.round(rect.width || 0), x: Math.round(rect.x || 0), y: Math.round(rect.y || 0) }, tag };
}

// The generated script. It is written as string concatenation on purpose: a template literal
// here would have to be escaped twice (once for this file, once for the emitted script), and
// the previous wave already lost an afternoon to exactly that.
export function buildActScript({ action, find, limit, maxMatches }) {
    const config = JSON.stringify({ action, find, limit, maxMatches });
    return "(() => {\n"
        + "  const CFG = " + config + ";\n"
        + "  const SEL = " + JSON.stringify(ACT_CANDIDATE_SELECTOR) + ";\n"
        + "  const describe = " + describeElement.toString() + ";\n"
        + "  const norm = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();\n"
        + "  const all = Array.prototype.slice.call(document.querySelectorAll(SEL));\n"
        // Visibility first. A 0x0 element with a matching string is exactly the hidden
        // duplicate that made `find text \"Run\"` click the wrong control once already.
        + "  const visible = all.filter((el) => {\n"
        + "    const rect = el.getBoundingClientRect();\n"
        + "    return rect.width > 0 && rect.height > 0 && (el.getClientRects ? el.getClientRects().length > 0 : true);\n"
        + "  });\n"
        + "  const roleTags = " + JSON.stringify(Object.fromEntries(ROLE_TAG_EQUIVALENTS)) + ";\n"
        + "  const roleOk = (el) => {\n"
        + "    if (!CFG.find.role) return true;\n"
        + "    const explicit = String(el.getAttribute('role') || '').toLowerCase();\n"
        + "    if (explicit) return explicit === CFG.find.role;\n"
        + "    const equivalents = roleTags[CFG.find.role];\n"
        + "    const tag = String(el.tagName || '').toLowerCase();\n"
        + "    return Array.isArray(equivalents) ? equivalents.indexOf(tag) !== -1 : equivalents === tag;\n"
        + "  };\n"
        // innerText is what a human sees and what `read` returns, so it is consulted before
        // textContent: a node whose text lives only in the rendered layer would otherwise read as
        // empty and never match. aria-label still wins, because that is the accessible name.
        + "  const textOf = (el) => norm(el.getAttribute('aria-label') || el.innerText || el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '');\n"
        + "  const textOk = (el) => {\n"
        + "    if (CFG.find.text === undefined) return true;\n"
        + "    const hay = textOf(el).toLowerCase();\n"
        + "    const needle = CFG.find.text.toLowerCase();\n"
        + "    return CFG.find.exact === false ? hay.indexOf(needle) !== -1 : hay === needle;\n"
        + "  };\n"
        + "  const matched = visible.filter((el) => roleOk(el) && textOk(el));\n"
        + "  const out = { action: CFG.action, considered: all.length, visible: visible.length, matched: matched.length, candidates: matched.slice(0, " + ACT_MAX_CANDIDATES_REPORTED + ").map(describe) };\n"
        // Ambiguity is refused, never guessed. This is the whole reason the mode exists.
        + "  if (matched.length > CFG.maxMatches) {\n"
        + "    out.status = 'ambiguous';\n"
        + "    return out;\n"
        + "  }\n"
        + "  if (matched.length === 0) { out.status = 'not-found'; return out; }\n"
        + "  const target = matched[0];\n"
        + "  out.target = describe(target);\n"
        + "  out.status = 'matched';\n"
        + "  if (CFG.action === 'read') {\n"
        + "    const text = norm(target.innerText != null ? target.innerText : target.textContent);\n"
        + "    out.text = text.length > CFG.limit ? text.slice(0, CFG.limit) : text;\n"
        + "    out.truncated = text.length > CFG.limit;\n"
        + "    out.totalChars = text.length;\n"
        + "    return out;\n"
        + "  }\n"
        + "  if (typeof target.scrollIntoView === 'function') { try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* a page that refuses to scroll is not a reason to fail the click */ } }\n"
        + "  target.click();\n"
        + "  out.clicked = true;\n"
        + "  return out;\n"
        + "})()";
}

export function compileAgentBrowserAct(input) {
    const plan = isRecord(input) ? input : {};
    const script = buildActScript({
        action: plan.action,
        find: plan.find ?? {},
        limit: plan.limit ?? ACT_DEFAULT_READ_LIMIT,
        maxMatches: plan.maxMatches ?? ACT_DEFAULT_MAX_MATCHES,
    });
    // The session has to reach argv, not just the compiled object. Without this the eval ran in
    // pi-root, and the wrapper's own tab-drift detector caught the mismatch on the first live
    // call - which is the correct behaviour, but it means this was never actually routed.
    const compiled = { kind: "act", args: withOptionalSessionArgs(plan.session, ["eval", "--stdin"]), stdin: script };
    if (plan.session !== undefined) {
        compiled.session = plan.session;
    }
    return compiled;
}
