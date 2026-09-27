// local patch: local dev-server detection + readiness helpers (PATCHES.md P15).
//
// Why this exists: almost every frontend QA flow starts with "is my app even running?". The wrapper
// previously had no idea, so the agent had to poke URLs and guess. This module keeps that work pure and
// testable: detection reads package.json only and NEVER executes anything, readiness analysis turns a
// probe result into a verdict, and the ownership helpers reuse the same record/log-tail shape the
// Electron launcher already uses (`launchId`, `cleanupState`, bounded 4096-byte tails) so host-side
// start/stop code in the wrapper can stay thin.
//
// `detectDevServer` is synchronous on purpose: it mirrors `loadAgentBrowserConfigSync` and is safe to
// await anyway. An injectable `fs` keeps it unit-testable without touching a real project.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEV_SERVER_ACTIONS = ["detect", "wait", "start", "stop", "status"];
export const DEV_SERVER_DEFAULT_TIMEOUT_MS = 30_000;
export const DEV_SERVER_MAX_TIMEOUT_MS = 300_000;
export const DEV_SERVER_POLL_INTERVAL_MS = 250;
export const DEV_SERVER_MAX_CANDIDATES = 10;
export const DEV_SERVER_MAX_NOTES = 8;
export const DEV_SERVER_LOG_TAIL_MAX_CHARS = 4_096;
export const DEV_SERVER_PROBE_BODY_PREVIEW_MAX_CHARS = 200;
export const DEV_SERVER_LAUNCH_RECORD_VERSION = 1;
export const DEV_SERVER_LAUNCH_ID_PREFIX = "devserver-";

const DEV_SERVER_ALLOWED_FIELDS = new Set(["action", "command", "cwd", "port", "timeoutMs", "url"]);

// Exact script names come first; namespaced variants (`dev:web`) are accepted after them because many
// monorepos only expose those.
const DEV_SCRIPT_NAMES = ["dev", "start", "serve", "preview"];

// Ordered: the first package found in the dependency list wins, so a Next app that also has Vite in its
// devDependencies is still reported as Next.
const FRAMEWORK_DEFAULTS = [
    { framework: "expo", packages: ["expo"], port: 8081 },
    { framework: "next", packages: ["next"], port: 3000 },
    { framework: "nuxt", packages: ["nuxt"], port: 3000 },
    { framework: "remix", packages: ["@remix-run/dev"], port: 3000 },
    { framework: "astro", packages: ["astro"], port: 4321 },
    { framework: "svelte-kit", packages: ["@sveltejs/kit"], port: 5173 },
    { framework: "vite", packages: ["vite"], port: 5173 },
    { framework: "angular", packages: ["@angular/core"], port: 4200 },
];

const PACKAGE_MANAGER_LOCKFILES = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
];

const SCRIPT_PORT_PATTERNS = [
    /(?:^|\s)--port[=\s]+(\d{2,5})(?=\s|$)/i,
    /(?:^|\s)-p[=\s]+(\d{2,5})(?=\s|$)/,
    /(?:^|\s)PORT=(\d{2,5})(?=\s|$)/,
    /(?:^|\s)--listen[=\s]+(?:\S*:)?(\d{2,5})(?=\s|$)/i,
    /(?:^|\s)--host[=\s]+\S*:(\d{2,5})(?=\s|$)/i,
];

