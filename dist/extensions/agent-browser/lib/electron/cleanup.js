import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fetchCdpJson, parseCdpTargets, parseCdpVersion } from "./cdp.js";
import { ELECTRON_PROFILE_DIR_PREFIX } from "./launch.js";
import { pathExists } from "../fs-utils.js";
import { getSecureTempChildDirectoryValidationError } from "../temp.js";
const ELECTRON_CLEANUP_DEFAULT_TIMEOUT_MS = 5_000;
const ELECTRON_CLEANUP_POLL_INTERVAL_MS = 100;
const RESTORED_PROCESS_COMMAND_TIMEOUT_MS = 1_000;
const execFileAsync = promisify(execFile);
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isPidAlive(pid) {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0)
        return undefined;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error.code;
        return code === "EPERM" ? true : false;
    }
}
async function isPortAlive(port, signal) {
    const version = parseCdpVersion(await fetchCdpJson(`http://127.0.0.1:${port}/json/version`, signal));
    if (!version)
        return { targets: [] };
    const targets = parseCdpTargets(await fetchCdpJson(`http://127.0.0.1:${port}/json/list`, signal));
    return { targets, version };
}
export async function inspectElectronLaunchStatus(record, signal) {
    const cdp = await isPortAlive(record.port, signal);
    let userDataDirState;
    try {
        await lstat(record.userDataDir);
        userDataDirState = "present";
    }
    catch (error) {
        userDataDirState = error.code === "ENOENT" ? "absent" : "unknown";
    }
    return {
        cleanupState: record.cleanupState,
        launchId: record.launchId,
        pid: record.pid,
        pidAlive: isPidAlive(record.pid),
        port: record.port,
        portAlive: cdp.version !== undefined,
        targets: cdp.targets,
        userDataDirState,
        version: cdp.version,
    };
}
async function waitForProcessExit(child, pid, deadlineMs) {
    while (Date.now() <= deadlineMs) {
        if (child && (child.exitCode !== null || child.signalCode !== null))
            return true;
        if (isPidAlive(pid) === false)
            return true;
        await sleep(ELECTRON_CLEANUP_POLL_INTERVAL_MS);
    }
    return isPidAlive(pid) === false;
}
async function readPidCommandLine(pid) {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0)
        return undefined;
    try {
        const { stdout } = await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
            timeout: RESTORED_PROCESS_COMMAND_TIMEOUT_MS,
        });
        return stdout.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
