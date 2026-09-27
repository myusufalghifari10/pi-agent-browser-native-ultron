// local patch: masked secret intake for the credential vault (PATCHES.md P11).
//
// Why this exists: Pi's `ctx.ui.input()` has no mask option, so a password typed through it would be
// rendered on screen and end up in the terminal scrollback. This module provides a masked prompt built
// on `ctx.ui.custom`, plus the honest refusal path for sessions without a UI (print/JSON mode, cron,
// subagents without a TTY): a vault that cannot ask must say so instead of guessing.
//
// Non-negotiables mirrored from the design we ported:
//   - the secret is returned to the caller only, never rendered, never logged, never put in a notice
//   - the prompt requires an explicit confirmation when saving a new entry
//   - cancelling returns a distinct status so callers can tell "user said no" from "no UI"
export const VAULT_PROMPT_UNAVAILABLE = "prompt_unavailable";
export const VAULT_PROMPT_CANCELLED = "cancelled";
export const VAULT_PROMPT_TIMEOUT_MS = 300_000;

const ENTER_KEYS = ["\r", "\n"];
const ESCAPE_KEY = "\u001b";
const BACKSPACE_KEYS = ["\u007f", "\b"];
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

class MaskedInputComponent {
    constructor({ message, hint, title, confirm }) {
        this.value = "";
        this.cursorVisible = true;
        this.focused = false;
        this.confirm = confirm;
        this.confirmationStep = false;
        this.hint = hint;
        this.message = message;
        this.title = title;
        this.disposed = false;
        this.timedOut = false;
        // `ctx.ui.custom` accepts no timeout option, so the component owns its own deadline. A prompt
        // that nobody answers must not hang the session (a subagent or an unattended terminal has no
        // human at the keyboard).
        this.timer = setTimeout(() => {
            this.timedOut = true;
            this.finish(undefined);
        }, VAULT_PROMPT_TIMEOUT_MS);
        this.timer.unref?.();
    }

    dispose() {
        clearTimeout(this.timer);
        this.disposed = true;
    }

    render(width) {
        const lines = [];
        const clamp = (text) => (text.length > width ? text.slice(0, Math.max(0, width - 1)) : text);
        lines.push(clamp(this.title));
        for (const line of String(this.message).split("\n")) {
            lines.push(clamp(`  ${line}`));
        }
        const masked = this.value.length === 0 ? "" : "•".repeat(Math.min(this.value.length, Math.max(0, width - 6)));
        lines.push(clamp(`  > ${masked}${this.cursorVisible ? "▏" : ""}`));
        if (this.hint) {
            lines.push(clamp(`  ${this.hint}`));
        }
        lines.push(clamp(this.confirmationStep ? "  Press Enter again to confirm, or Esc to cancel." : "  Enter to submit, Esc to cancel. Input is not shown."));
        return lines;
    }

    handleInput(data) {
        if (typeof data !== "string" || data.length === 0) {
            return;
        }
        if (data === ESCAPE_KEY) {
            this.finish(undefined);
            return;
        }
        if (ENTER_KEYS.includes(data)) {
            if (this.confirm && !this.confirmationStep) {
                this.confirmationStep = true;
                return;
            }
            this.finish(this.value);
            return;
        }
        if (BACKSPACE_KEYS.includes(data)) {
            this.value = this.value.slice(0, -1);
            return;
        }
        // Ignore other escape sequences (arrows, function keys) so navigation keys cannot cancel or
        // corrupt the entry; accept a pasted multi-character chunk as literal text.
        if (data.startsWith(ESCAPE_KEY)) {
            return;
        }
        const cleaned = data.replace(/[\r\n]/g, "");
        if (CONTROL_PATTERN.test(cleaned)) {
            return;
        }
        if (this.value.length + cleaned.length > 8192) {
            return;
        }
        this.value += cleaned;
    }

    finish(value) {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        clearTimeout(this.timer);
        this.onDone?.(value);
    }
}