const SHELL_METACHARACTER_PATTERN = /[|&;<>()$`\\"'\n]/;

const DEFAULT_FS = { existsSync, readFileSync };

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePort(value) {
    const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) {
        return undefined;
    }
    return numeric;
}

function getScriptPriority(name) {
    if (DEV_SCRIPT_NAMES.includes(name)) {
        return DEV_SCRIPT_NAMES.indexOf(name);
    }
    const separatorIndex = name.indexOf(":");
    if (separatorIndex <= 0) {
        return undefined;
    }
    const head = name.slice(0, separatorIndex);
    const tail = name.slice(separatorIndex + 1);
    if (!tail || !DEV_SCRIPT_NAMES.includes(head)) {
        return undefined;
    }
    return 100 + DEV_SCRIPT_NAMES.indexOf(head);
}

function extractPortFromScript(scriptText) {
    if (typeof scriptText !== "string" || scriptText.length === 0) {
        return undefined;
    }
    for (const pattern of SCRIPT_PORT_PATTERNS) {
        const match = pattern.exec(scriptText);
        if (match) {
            const port = normalizePort(match[1]);
            if (port !== undefined) {
                return port;
            }
        }
    }
    return undefined;
}

function detectFramework(dependencies) {
    for (const entry of FRAMEWORK_DEFAULTS) {
        if (entry.packages.some((name) => dependencies.has(name))) {
            return entry;
        }
    }
    return undefined;
}

function detectPackageManager({ cwd, fs }) {
    for (const [lockfile, packageManager] of PACKAGE_MANAGER_LOCKFILES) {
        try {
            if (fs.existsSync(join(cwd, lockfile))) {
                return packageManager;
            }
        }
        catch {
            return "npm";
        }
    }
    return "npm";
}

/**
 * Read-only project detection. Never executes a script and never throws: unusable input becomes a
 * warning so a caller can still report something useful.
 */
export function detectDevServer({ cwd, fs } = {}) {
    const adapter = fs ?? DEFAULT_FS;
    const warnings = [];
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
        return { candidates: [], warnings: ["A working directory is required to detect a dev server."] };
    }
    const packageJsonPath = join(cwd, "package.json");
    let packageJsonExists = false;
    try {
        packageJsonExists = adapter.existsSync(packageJsonPath) === true;
    }
    catch (error) {
        return { candidates: [], warnings: [`The project directory could not be inspected: ${error instanceof Error ? error.message : String(error)}`], packageJsonPath };
    }
    if (!packageJsonExists) {
        return { candidates: [], warnings: [`No package.json found in ${cwd}; pass an explicit command and port instead.`], packageJsonPath };
    }
    let parsed;
    try {
        parsed = JSON.parse(adapter.readFileSync(packageJsonPath, "utf8"));
    }
    catch (error) {
        return { candidates: [], warnings: [`package.json could not be parsed (${error instanceof Error ? error.message : String(error)}); fix it or pass an explicit command and port.`], packageJsonPath };
    }
    if (!isPlainObject(parsed)) {
        return { candidates: [], warnings: ["package.json did not contain an object; pass an explicit command and port instead."], packageJsonPath };
    }
    const scripts = isPlainObject(parsed.scripts) ? parsed.scripts : {};
    const dependencies = new Set([...Object.keys(isPlainObject(parsed.dependencies) ? parsed.dependencies : {}), ...Object.keys(isPlainObject(parsed.devDependencies) ? parsed.devDependencies : {})]);
    const frameworkEntry = detectFramework(dependencies);
    const packageManager = detectPackageManager({ cwd, fs: adapter });
    const candidates = [];
    for (const [name, scriptText] of Object.entries(scripts)) {
        const priority = getScriptPriority(name);
        if (priority === undefined || typeof scriptText !== "string") {
            continue;
        }
        const scriptPort = extractPortFromScript(scriptText);
        const port = scriptPort ?? frameworkEntry?.port;
        candidates.push({
            command: `${packageManager} run ${name}`,
            framework: frameworkEntry?.framework,
            port,
            priority,
            script: name,
            source: scriptPort !== undefined ? "script" : frameworkEntry ? "framework-default" : "unknown",
        });
    }
    candidates.sort((left, right) => {
        if ((left.port !== undefined) !== (right.port !== undefined)) {
            return left.port !== undefined ? -1 : 1;
        }
        if (left.priority !== right.priority) {
            return left.priority - right.priority;
        }
        return left.script.localeCompare(right.script);
    });
    const bounded = candidates.slice(0, DEV_SERVER_MAX_CANDIDATES).map(({ priority, ...candidate }) => candidate);
    if (candidates.length > bounded.length) {
        warnings.push(`Showing the first ${bounded.length} of ${candidates.length} candidate scripts.`);
    }
    if (bounded.length === 0) {
        warnings.push(`No dev/start/serve/preview script found in ${packageJsonPath}; pass an explicit command and port.`);
    }
    const first = bounded[0];
    if (first) {
        if (first.port === undefined) {
            warnings.push(`The "${first.script}" script does not declare a port${frameworkEntry ? "" : " and no known framework set a default"}; pass --port or an explicit task port.`);
        }
        if (first.script === "start" && first.framework && first.framework !== "angular") {
            warnings.push(`"${first.script}" for ${first.framework} usually runs a production build; prefer the dev script for QA.`);
        }
    }
    return {
        candidates: bounded,
        packageJsonPath,
        packageManager,
        warnings: warnings.slice(0, DEV_SERVER_MAX_NOTES),
    };
}

/**
 * Validate a `devServer` input. `candidates` (from a previous detect) is what makes "start without an
 * explicit command" safe: it is only allowed when exactly one script is detectable.
 */
export function normalizeDevServerInput(input, { candidates = [] } = {}) {
    if (input === undefined || input === null) {
        return { value: { action: "detect", timeoutMs: DEV_SERVER_DEFAULT_TIMEOUT_MS, warnings: [] } };
    }
    if (!isPlainObject(input)) {
        return { error: "devServer must be an object." };
    }
    const unknownField = Object.keys(input).find((field) => !DEV_SERVER_ALLOWED_FIELDS.has(field));
    if (unknownField) {
        return { error: `devServer does not support ${unknownField}; supported fields are ${[...DEV_SERVER_ALLOWED_FIELDS].join(", ")}.` };
    }
    const action = input.action ?? "detect";
    if (typeof action !== "string" || !DEV_SERVER_ACTIONS.includes(action)) {
        return { error: `devServer.action must be one of ${DEV_SERVER_ACTIONS.join(", ")}.` };
    }
    const warnings = [];
    let timeoutMs = DEV_SERVER_DEFAULT_TIMEOUT_MS;
    if (input.timeoutMs !== undefined) {
        if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
            return { error: "devServer.timeoutMs must be a positive integer when provided." };
        }
        if (input.timeoutMs > DEV_SERVER_MAX_TIMEOUT_MS) {
            return { error: `devServer.timeoutMs must be ${DEV_SERVER_MAX_TIMEOUT_MS} or less.` };
        }
        timeoutMs = input.timeoutMs;
    }
    if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.trim().length === 0)) {
        return { error: "devServer.cwd must be a non-empty string when provided." };
    }
    let port;
    if (input.port !== undefined) {
        port = normalizePort(input.port);
        if (port === undefined) {
            return { error: "devServer.port must be an integer between 1 and 65535 when provided." };
        }
    }
    let url;
    if (input.url !== undefined) {
        if (typeof input.url !== "string" || input.url.trim().length === 0) {
            return { error: "devServer.url must be a non-empty string when provided." };
        }
        const requestedHost = parseProbeUrl(input.url)?.hostname;
        url = getDevServerReadinessProbeUrl(input.url);
        if (!url) {
            return { error: `devServer.url "${input.url}" is not a usable http(s) URL.` };
        }
        if (requestedHost !== undefined && !isLoopbackHostname(requestedHost)) {
            warnings.push(`devServer.url points at ${requestedHost}, not loopback; confirm that host is really a local dev server.`);
        }
        port = port ?? Number(new URL(url).port || (new URL(url).protocol === "https:" ? 443 : 80));
    }
    let command;
    if (input.command !== undefined) {
        if (typeof input.command !== "string" || input.command.trim().length === 0) {
            return { error: "devServer.command must be a non-empty string when provided." };
        }
        command = input.command.trim();
        if (SHELL_METACHARACTER_PATTERN.test(command)) {
            warnings.push("devServer.command contains shell metacharacters; it is spawned without a shell, so they will be passed as literal arguments.");
        }
    }
    const usableCandidates = Array.isArray(candidates) ? candidates : [];
    if (action === "start" && !command) {
        if (usableCandidates.length === 1) {
            command = usableCandidates[0].command;
            port = port ?? usableCandidates[0].port;
        }
        else if (usableCandidates.length === 0) {
            return { error: "devServer start needs a command because no dev script could be detected here. Run devServer detect first, or pass command explicitly (for example \"npm run dev\")." };
        }
        else {
            return { error: `devServer start is ambiguous: ${usableCandidates.length} dev scripts were detected (${usableCandidates.map((candidate) => candidate.command).join(", ")}). Pass one of them as command.` };
        }
    }
    if ((action === "wait" || action === "status") && !url) {
        const candidatePort = port ?? (usableCandidates.length === 1 ? usableCandidates[0].port : undefined);
        if (candidatePort === undefined) {
            return { error: `devServer ${action} needs a port or a url. Pass { "port": 5173 } (or url) so the wrapper knows what to probe.` };
        }
        port = candidatePort;
        url = getDevServerReadinessProbeUrl(candidatePort);
    }
    return {
        value: {
            action,
            command,
            cwd: input.cwd,
            port,
            timeoutMs,
            url,
            warnings,
        },
    };
}

function parseProbeUrl(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return undefined;
    }
    const trimmed = value.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        const parsed = new URL(withScheme);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return undefined;
        }
        return parsed;
    }
    catch {
        return undefined;
    }
}

export function isLoopbackHostname(hostname) {
    if (typeof hostname !== "string") {
        return false;
    }
    const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/**
 * Canonical probe URL. Loopback spellings (`localhost`, `::1`, `127.0.0.1`) all collapse to 127.0.0.1
 * so IPv6/IPv4 resolution differences cannot make a running server look dead, the path/query/fragment is
 * dropped because only readiness matters, and the scheme is preserved (default http) so an https dev
 * server keeps working. A NON-loopback host is preserved as given rather than rewritten: rewriting it
 * would probe a different machine than the caller asked about.
 */
export function getDevServerReadinessProbeUrl(portOrUrl) {
    if (typeof portOrUrl === "number" || (typeof portOrUrl === "string" && /^\d{1,5}$/.test(portOrUrl.trim()))) {
        const port = normalizePort(portOrUrl);
        return port === undefined ? undefined : `http://127.0.0.1:${port}/`;
    }
    const parsed = parseProbeUrl(portOrUrl);
    if (!parsed) {
        return undefined;
    }
    const port = parsed.port
        ? normalizePort(parsed.port)
        : normalizePort(parsed.protocol === "https:" ? 443 : 80);
    if (port === undefined || parsed.hostname.length === 0) {
        return undefined;
    }
    const hostname = isLoopbackHostname(parsed.hostname) ? "127.0.0.1" : parsed.hostname.toLowerCase();
    return `${parsed.protocol}//${hostname}:${port}/`;
}