function restoredLaunchCommandMatchesRecord(record, commandLine) {
    return commandLine?.includes(`--user-data-dir=${record.userDataDir}`) === true;
}
async function getRestoredProcessVerificationError(record) {
    const commandLine = await readPidCommandLine(record.pid);
    if (!commandLine) {
        return `PID ${record.pid} is alive, but this session has no tracked child handle and its command line could not be inspected; refusing to signal a restored PID that may have been reused.`;
    }
    if (!restoredLaunchCommandMatchesRecord(record, commandLine)) {
        return `PID ${record.pid} is alive, but this session has no tracked child handle and its command line does not include wrapper-owned user data dir ${record.userDataDir}; refusing to signal a restored PID that may have been reused.`;
    }
    return undefined;
}
function killPid(pid, signal) {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, signal);
        return true;
    }
    catch {
        return false;
    }
}
function killProcessGroup(processGroupId, signal) {
    if (process.platform === "win32" || !processGroupId || !Number.isSafeInteger(processGroupId) || processGroupId <= 0)
        return false;
    try {
        process.kill(-processGroupId, signal);
        return true;
    }
    catch {
        return false;
    }
}
function signalRestoredLaunchProcess(record, signal) {
    return killProcessGroup(record.processGroupId, signal) || killPid(record.pid, signal);
}
async function cleanupProcess(record, child, deadlineMs) {
    if (!record.pid)
        return { resource: "process", state: "skipped" };
    if (isPidAlive(record.pid) === false)
        return { resource: "process", state: "already-gone" };
    if (!child) {
        const verificationError = await getRestoredProcessVerificationError(record);
        if (verificationError)
            return { error: verificationError, resource: "process", state: "failed" };
        if (!signalRestoredLaunchProcess(record, "SIGTERM")) {
            return { error: `PID ${record.pid} matched wrapper launch metadata but could not be signaled.`, resource: "process", state: "failed" };
        }
        if (await waitForProcessExit(undefined, record.pid, deadlineMs))
            return { resource: "process", state: "removed" };
        signalRestoredLaunchProcess(record, "SIGKILL");
        if (await waitForProcessExit(undefined, record.pid, Date.now() + 1_000))
            return { resource: "process", state: "removed" };
        return { error: `PID ${record.pid} remained alive after SIGTERM/SIGKILL.`, resource: "process", state: "failed" };
    }
    if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    else
        killPid(record.pid, "SIGTERM");
    if (await waitForProcessExit(child, record.pid, deadlineMs))
        return { resource: "process", state: "removed" };
    if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    else
        killPid(record.pid, "SIGKILL");
    if (await waitForProcessExit(child, record.pid, Date.now() + 1_000))
        return { resource: "process", state: "removed" };
    return { error: `PID ${record.pid} remained alive after SIGTERM/SIGKILL.`, resource: "process", state: "failed" };
}
async function cleanupUserDataDir(record) {
    if (!record.userDataDir)
        return { resource: "user-data-dir", state: "skipped" };
    if (!await pathExists(record.userDataDir))
        return { resource: "user-data-dir", state: "already-gone" };
    const validationError = await getSecureTempChildDirectoryValidationError(record.userDataDir, ELECTRON_PROFILE_DIR_PREFIX);
    if (validationError)
        return { error: validationError, resource: "user-data-dir", state: "failed" };
    try {
        await rm(record.userDataDir, { force: true, recursive: true });
        return { resource: "user-data-dir", state: await pathExists(record.userDataDir) ? "failed" : "removed" };
    }
    catch (error) {
        return { error: error instanceof Error ? error.message : String(error), resource: "user-data-dir", state: "failed" };
    }
}
function shouldSkipUserDataDirCleanup(processStep, debugPortStep) {
    if (processStep.state === "failed")
        return `Skipped because process cleanup failed: ${processStep.error ?? "process state could not be verified"}.`;
    if (debugPortStep.state === "failed")
        return `Skipped because debug port cleanup is incomplete: ${debugPortStep.error ?? "debug port still responds"}.`;
    return undefined;
}
async function cleanupDebugPort(record) {
    const cdp = await isPortAlive(record.port);
    return cdp.version ? { resource: "debug-port", state: "failed", error: `/json/version still responds on port ${record.port}.` } : { resource: "debug-port", state: "already-gone" };
}
function summarizeCleanup(launchId, steps) {
    const remainingResources = steps
        .filter((step) => step.state === "failed" || (step.resource === "user-data-dir" && step.state === "skipped" && step.error))
        .map((step) => step.resource);
    const partial = remainingResources.length > 0;
    return {
        partial,
        remainingResources,
        summary: partial
            ? `Electron cleanup for ${launchId} is partial; remaining resources: ${remainingResources.join(", ")}.`
            : `Electron cleanup for ${launchId} completed.`,
    };
}
export async function cleanupElectronLaunchResources(options) {
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
        ? options.timeoutMs
        : ELECTRON_CLEANUP_DEFAULT_TIMEOUT_MS;
    const deadlineMs = Date.now() + timeoutMs;
    const processStep = await cleanupProcess(options.record, options.child, deadlineMs);
    const debugPortStep = await cleanupDebugPort(options.record);
    const userDataDirSkipReason = shouldSkipUserDataDirCleanup(processStep, debugPortStep);
    const userDataDirStep = userDataDirSkipReason
        ? { error: userDataDirSkipReason, resource: "user-data-dir", state: "skipped" }
        : await cleanupUserDataDir(options.record);
    const steps = [processStep, debugPortStep, userDataDirStep];
    const summary = summarizeCleanup(options.record.launchId, steps);
    return {
        launchId: options.record.launchId,
        partial: summary.partial,
        record: {
            ...options.record,
            cleanupState: summary.partial ? "partial" : "cleaned",
        },
        remainingResources: summary.remainingResources,
        steps,
        summary: summary.summary,
    };
}
