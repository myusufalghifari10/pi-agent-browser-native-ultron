// local patch: devServer mode runtime (PATCHES.md P20).
//
// Why this exists: local frontend QA always starts with "is my dev server up, and on which port?".
// Doing that by hand costs the agent a bash round trip (shell guesses, background processes it then
// forgets to stop). This handler owns that lifecycle: detection comes from package.json, readiness is
// probed over HTTP, and a started process is tracked so Pi shutdown can stop it again.
//
// Deliberate limits: the wrapper only ever owns processes it started here, it never kills a process it
// did not start (a port that is already answering is reported, not adopted), and it never claims a
// clean stop it did not observe.
import { spawn } from "node:child_process";
import { openSync, writeSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDevServer, normalizeDevServerInput } from "../../input-modes/dev-server.js";

export const DEV_SERVER_STATUSES = ["stopped", "starting", "ready", "exited", "failed"];
const READY_POLL_INTERVAL_MS = 250;
const STOP_GRACE_MS = 5000;
const LOG_TAIL_MAX_CHARS = 4096;

let registry = { records: new Map() };

export function getDevServerRegistry() {
    return registry;
}

function redactCommand(command) {
    if (typeof command !== "string") {
        return command;
    }
    return command.replace(/([A-Za-z_][A-Za-z0-9_]*?(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)[A-Za-z0-9_]*)=(\S+)/gi, "$1=[REDACTED]");
}

export function listDevServerRecords() {
    return [...registry.records.values()].map((record) => ({
        command: redactCommand(record.command),
        cwd: record.cwd,
        framework: record.framework,
        id: record.id,
        lastExitCode: record.lastExitCode,
        logPath: record.logPath,
        pid: record.pid,
        port: record.port,
        readyAtMs: record.readyAtMs,
        reason: record.reason,
        startedAtMs: record.startedAtMs,
        status: record.status,
        url: record.url,
    }));
}

function buildRecordId(cwd, port) {
    return `devserver-${Buffer.from(`${cwd}:${port ?? "unknown"}`).toString("hex").slice(0, 16)}`;
}

export function probeDevServerUrl(url, { timeoutMs = 2000 } = {}) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        }
        catch {
            resolve({ elapsedMs: 0, error: "invalid-url", ok: false });
            return;
        }
        const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
        const request = requestFn(parsed, { headers: { connection: "close" }, method: "GET", timeout: timeoutMs }, (response) => {
            // Any HTTP answer proves a server is listening; a dev server that 404s is still up.
            response.resume();
            resolve({ elapsedMs: Date.now() - startedAt, httpStatus: response.statusCode, ok: true });
        });
        request.on("timeout", () => {
            request.destroy();
            resolve({ elapsedMs: Date.now() - startedAt, error: "timeout", ok: false });
        });
        request.on("error", (error) => {
            resolve({ elapsedMs: Date.now() - startedAt, error: error?.code ?? "request-failed", ok: false });
        });
        request.end();
    });
}

function tailText(text) {
    if (typeof text !== "string") {
        return "";
    }
    return text.length > LOG_TAIL_MAX_CHARS ? text.slice(text.length - LOG_TAIL_MAX_CHARS) : text;
}

