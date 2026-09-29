// local patch: raw CDP escape hatch host orchestration (PATCHES.md P-W14-cdp-host).
//
// Why this exists: the wrapper is a pass-through, so every action it can do is one upstream
// `agent-browser` command. It can reject, validate or format - never add capability. The only channel
// that bypasses that command surface is the Chrome DevTools Protocol itself, and the CLI already
// exposes the browser's debugger endpoint through `get cdp-url`. So this host resolves that endpoint
// through the ordinary spawn pipeline (redaction, ledger and session handling still apply), opens ONE
// WebSocket, and replays the caller's commands over it in order.
//
// Deliberate limits, because "raw" is not "unaccountable":
//   - the endpoint is never re-typed by the model: it is read from the live browser, so a dead or
//     moved browser is an error, not a hang
//   - one connection, sequential commands, incremental ids, results returned in request order
//   - a per-command failure is reported *next to* the commands that succeeded, never instead of them:
//     a half-successful call still has to show the model what did work
//   - heavy payloads go to `artifactPath` and only the path comes back
//   - the debugger URL itself never reaches `content`; only origin+path reach `details`
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { isRecord } from "../../parsing.js";
// local patch: single source of truth for the default budget. Lane B originally redeclared
// the literal 30000 locally so the lane could be built without importing Lane A; now that both
// files live in the same tree, a duplicated constant is a silent drift risk.
import { CDP_DEFAULT_TIMEOUT_MS } from "../../input-modes/cdp.js";

export const CDP_MARKER = "__piAgentBrowserCdp";
export const CDP_DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const CDP_RESULT_PREVIEW_CHARS = 2000;
const CDP_ENDPOINT_PLACEHOLDER = "[cdp-endpoint-redacted]";
// A deadline expiry resolves as this sentinel, not as a reply: comparing against `undefined` would
// let the sentinel fall through and be reported as a successful command with no result.
const CDP_DEADLINE_EXPIRED = Symbol("cdp-deadline-expired");

function summarizeCdpError(error) {
    if (typeof error === "string") {
        return error;
    }
    if (isRecord(error)) {
        const message = typeof error.message === "string" ? error.message : undefined;
        const code = error.code === undefined ? undefined : ` (code ${Number.isFinite(error.code) ? error.code : "unknown"})`;
        return `${message ?? "CDP command failed."}${code ?? ""}`;
    }
    return error === undefined ? "CDP command failed." : String(error);
}

function describeCdpResult(value) {
    if (value === undefined) {
        return "no result";
    }
    let text;
    try {
        text = typeof value === "string" ? value : JSON.stringify(value);
    }
    catch {
        return "result was not serializable";
    }
    if (text === undefined) {
        return "no result";
    }
    return text.length > CDP_RESULT_PREVIEW_CHARS ? `${text.slice(0, CDP_RESULT_PREVIEW_CHARS)}… (${text.length} chars total)` : text;
}

// The debugger URL carries the browser's private connection token, and command results routinely
// echo it back (Target.getTargets). Scrubbing is cheaper than trusting every future CDP method.
function scrubCdpEndpoints(text, cdpUrl) {
    return text
        .split(cdpUrl).join(CDP_ENDPOINT_PLACEHOLDER)
        .replace(/wss?:\/\/[^\s"'\\]+/gi, CDP_ENDPOINT_PLACEHOLDER);
}

function buildCdpResult({ cdp = {}, isError = false, failureCategory, lines = [] }) {
    const resultCategory = isError ? "failure" : "success";
    const text = lines.filter(Boolean).join("\n") || `cdp: ${cdp.commandCount ?? 0} command(s).`;
    return {
        content: [{ text, type: "text" }],
        details: {
            categoryDetails: isError ? { failureCategory, resultCategory } : { resultCategory, successCategory: "completed" },
            cdp: { endpoint: undefined, results: [], ...cdp },
        },
        ...(isError && failureCategory ? { failureCategory } : {}),
        isError,
        resultCategory,
    };
}

// `get cdp-url` is read through the normal spawn pipeline, so the model cannot invent an endpoint and
// redaction/ledgering still cover the call. Without a session the argv is just the getter: passing a
// literal `--session undefined` would spawn against a session that does not exist.
function cdpUrlArgs(session) {
    return typeof session === "string" && session.length > 0 ? ["--session", session, "get", "cdp-url"] : ["get", "cdp-url"];
}

function readCdpUrl(result) {
    const data = result?.details?.data;
    if (typeof data?.cdpUrl === "string" && data.cdpUrl.length > 0) {
        return data.cdpUrl;
    }
    if (isRecord(data) && typeof data.result === "string" && /^wss?:\/\//.test(data.result)) {
        return data.result;
    }
    return undefined;
}

function remainingMs(deadline) {
    return Math.max(0, deadline - Date.now());
}

function withDeadline(promise, budgetMs) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(CDP_DEADLINE_EXPIRED), Math.max(1, budgetMs));
        }),
    ]).finally(() => clearTimeout(timer));
}