export function isLoopbackProbeUrl(url) {
    const parsed = parseProbeUrl(url);
    return parsed ? isLoopbackHostname(parsed.hostname) : false;
}

function classifyProbeError(error) {
    const text = typeof error === "string" ? error : error instanceof Error ? error.message : String(error ?? "");
    const normalized = text.toLowerCase();
    if (normalized.includes("econnrefused") || normalized.includes("connection refused")) {
        return "connection-refused";
    }
    if (normalized.includes("etimedout") || normalized.includes("timeout") || normalized.includes("timed out")) {
        return "timeout";
    }
    if (normalized.includes("enotfound") || normalized.includes("getaddrinfo")) {
        return "dns-not-found";
    }
    if (normalized.includes("abort")) {
        return "aborted";
    }
    if (normalized.includes("econnreset")) {
        return "connection-reset";
    }
    return "connection-error";
}

/**
 * Turn one readiness probe into a verdict. Any HTTP answer below 500 means a server is listening — a 404
 * from a dev server that has no route for `/` is normal and must not be reported as down.
 */
export function analyzeDevServerProbe({ status, bodyPreview, error } = {}) {
    if (error !== undefined && error !== null && error !== "") {
        const reason = classifyProbeError(error);
        const message = (typeof error === "string" ? error : error instanceof Error ? error.message : String(error)).slice(0, 200);
        return { ready: false, reason, message };
    }
    const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    if (httpStatus === undefined) {
        return { ready: false, reason: "no-response" };
    }
    if (httpStatus >= 500) {
        return { httpStatus, ready: false, reason: "server-error" };
    }
    const preview = typeof bodyPreview === "string" ? bodyPreview : "";
    const trimmed = preview.trimStart().toLowerCase();
    const contentKind = preview.length === 0
        ? "empty"
        : trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html")
            ? "html"
            : trimmed.startsWith("{") || trimmed.startsWith("[")
                ? "json"
                : "text";
    return {
        bodyPreviewChars: preview.slice(0, DEV_SERVER_PROBE_BODY_PREVIEW_MAX_CHARS).length,
        contentKind,
        httpStatus,
        ready: true,
        reason: "http-response",
    };
}