async function waitForReady({ child, port, timeoutMs, url }) {
    const deadline = Date.now() + timeoutMs;
    const probeUrl = url ?? `http://127.0.0.1:${port}/`;
    while (Date.now() < deadline) {
        if (child && child.exitCode !== null) {
            return { reason: "process-exited", status: "exited" };
        }
        const probe = await probeDevServerUrl(probeUrl, { timeoutMs: Math.min(1500, Math.max(250, deadline - Date.now())) });
        if (probe.ok) {
            return { httpStatus: probe.httpStatus, status: "ready" };
        }
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
    return { reason: "timeout", status: "failed" };
}

function startProcess({ command, cwd, port, timeoutMs, url }) {
    const logDir = mkdtempSync(join(tmpdir(), "piab-devserver-"));
    const logPath = join(logDir, "dev-server.log");
    const logFd = openSync(logPath, "a", 0o600);
    writeSync(logFd, `$ ${command}\n# started ${new Date().toISOString()} in ${cwd}\n`);
    const child = spawn(command, { cwd, detached: true, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const capture = (chunk, stream) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        tail = tailText(`${tail}${text}`);
        try {
            writeSync(logFd, text);
        }
        catch { /* log writes are best effort */ }
        if (stream === "stderr") {
            record.stderrTail = tailText(`${record.stderrTail ?? ""}${text}`);
        }
    };
    const record = {
        child,
        command,
        cwd,
        id: buildRecordId(cwd, port),
        logFd,
        logPath,
        pid: child.pid,
        port,
        stderrTail: "",
        startedAtMs: Date.now(),
        status: "starting",
        tail: () => tail,
        url: url ?? (port ? `http://127.0.0.1:${port}/` : undefined),
    };
    child.stdout?.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => capture(chunk, "stderr"));
    child.on("exit", (code, signal) => {
        record.lastExitCode = code ?? undefined;
        record.lastSignal = signal ?? undefined;
        if (record.status !== "stopped") {
            record.status = "exited";
            record.reason = `process exited (code ${code ?? "null"}, signal ${signal ?? "none"})`;
        }
        try {
            if (record.logFd !== undefined) {
                // openSync handle is released on process exit; nothing else to clean up here.
                record.logFd = undefined;
            }
        }
        catch { /* best effort */ }
    });
    child.unref();
    return record;
}

function findPortInTail(text) {
    const match = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/.exec(text ?? "");
    return match ? Number(match[1]) : undefined;
}

export async function handleDevServerHostInput({ input, cwd }) {
    const detection = detectDevServer({ cwd });
    const normalized = normalizeDevServerInput(input, { candidates: detection.candidates });
    if (normalized.error || !normalized.value) {
        return devServerFailure(normalized.error ?? "Invalid devServer input.", { candidates: detection.candidates, warnings: detection.warnings });
    }
    const value = normalized.value;
    const { action } = value;
    if (action === "detect") {
        const probes = [];
        for (const candidate of detection.candidates) {
            if (!candidate.port) {
                continue;
            }
            const probe = await probeDevServerUrl(`http://127.0.0.1:${candidate.port}/`, { timeoutMs: 1000 });
            probes.push({ ok: probe.ok, port: candidate.port, httpStatus: probe.httpStatus });
        }
        return devServerSuccess("detect", {
            candidates: detection.candidates,
            framework: detection.candidates[0]?.framework,
            packageJsonPath: detection.packageJsonPath,
            probes,
            warnings: [...detection.warnings, ...(value.warnings ?? [])],
        }, [
            detection.candidates.length === 0
                ? `No dev-server candidate found in ${cwd}. Pass an explicit command to start one.`
                : `Detected ${detection.candidates.length} candidate(s): ${detection.candidates.map((candidate) => `${candidate.script} (:${candidate.port ?? "unknown"})`).join(", ")}`,
            probes.length > 0 ? `Port probes: ${probes.map((probe) => `${probe.port}=${probe.ok ? "listening" : "closed"}`).join(", ")}` : undefined,
        ]);
    }
    if (action === "status") {
        const records = listDevServerRecords();
        const probes = [];
        for (const record of records) {
            if (record.url) {
                probes.push({ id: record.id, ...(await probeDevServerUrl(record.url, { timeoutMs: 1000 })) });
            }
        }
        const single = value.port ? recordForPort(value.port) : undefined;
        if (single && !records.some((record) => record.id === single.id)) {
            records.push({ id: single.id, port: single.port, status: single.status, url: single.url });
        }
        return devServerSuccess("status", { probes, records }, records.length === 0
            ? ["No wrapper-owned dev server is running."]
            : records.map((record) => `- ${record.id} ${record.status}${record.url ? ` at ${record.url}` : ""}${record.pid ? ` (pid ${record.pid})` : ""}`));
    }
    if (action === "wait") {
        const target = value.url ?? (value.port ? `http://127.0.0.1:${value.port}/` : undefined);
        if (!target) {
            return devServerFailure("devServer.wait needs a port or url. Run action \"detect\" first.", {});
        }
        const ready = await waitForReady({ port: value.port, timeoutMs: value.timeoutMs, url: target });
        if (ready.status !== "ready") {
            return devServerFailure(`Nothing answered ${target} within ${value.timeoutMs} ms (${ready.reason}).`, { reason: ready.reason, url: target });
        }
        return devServerSuccess("wait", { httpStatus: ready.httpStatus, status: "ready", url: target }, [`Ready: ${target} answered with HTTP ${ready.httpStatus}.`]);
    }
    if (action === "stop") {
        const record = value.port ? recordForPort(value.port) : [...registry.records.values()][0];
        if (!record) {
            return devServerFailure("No wrapper-owned dev server matches that port, so nothing was stopped. The wrapper never kills a process it did not start.", {});
        }
        const stopped = await stopRecord(record);
        return stopped.ok
            ? devServerSuccess("stop", { id: record.id, port: record.port, status: record.status, url: record.url }, [`Stopped ${record.id}${record.url ? ` (${record.url})` : ""}.`])
            : devServerFailure(stopped.error ?? "The dev server did not stop cleanly.", { id: record.id, port: record.port, reason: stopped.reason });
    }
    // action === "start"
    const command = value.command ?? detection.candidates[0]?.command;
    const port = value.port ?? detection.candidates[0]?.port;
    if (!command) {
        return devServerFailure("devServer.start needs a command (none could be detected in package.json).", { candidates: detection.candidates });
    }
    const existing = [...registry.records.values()].find((record) => record.cwd === cwd && record.port === port && record.status !== "stopped" && record.status !== "exited");
    if (existing) {
        const probe = existing.url ? await probeDevServerUrl(existing.url, { timeoutMs: 1000 }) : { ok: false };
        if (probe.ok && existing.status === "ready") {
            return devServerSuccess("start", { existing: describeRecord(existing), started: false, status: existing.status }, [`Reused the already-running dev server ${existing.id} at ${existing.url}.`]);
        }
        return devServerFailure(`A wrapper-owned dev server for this cwd/port already exists (${existing.id}, status ${existing.status}). Stop it first, or use action "status".`, { existing: describeRecord(existing) });
    }
    if (port) {
        const preflight = await probeDevServerUrl(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 });
        if (preflight.ok) {
            return devServerFailure(`Something is already listening on port ${port} that this wrapper did not start. The wrapper will not kill or adopt it; use action "wait" or point the flow at the existing server.`, { port, adopted: false });
        }
    }
    const record = startProcess({ command, cwd, port, timeoutMs: value.timeoutMs, url: value.url });
    registry.records.set(record.id, record);
    const ready = await waitForReady({ child: record.child, port, timeoutMs: value.timeoutMs, url: record.url });
    record.status = ready.status;
    record.reason = ready.reason;
    if (ready.status === "ready") {
        record.readyAtMs = Date.now();
        const resolvedPort = record.port ?? findPortInTail(record.tail());
        if (resolvedPort && !record.port) {
            record.port = resolvedPort;
            record.url = `http://127.0.0.1:${resolvedPort}/`;
        }
        return devServerSuccess("start", { record: describeRecord(record), started: true, status: "ready" }, [`Started ${record.command} in ${cwd}${record.url ? ` and it answers at ${record.url}` : ""}.`]);
    }
    const failure = ready.status === "exited"
        ? `The dev server process exited before it answered (code ${record.lastExitCode ?? "unknown"}). Log: ${record.logPath}`
        : `The dev server did not answer within ${value.timeoutMs} ms (${ready.reason}). Log: ${record.logPath}`;
    await stopRecord(record);
    record.status = "failed";
    return devServerFailure(failure, { logPath: record.logPath, pid: record.pid, reason: ready.reason, stderrTail: record.stderrTail });
}