/**
 * One connection, sequential commands, incremental ids. Every browser interaction happens through
 * the injected `webSocketImpl` constructor, so the offline test drives this whole path with a stub
 * and never opens a real socket.
 */
async function runCdpSession({ artifactPath, cdpUrl, commands, deadline, timeoutMs, webSocketImpl }) {
    const socket = new webSocketImpl(cdpUrl);
    const pending = new Map();
    let nextId = 0;
    let settleOpen;
    const opened = new Promise((resolve) => {
        settleOpen = resolve;
    });

    const deliver = (event) => {
        let text;
        try {
            text = typeof event?.data === "string" ? event.data : new TextDecoder().decode(event?.data);
        }
        catch {
            return;
        }
        let message;
        try {
            message = JSON.parse(text);
        }
        catch {
            return;
        }
        const waiter = pending.get(message?.id);
        if (!waiter) {
            return;
        }
        pending.delete(message.id);
        waiter(message);
    };
    // A refused connection or an early close must settle the open wait too, or it would only ever
    // surface as a timeout and hide the real reason.
    const failAll = (error) => {
        settleOpen({ error });
        for (const waiter of pending.values()) {
            waiter({ error: { message: summarizeCdpError(error) } });
        }
        pending.clear();
    };
    socket.addEventListener("open", (event) => settleOpen(event));
    socket.addEventListener("message", deliver);
    socket.addEventListener("error", (event) => failAll(event?.error ?? event?.message ?? "the CDP socket reported an error"));
    socket.addEventListener("close", () => failAll("the CDP socket closed before the command answered"));

    const results = [];
    const rows = [];
    let failure;
    try {
        const connectBudget = Math.min(CDP_DEFAULT_CONNECT_TIMEOUT_MS, remainingMs(deadline));
        const openResult = await withDeadline(opened, connectBudget);
        if (openResult === CDP_DEADLINE_EXPIRED) {
            throw { category: "timeout", message: `The CDP socket did not open within ${connectBudget} ms.` };
        }
        if (openResult?.error) {
            throw { category: "upstream-error", message: `Could not connect to the browser CDP endpoint: ${summarizeCdpError(openResult.error)}. The browser may have closed; retry or relaunch the session.` };
        }
        for (const [index, command] of commands.entries()) {
            const budget = remainingMs(deadline);
            if (budget <= 0) {
                throw { category: "timeout", message: `The cdp budget of ${timeoutMs} ms expired before command ${index} (${command.method}) was sent.` };
            }
            const id = ++nextId;
            const answer = new Promise((resolve) => pending.set(id, resolve));
            socket.send(JSON.stringify({ id, method: command.method, ...(command.params === undefined ? {} : { params: command.params }) }));
            const reply = await withDeadline(answer, budget);
            if (reply === CDP_DEADLINE_EXPIRED) {
                throw { category: "timeout", message: `Command ${index} (${command.method}) did not answer within the remaining cdp budget of ${timeoutMs} ms.` };
            }
            if (reply.error) {
                const reason = summarizeCdpError(reply.error);
                results.push({ error: reason, index, method: command.method, ok: false });
                rows.push(`- [failed] ${index} ${command.method}: ${reason}`);
                continue;
            }
            if (typeof command.artifact === "string" && command.artifact.length > 0) {
                const target = join(artifactPath, command.artifact);
                await mkdir(artifactPath, { recursive: true });
                await writeFile(target, typeof reply.result === "string" ? reply.result : JSON.stringify(reply.result ?? null), "utf8");
                results.push({ artifactPath: target, index, method: command.method, ok: true });
                rows.push(`- [ok] ${index} ${command.method}: wrote ${target}`);
                continue;
            }
            results.push({ index, method: command.method, ok: true });
            rows.push(`- [ok] ${index} ${command.method}: ${describeCdpResult(reply.result)}`);
        }
    }
    catch (thrown) {
        failure = thrown;
    }
    finally {
        for (const waiter of pending.values()) {
            waiter({ error: { message: "the cdp session was closed" } });
        }
        pending.clear();
        try {
            socket.close();
        }
        catch {
            // A socket that is already gone needs no closing; the run is over either way.
        }
    }
    return { failure, results, rows };
}

