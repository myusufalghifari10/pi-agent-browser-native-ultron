// local patch: origin-bound in-page credential fill (PATCHES.md P11).
//
// Why this exists: a credential must never travel through argv (`ps` would show it) and must never be
// typed into the wrong site. The wrapper therefore:
//   1. builds one page-side script that embeds the secret and is delivered over `eval --stdin`
//      (stdin is not in the process table and the wrapper never echoes stdin into `details`),
//   2. re-checks `location.origin` INSIDE the page immediately before the write, against the exact
//      origin the vault entry was saved for, and
//   3. returns only counts and roles - never the values, not even on failure.
//
// The script uses the native value setter plus real input/change events, because assigning `.value`
// directly is invisible to React/Vue-style controlled inputs.
export const VAULT_FILL_ROLES = ["username", "password", "otp", "card_name", "card_number", "card_exp", "card_cvc", "address_line1", "address_line2", "address_city", "address_state", "address_postal", "address_country"];

const ROLE_SELECTORS = {
    address_city: ["input[autocomplete=\"address-level2\"]", "input[name*=\"city\" i]", "input[id*=\"city\" i]"],
    address_country: ["select[autocomplete=\"country\"]", "input[autocomplete=\"country\"]", "input[name*=\"country\" i]", "select[name*=\"country\" i]"],
    address_line1: ["input[autocomplete=\"address-line1\"]", "input[name*=\"address\" i]", "input[id*=\"address\" i]"],
    address_line2: ["input[autocomplete=\"address-line2\"]", "input[name*=\"address2\" i]", "input[id*=\"address2\" i]"],
    address_postal: ["input[autocomplete=\"postal-code\"]", "input[name*=\"zip\" i]", "input[name*=\"postal\" i]", "input[id*=\"postal\" i]"],
    address_state: ["select[autocomplete=\"address-level1\"]", "input[autocomplete=\"address-level1\"]", "input[name*=\"state\" i]", "select[name*=\"state\" i]"],
    card_cvc: ["input[autocomplete=\"cc-csc\"]", "input[name*=\"cvc\" i]", "input[name*=\"cvv\" i]", "input[name*=\"security-code\" i]"],
    card_exp: ["input[autocomplete=\"cc-exp\"]", "input[name*=\"exp\" i]", "input[id*=\"exp\" i]"],
    card_name: ["input[autocomplete=\"cc-name\"]", "input[name*=\"cardholder\" i]", "input[name*=\"name-on-card\" i]"],
    card_number: ["input[autocomplete=\"cc-number\"]", "input[name*=\"card-number\" i]", "input[name*=\"cardnumber\" i]", "input[name*=\"card_number\" i]"],
    otp: ["input[autocomplete=\"one-time-code\"]", "input[name*=\"otp\" i]", "input[name*=\"code\" i]", "input[id*=\"otp\" i]", "input[inputmode=\"numeric\"][maxlength=\"6\"]", "input[inputmode=\"numeric\"]"],
    password: ["input[type=\"password\"]"],
    username: ["input[autocomplete=\"username\"]", "input[type=\"email\"]", "input[name*=\"user\" i]", "input[name*=\"email\" i]", "input[id*=\"user\" i]", "input[id*=\"email\" i]", "input[type=\"text\"]"],
};

export function getVaultFillRoleSelectors(role) {
    return ROLE_SELECTORS[role] ?? [];
}

export function isVaultFillRole(role) {
    return VAULT_FILL_ROLES.includes(role);
}

/**
 * Build the page-side script. `fields` is `[{ role, value, selector? }]`; values are embedded here on
 * purpose (this string only ever travels over stdin).
 */