export function buildDevServerSpawnPlan({ command } = {}) {
    if (typeof command !== "string" || command.trim().length === 0) {
        return { error: "A non-empty dev server command is required." };
    }
    const tokens = command.trim().split(/\s+/);
    const [binary, ...args] = tokens;
    return {
        args,
        command: binary,
        displayCommand: tokens.join(" "),
        shell: false,
    };
}

export function createDevServerLaunchRecord({ command, cwd, port, pid, logFile, framework, startedAtMs } = {}) {
    return {
        cleanupState: "active",
        command,
        cwd,
        framework,
        launchId: `${DEV_SERVER_LAUNCH_ID_PREFIX}${randomBytes(6).toString("hex")}`,
        logFile,
        ownedByWrapper: true,
        pid,
        port,
        startedAtMs: Number.isSafeInteger(startedAtMs) ? startedAtMs : Date.now(),
        version: DEV_SERVER_LAUNCH_RECORD_VERSION,
    };
}

export function isDevServerLaunchRecord(value) {
    return isPlainObject(value)
        && value.version === DEV_SERVER_LAUNCH_RECORD_VERSION
        && typeof value.launchId === "string"
        && value.launchId.startsWith(DEV_SERVER_LAUNCH_ID_PREFIX)
        && typeof value.command === "string"
        && value.command.length > 0
        && ["active", "cleaned", "dead", "failed", "partial", "stopped"].includes(value.cleanupState);
}