export async function handleCdpHostInput({ compiled, dispatch, signal, webSocketImpl = globalThis.WebSocket } = {}) {
    const startedAt = Date.now();
    const commands = Array.isArray(compiled?.commands) ? compiled.commands.filter((command) => isRecord(command)) : [];
    const timeoutMs = Number.isFinite(compiled?.timeoutMs) && compiled.timeoutMs > 0 ? compiled.timeoutMs : CDP_DEFAULT_TIMEOUT_MS;
    const artifactPath = compiled?.artifactPath;

    if (commands.length === 0) {
        return buildCdpResult({ cdp: { elapsedMs: Date.now() - startedAt, reason: "no-commands" }, isError: true, failureCategory: "validation-error", lines: ["cdp needs at least one command. Pass cdp: { commands: [{ method: \"Domain.command\" }] }."] });
    }
    // Checked before any socket: an artifact with nowhere to land is a request the model must fix.
    const orphanArtifact = commands.find((command) => typeof command.artifact === "string" && command.artifact.length > 0 && (typeof artifactPath !== "string" || artifactPath.length === 0));
    if (orphanArtifact) {
        return buildCdpResult({
            cdp: { elapsedMs: Date.now() - startedAt, reason: "artifact-without-path" },
            isError: true,
            failureCategory: "validation-error",
            lines: [`Command "${orphanArtifact.method}" asks for the artifact "${orphanArtifact.artifact}", but no artifactPath was given. Add cdp: { artifactPath: \"<directory>\" } or drop the artifact field.`],
        });
    }
    if (signal?.aborted) {
        return buildCdpResult({ cdp: { elapsedMs: Date.now() - startedAt, reason: "aborted" }, isError: true, failureCategory: "timeout", lines: ["The call was cancelled before the browser CDP endpoint was contacted."] });
    }
    if (typeof webSocketImpl !== "function") {
        return buildCdpResult({
            cdp: { elapsedMs: Date.now() - startedAt, reason: "no-websocket" },
            isError: true,
            failureCategory: "upstream-error",
            lines: ["This Node runtime has no global WebSocket, so the cdp escape hatch cannot run. Use Node 22.19 or newer (see the extension's engines requirement)."],
        });
    }
    if (typeof dispatch !== "function") {
        return buildCdpResult({ cdp: { elapsedMs: Date.now() - startedAt, reason: "no-dispatch" }, isError: true, failureCategory: "validation-error", lines: ["The cdp host was called without a dispatch function, so it cannot reach the browser."] });
    }

    const args = cdpUrlArgs(compiled?.session);
    const resolved = await dispatch({ args, timeoutMs });
    const cdpUrl = readCdpUrl(resolved);
    if (!cdpUrl) {
        const upstreamReason = resolved?.isError === true || resolved?.resultCategory === "failure" ? ` The upstream read reported: ${summarizeCdpError(resolved?.details?.error ?? "failure")}` : "";
        return buildCdpResult({
            cdp: { elapsedMs: Date.now() - startedAt, marker: CDP_MARKER, reason: "no-cdp-url", request: args },
            isError: true,
            failureCategory: "upstream-error",
            lines: [`No cdpUrl came back from get cdp-url (ran \`${args.join(" ")}\`), so there is no endpoint to talk to. Start or attach a browser session first, then retry.${upstreamReason}`],
        });
    }

    const deadline = startedAt + timeoutMs;
    const run = await runCdpSession({
        artifactPath: typeof artifactPath === "string" ? resolveArtifactDir(artifactPath) : undefined,
        cdpUrl,
        commands,
        deadline,
        timeoutMs,
        webSocketImpl,
    });
    const elapsedMs = Date.now() - startedAt;
    const endpoint = describeEndpoint(cdpUrl);
    const cdp = { commandCount: commands.length, elapsedMs, endpoint, marker: CDP_MARKER, results: run.results };
    const summary = `cdp: ${commands.length} command(s) on ${CDP_MARKER} in ${elapsedMs} ms.`;

    if (run.failure) {
        cdp.reason = run.failure.category === "timeout" ? "timeout" : "session-failed";
        return buildCdpResult({
            cdp,
            isError: true,
            failureCategory: run.failure.category ?? "upstream-error",
            lines: [scrubCdpEndpoints([summary, ...run.rows, run.failure.message ?? "The cdp session failed."].join("\n"), cdpUrl)],
        });
    }
    const failed = run.results.some((result) => !result.ok);
    return buildCdpResult({
        cdp,
        isError: failed,
        failureCategory: failed ? "upstream-error" : undefined,
        lines: [scrubCdpEndpoints([summary, ...run.rows, failed ? "At least one command failed; the successful results above are real and still valid." : undefined].join("\n"), cdpUrl)],
    });
}

function resolveArtifactDir(artifactPath) {
    return isAbsolute(artifactPath) ? artifactPath : resolvePath(artifactPath);
}

function describeEndpoint(cdpUrl) {
    try {
        const url = new URL(cdpUrl);
        return { origin: url.origin, path: url.pathname };
    }
    catch {
        return { origin: undefined, path: undefined };
    }
}