export function buildVaultFillScript({ origin, fields, submit = false }) {
    const payload = JSON.stringify({
        fields: fields.map((field) => ({ role: field.role, selector: field.selector, value: field.value })),
        origin,
        selectors: ROLE_SELECTORS,
        submit: submit === true,
    });
    // The IIFE body is deliberately written as one self-contained expression so it survives being
    // evaluated as an expression by Playwright-style evaluators.
    return `(async () => {
  const CFG = ${payload};
  const result = { ok: false, reason: undefined, origin: undefined, fields: [], submitAttempted: false };
  try {
    const pageOrigin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
    result.origin = pageOrigin;
    const expected = CFG.origin === "about:blank" ? "null" : CFG.origin;
    const observed = pageOrigin === "null" || pageOrigin === "" ? "null" : pageOrigin;
    if (observed !== expected) {
      result.reason = "origin-mismatch";
      result.expectedOrigin = expected;
      return result;
    }
    const visible = (element) => {
      if (!element || element.disabled || element.readOnly) return false;
      if (element.type === "hidden") return false;
      const rects = element.getClientRects ? element.getClientRects() : [];
      if (rects && rects.length > 0) return true;
      return element.offsetParent !== null;
    };
    const setValue = (element, value) => {
      const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      const previous = element.value;
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
      try { element.focus({ preventScroll: true }); } catch (error) { /* focus is best effort */ }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" }));
      element.dispatchEvent(new Event("blur", { bubbles: false }));
      return { previous, value: element.value };
    };
    const resolve = (field) => {
      const candidates = [];
      if (field.selector) {
        let matched = [];
        try { matched = Array.from(document.querySelectorAll(field.selector)); } catch (error) { matched = []; }
        if (matched.length === 0) return { reason: "selector-not-found" };
        if (matched.length > 1) return { reason: "selector-not-unique", candidateCount: matched.length };
        candidates.push(matched[0]);
      }
      else {
        for (const selector of (CFG.selectors[field.role] || [])) {
          let matched = [];
          try { matched = Array.from(document.querySelectorAll(selector)); } catch (error) { matched = []; }
          for (const element of matched) {
            if (visible(element)) candidates.push(element);
          }
          if (candidates.length > 0) break;
        }
      }
      if (candidates.length === 0) return { reason: "field-not-found" };
      const visibleCandidates = candidates.filter(visible);
      if (field.selector && visibleCandidates.length === 0) return { reason: "field-not-visible" };
      return { element: visibleCandidates[0] ?? candidates[0], candidateCount: candidates.length };
    };
    for (const field of CFG.fields) {
      const resolved = resolve(field);
      if (resolved.reason) {
        result.reason = resolved.reason;
        result.failedRole = field.role;
        result.candidateCount = resolved.candidateCount;
        return result;
      }
      const written = setValue(resolved.element, field.value);
      if (written.value !== field.value) {
        result.reason = "value-rejected";
        result.failedRole = field.role;
        result.observedLength = typeof written.value === "string" ? written.value.length : 0;
        return result;
      }
      result.fields.push({
        candidateCount: resolved.candidateCount,
        hadPreviousValue: typeof written.previous === "string" && written.previous.length > 0,
        role: field.role,
        tag: resolved.element.tagName ? resolved.element.tagName.toLowerCase() : "node",
      });
    }
    if (CFG.submit) {
      result.submitAttempted = true;
      const form = result.fields.length > 0 ? undefined : undefined;
      const candidate = document.querySelector("button[type=submit]:not([disabled]), input[type=submit]:not([disabled]), form button:not([type=button]):not([disabled])");
      if (!candidate) {
        result.reason = "submit-control-not-found";
        return result;
      }
      candidate.click();
      void form;
    }
    result.ok = true;
    return result;
  }
  catch (error) {
    result.reason = "script-error";
    result.message = error && error.message ? String(error.message).slice(0, 200) : "unknown page error";
    return result;
  }
})()`;
}

/**
 * Normalize the raw eval payload. The returned object never contains a secret and is safe to place in
 * `details`.
 */
export function parseVaultFillResult(data) {
    const payload = data && typeof data === "object" ? data : {};
    const nested = payload.result && typeof payload.result === "object" ? payload.result : payload;
    const fields = Array.isArray(nested.fields)
        ? nested.fields.map((field) => ({
            candidateCount: typeof field.candidateCount === "number" ? field.candidateCount : undefined,
            hadPreviousValue: field.hadPreviousValue === true,
            role: typeof field.role === "string" ? field.role : "unknown",
            tag: typeof field.tag === "string" ? field.tag : undefined,
        }))
        : [];
    return {
        candidateCount: typeof nested.candidateCount === "number" ? nested.candidateCount : undefined,
        expectedOrigin: typeof nested.expectedOrigin === "string" ? nested.expectedOrigin : undefined,
        failedRole: typeof nested.failedRole === "string" ? nested.failedRole : undefined,
        fields,
        filledCount: fields.length,
        message: typeof nested.message === "string" ? nested.message : undefined,
        ok: nested.ok === true,
        origin: typeof nested.origin === "string" ? nested.origin : undefined,
        reason: typeof nested.reason === "string" ? nested.reason : undefined,
        submitAttempted: nested.submitAttempted === true,
    };
}

export function describeVaultFillFailure(parsed) {
    const reason = parsed?.reason;
    if (reason === "origin-mismatch") {
        return `Refused to fill: the page origin does not match the vault entry origin. Page: ${parsed.origin ?? "unknown"}; entry: ${parsed.expectedOrigin ?? "unknown"}. Nothing was written.`;
    }
    if (reason === "field-not-found") {
        return `Refused to fill: no matching "${parsed.failedRole ?? "target"}" field is present and visible on this page. Pass an explicit selector, or take a snapshot first.`;
    }
    if (reason === "field-not-visible") {
        return `Refused to fill: the selector matched a "${parsed.failedRole ?? "target"}" element that is not visible. Reveal it (click/scroll) or pass a different selector.`;
    }
    if (reason === "selector-not-found") {
        return `Refused to fill: the given selector matched nothing. Take a fresh snapshot and retry with a current ref or selector.`;
    }
    if (reason === "selector-not-unique") {
        return `Refused to fill: the given selector matched ${parsed.candidateCount ?? "several"} elements, so the target is ambiguous. Narrow the selector.`;
    }
    if (reason === "value-rejected") {
        return `Refused to fill: the page rejected the typed value for "${parsed.failedRole ?? "target"}" (the field rewrote it). Use browser_keyboard-style typing or a different selector.`;
    }
    if (reason === "submit-control-not-found") {
        return `Filled the fields but found no enabled submit control. Submit explicitly (click/press Enter) when the form should go through.`;
    }
    if (reason === "script-error") {
        return `The in-page fill script failed: ${parsed.message ?? "unknown error"}. Nothing was submitted.`;
    }
    return undefined;
}