// A subagent child has no human at the keyboard, so a blocking prompt there would hang the run.
// Saved credentials still work in that situation; only saving, unlocking, and a user-supplied 2FA code
// are refused, with the same honest status the main session uses for a headless run.
function isSubagentChild(env = process.env) {
    return env?.PI_SUBAGENT_CHILD === "1";
}

function describeUiAvailability(ctx) {
    if (isSubagentChild()) {
        return false;
    }
    if (!ctx || typeof ctx !== "object") {
        return false;
    }
    if (ctx.hasUI === false) {
        return false;
    }
    return typeof ctx.ui?.custom === "function";
}

function describePromptUnavailable() {
    if (isSubagentChild()) {
        return "This call runs in a subagent, which has no interactive user to answer a masked prompt. Saved credentials still work here; to save a new login, run it from the main Pi session, or pass the value explicitly from a trusted host source. Never ask for the password in chat.";
    }
    return "No interactive UI is available in this session, so a secret cannot be collected. Run this from an interactive Pi session (or set the value once from one), then retry.";
}

/**
 * Ask the user for a secret. Returns { status: "ok", value } | { status: "cancelled" } |
 * { status: "prompt_unavailable", error }.
 */
export async function promptVaultSecret(ctx, { title, message, hint, confirm = false, expectedLength } = {}) {
    if (!describeUiAvailability(ctx)) {
        return {
            error: describePromptUnavailable(),
            status: VAULT_PROMPT_UNAVAILABLE,
        };
    }
    try {
        const answer = await ctx.ui.custom((tui, theme, keybindings, done) => {
            const component = new MaskedInputComponent({
                confirm,
                hint,
                message: message ?? "Enter the secret. It is stored encrypted and never shown to the model.",
                title: title ?? "Secret required",
            });
            component.onDone = (value) => done(value);
            return component;
        });
        if (typeof answer !== "string" || answer.length === 0) {
            return { status: VAULT_PROMPT_CANCELLED };
        }
        if (Number.isInteger(expectedLength) && expectedLength > 0 && answer.length !== expectedLength) {
            return {
                error: `The entry must be exactly ${expectedLength} characters; ${answer.length} were provided.`,
                status: "invalid",
            };
        }
        return { status: "ok", value: answer };
    }
    catch (error) {
        return {
            error: `The masked prompt failed: ${error instanceof Error ? error.message : String(error)}.`,
            status: VAULT_PROMPT_UNAVAILABLE,
        };
    }
}

/** Non-secret text prompt (identifiers, labels, URLs). Uses the plain Pi input dialog. */
export async function promptVaultText(ctx, { title, placeholder } = {}) {
    if (!describeUiAvailability(ctx) || typeof ctx.ui.input !== "function") {
        return { error: describePromptUnavailable(), status: VAULT_PROMPT_UNAVAILABLE };
    }
    try {
        const answer = await ctx.ui.input(title ?? "Value", placeholder);
        if (typeof answer !== "string" || answer.length === 0) {
            return { status: VAULT_PROMPT_CANCELLED };
        }
        return { status: "ok", value: answer };
    }
    catch (error) {
        return { error: `The prompt failed: ${error instanceof Error ? error.message : String(error)}`, status: VAULT_PROMPT_UNAVAILABLE };
    }
}

/**
 * Explicit confirmation for a high-risk action (saving a credential, filling a payment card).
 * Fail-closed: without a UI the answer is "not confirmed", never "assume yes".
 */
export async function confirmVaultAction(ctx, { title, message } = {}) {
    if (!describeUiAvailability(ctx) || typeof ctx.ui.confirm !== "function") {
        return { confirmed: false, status: VAULT_PROMPT_UNAVAILABLE };
    }
    try {
        const confirmed = await ctx.ui.confirm(title ?? "Confirm", message ?? "Confirm this action");
        return { confirmed: confirmed === true, status: confirmed === true ? "confirmed" : "declined" };
    }
    catch {
        return { confirmed: false, status: "declined" };
    }
}

export function describeVaultIntakeStatus(status) {
    if (status === VAULT_PROMPT_CANCELLED) {
        return "cancelled by the user";
    }
    if (status === VAULT_PROMPT_UNAVAILABLE) {
        return "unavailable in this session";
    }
    return status;
}