/** Bounded tail: keep the newest bytes, then trim to the first newline so output cannot start mid-line. */
export function trimDevServerLogTail(text, maxChars = DEV_SERVER_LOG_TAIL_MAX_CHARS) {
    if (typeof text !== "string" || text.length === 0) {
        return { tail: undefined, truncated: false };
    }
    const budget = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEV_SERVER_LOG_TAIL_MAX_CHARS;
    if (text.length <= budget) {
        return { tail: text, truncated: false };
    }
    const sliced = text.slice(-budget);
    const newlineIndex = sliced.indexOf("\n");
    const tail = newlineIndex >= 0 && newlineIndex < sliced.length - 1 ? sliced.slice(newlineIndex + 1) : sliced;
    return { tail, truncated: true };
}

function boundText(value, maxChars) {
    return typeof value === "string" ? value.slice(0, maxChars) : undefined;
}

/** Assemble the model-facing report. Bounded and secret-free by construction. */
export function buildDevServerReport(options = {}) {
    const notes = (Array.isArray(options.notes) ? options.notes : []).filter((note) => typeof note === "string" && note.length > 0).slice(0, DEV_SERVER_MAX_NOTES);
    const candidates = Array.isArray(options.candidates)
        ? options.candidates.slice(0, DEV_SERVER_MAX_CANDIDATES).map((candidate) => ({
            command: boundText(candidate?.command, 200),
            framework: boundText(candidate?.framework, 40),
            port: normalizePort(candidate?.port),
            script: boundText(candidate?.script, 64),
            source: boundText(candidate?.source, 32),
        }))
        : undefined;
    const report = {
        action: options.action,
        candidates,
        command: boundText(options.command, 200),
        counts: {
            candidates: candidates?.length ?? 0,
            notes: notes.length,
        },
        framework: boundText(options.framework, 40),
        launch: options.launch && isPlainObject(options.launch)
            ? {
                cleanupState: options.launch.cleanupState,
                launchId: options.launch.launchId,
                pid: options.launch.pid,
                port: normalizePort(options.launch.port),
                startedAtMs: options.launch.startedAtMs,
            }
            : undefined,
        logTail: boundText(options.logTail, DEV_SERVER_LOG_TAIL_MAX_CHARS),
        logTailTruncated: options.logTailTruncated === true,
        notes,
        port: normalizePort(options.port),
        probe: options.probe && isPlainObject(options.probe)
            ? {
                bodyPreviewChars: options.probe.bodyPreviewChars,
                contentKind: boundText(options.probe.contentKind, 16),
                httpStatus: options.probe.httpStatus,
                message: boundText(options.probe.message, 200),
                ready: options.probe.ready === true,
                reason: boundText(options.probe.reason, 40),
            }
            : undefined,
        status: options.status ?? "succeeded",
        url: boundText(options.url, 300),
    };
    return report;
}

export function formatDevServerSummary(report) {
    if (!isPlainObject(report)) {
        return "Dev server: no report.";
    }
    if (report.action === "detect") {
        const count = report.counts?.candidates ?? 0;
        if (count === 0) {
            return "Dev server: no dev script detected for this project.";
        }
        const first = report.candidates?.[0];
        const location = first?.port !== undefined ? ` on port ${first.port}` : " (no port declared)";
        return `Dev server: ${count} candidate script(s); first is "${first?.command}"${location}${first?.framework ? ` (${first.framework})` : ""}.`;
    }
    if (report.action === "wait" || report.action === "status") {
        const state = report.probe?.ready ? "ready" : "not ready";
        const detail = report.probe?.reason ? ` (${report.probe.reason}${report.probe.httpStatus ? `, HTTP ${report.probe.httpStatus}` : ""})` : "";
        return `Dev server at ${report.url ?? "unknown url"} is ${state}${detail}.`;
    }
    if (report.action === "start") {
        return `Dev server ${report.status === "succeeded" ? "started" : "failed to start"}${report.launch?.pid ? ` (pid ${report.launch.pid})` : ""}${report.port ? ` on port ${report.port}` : ""}.`;
    }
    if (report.action === "stop") {
        return `Dev server ${report.status === "succeeded" ? "stopped" : "could not be stopped"}${report.launch?.launchId ? ` (${report.launch.launchId})` : ""}.`;
    }
    return `Dev server action ${report.action ?? "unknown"} ${report.status ?? "unknown"}.`;
}