function recordForPort(port) {
    return [...registry.records.values()].find((record) => record.port === port);
}

function describeRecord(record) {
    return {
        command: redactCommand(record.command),
        id: record.id,
        logPath: record.logPath,
        pid: record.pid,
        port: record.port,
        startedAtMs: record.startedAtMs,
        status: record.status,
        url: record.url,
    };
}

async function stopRecord(record) {
    if (!record?.child || !record.pid) {
        if (record) {
            record.status = "stopped";
        }
        return { ok: true };
    }
    if (record.child.exitCode !== null) {
        record.status = "stopped";
        return { ok: true };
    }
    const signalGroup = (signal) => {
        try {
            process.kill(-record.pid, signal);
            return true;
        }
        catch {
            try {
                process.kill(record.pid, signal);
                return true;
            }
            catch {
                return false;
            }
        }
    };
    signalGroup("SIGTERM");
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline) {
        if (record.child.exitCode !== null) {
            record.status = "stopped";
            const probe = record.url ? await probeDevServerUrl(record.url, { timeoutMs: 1000 }) : { ok: false };
            return probe.ok
                ? { ok: true, reason: "process-exited-but-port-still-answers" }
                : { ok: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    signalGroup("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The observable truth is whether the port still answers: the child handle can lag behind the real
    // exit (detached shell, unref'd handle), so never claim "still alive" from exitCode alone.
    const probeAfterKill = record.url ? await probeDevServerUrl(record.url, { timeoutMs: 1000 }) : { ok: false };
    const aliveAfterKill = record.child.exitCode === null;
    if (!probeAfterKill.ok) {
        record.status = "stopped";
        return { ok: true, reason: aliveAfterKill ? "killed-after-grace" : undefined };
    }
    record.status = "failed";
    return { error: `The dev server (pid ${record.pid}) is still answering ${record.url} after SIGKILL, so it was left running.`, reason: "still-alive" };
}

/** Called from Pi shutdown. Never throws, never blocks for long. */
export async function stopAllDevServers({ timeoutMs = STOP_GRACE_MS } = {}) {
    const stopped = [];
    const failed = [];
    for (const record of [...registry.records.values()]) {
        if (record.status === "stopped" || record.child?.exitCode !== null) {
            record.status = "stopped";
            continue;
        }
        const result = await Promise.race([
            stopRecord(record),
            new Promise((resolve) => setTimeout(() => resolve({ error: "stop timed out", reason: "timeout" }), timeoutMs + 1000)),
        ]);
        if (result.ok) {
            stopped.push(record.id);
        }
        else {
            failed.push({ error: result.error, id: record.id });
        }
    }
    registry = { records: new Map() };
    return { failed, stopped };
}

function devServerSuccess(action, details = {}, lines = []) {
    return buildDevServerResult({ action, details, isError: false, lines });
}

function devServerFailure(message, details = {}) {
    return buildDevServerResult({ action: details.action ?? "devServer", details, isError: true, lines: [message] });
}

function buildDevServerResult({ action, details, isError, lines }) {
    return {
        content: [{ text: lines.filter(Boolean).join("\n") || `devServer ${action}`, type: "text" }],
        details: {
            categoryDetails: isError ? { failureCategory: "validation-error", resultCategory: "failure" } : { resultCategory: "success", successCategory: "completed" },
            devServer: { action, ...details },
        },
        isError,
    };
}
