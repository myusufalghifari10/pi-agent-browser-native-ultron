import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { canonicalizeAgentBrowserNamespace, getAgentBrowserSessionIdentityKey } from "./argv-grammar.js";
import { processStartIdentitiesMatch, readProcessStartIdentity } from "./process-identity.js";
const POLICY_LOCK_WAIT_MS = 1_000;
const POLICY_LOCK_RETRY_MS = 10;
const POLICY_LOCK_MAX_BYTES = 4_096;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_TICKET_FILE = "ticket.json";
function getCoordinationDirectory(platform = process.platform) {
    if (platform !== "win32") {
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        return platform === "android"
            ? join(tmpdir(), `pi-agent-browser-policy${uid === undefined ? "" : `-${uid}`}`)
            : `/tmp/pi-agent-browser-policy${uid === undefined ? "" : `-${uid}`}`;
    }
    const user = process.env.USERNAME ?? process.env.USER ?? "unknown";
    const suffix = createHash("sha256").update(user).digest("hex").slice(0, 12);
    return join(tmpdir(), `pi-agent-browser-policy-${suffix}`);
}
async function ensureCoordinationDirectory(path, platform) {
    try {
        try {
            await mkdir(path, { mode: 0o700 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                return false;
        }
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isDirectory())
            return false;
        if (platform !== "win32") {
            const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
            if (uid === undefined || entry.uid !== uid || (entry.mode & 0o077) !== 0)
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function getPolicyLockDigest(sessionName, namespace) {
    const identity = getAgentBrowserSessionIdentityKey(sessionName, canonicalizeAgentBrowserNamespace(namespace));
    return createHash("sha256").update(identity).digest("hex");
}
export function getManagedSessionPolicyLockPath(sessionName, namespace) {
    return join(getCoordinationDirectory(), `.pi-agent-browser-policy-${getPolicyLockDigest(sessionName, namespace)}.lock-v3`);
}
function parseOwner(content) {
    if (Buffer.byteLength(content) > POLICY_LOCK_MAX_BYTES)
        return undefined;
    try {
        const parsed = JSON.parse(content);
        return parsed.version === 3
            && Number.isSafeInteger(parsed.pid) && (parsed.pid ?? 0) > 0
            && typeof parsed.startIdentity === "string" && parsed.startIdentity.length > 0
            && typeof parsed.token === "string" && parsed.token.length > 0
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
function parseTicket(content, token) {
    if (Buffer.byteLength(content) > POLICY_LOCK_MAX_BYTES)
        return undefined;
    try {
        const parsed = JSON.parse(content);
        return parsed.version === 3
            && parsed.token === token
            && Number.isSafeInteger(parsed.ticket)
            && (parsed.ticket ?? 0) > 0
            ? parsed.ticket
            : undefined;
    }
    catch {
        return undefined;
    }
}
async function readClaim(path) {
    try {
        const directory = await lstat(path);
        const ownerPath = join(path, LOCK_OWNER_FILE);
        const ownerEntry = await lstat(ownerPath);
        if (!directory.isDirectory() || directory.isSymbolicLink() || !ownerEntry.isFile() || ownerEntry.isSymbolicLink())
            return undefined;
        if (ownerEntry.size > POLICY_LOCK_MAX_BYTES)
            return undefined;
        if (process.platform !== "win32") {
            const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
            if (uid === undefined || directory.uid !== uid || ownerEntry.uid !== uid || (directory.mode & 0o077) !== 0 || (ownerEntry.mode & 0o177) !== 0)
                return undefined;
        }
        const owner = parseOwner(await readFile(ownerPath, "utf8"));
        if (!owner)
            return undefined;
        const ticketPath = join(path, LOCK_TICKET_FILE);
        try {
            const ticketEntry = await lstat(ticketPath);
            if (!ticketEntry.isFile() || ticketEntry.isSymbolicLink() || ticketEntry.size > POLICY_LOCK_MAX_BYTES)
                return undefined;
            if (process.platform !== "win32") {
                const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
                if (uid === undefined || ticketEntry.uid !== uid || (ticketEntry.mode & 0o177) !== 0)
                    return undefined;
            }
            const ticket = parseTicket(await readFile(ticketPath, "utf8"), owner.token);
            return ticket === undefined ? undefined : { owner, path, ticket };
        }
        catch (error) {
            return error.code === "ENOENT" ? { owner, path, ticket: null } : undefined;
        }
    }
    catch {
        return undefined;
    }
}
async function readClaims(basePath) {
    const directory = dirname(basePath);
    const prefix = `${basename(basePath)}.claim-`;
    let names;
    try {
        names = await readdir(directory);
    }
    catch {
        return undefined;
    }
    const claims = [];
    for (const name of names.filter((candidate) => candidate.startsWith(prefix))) {
        const path = join(directory, name);
        const claim = await readClaim(path);
        if (!claim) {
            try {
                await lstat(path);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    continue;
            }
            return undefined;
        }
        if (name !== `${prefix}${claim.owner.token}`)
            return undefined;
        claims.push(claim);
    }
    return claims;
}
async function ownerAlive(owner) {
    try {
        process.kill(owner.pid, 0);
    }
    catch (error) {
        const code = error.code;
        if (code === "ESRCH")
            return false;
        if (code !== "EPERM")
            return undefined;
    }
    const current = await readProcessStartIdentity(owner.pid);
    return current === undefined ? undefined : processStartIdentitiesMatch(owner.startIdentity, current);
}
async function removeClaimOwnedBy(path, token) {
    const current = await readClaim(path);
    if (current?.owner.token !== token)
        return false;
    const movedPath = join(dirname(path), `.pi-agent-browser-policy-remove-${token}-${randomUUID()}`);
    try {
        await rename(path, movedPath);
    }
    catch (error) {
        return error.code === "ENOENT";
    }
    const moved = await readClaim(movedPath);
    if (moved?.owner.token !== token) {
        try {
            await rename(movedPath, path);
        }
        catch { }
        return false;
    }
    await rm(movedPath, { force: true, recursive: true });
    return true;
}
async function cleanDeadPolicyArtifacts(directory) {
    let names;
    try {
        names = await readdir(directory);
    }
    catch {
        return;
    }
    for (const name of names.filter((candidate) => candidate.startsWith(".pi-agent-browser-policy-remove-")
        || candidate.includes(".lock-v3.candidate-"))) {
        const path = join(directory, name);
        const claim = await readClaim(path);
        if (claim && await ownerAlive(claim.owner) === false)
            await rm(path, { force: true, recursive: true }).catch(() => undefined);
    }
}
function claimPrecedes(left, right) {
    if (left.ticket === null)
        return true;
    if (right.ticket === null)
        return false;
    return left.ticket < right.ticket || (left.ticket === right.ticket && left.owner.token < right.owner.token);
}
function waitForRetry(signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        const timer = setTimeout(done, POLICY_LOCK_RETRY_MS);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });
}
export async function acquireManagedSessionPolicyLock(options) {
    if (options.signal?.aborted)
        return undefined;
    const platform = process.platform;
    const directory = getCoordinationDirectory(platform);
    if (!await ensureCoordinationDirectory(directory, platform))
        return undefined;
    const basePath = getManagedSessionPolicyLockPath(options.sessionName, options.namespace);
    const token = randomUUID();
    const startIdentity = await readProcessStartIdentity(process.pid);
    if (!startIdentity)
        return undefined;
    const owner = { pid: process.pid, startIdentity, token, version: 3 };
    const candidatePath = `${basePath}.candidate-${token}`;
    const claimPath = `${basePath}.claim-${token}`;
    let claimPublished = false;
    let lockAcquired = false;
    try {
        await mkdir(candidatePath, { mode: 0o700 });
        await writeFile(join(candidatePath, LOCK_OWNER_FILE), JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(candidatePath, claimPath);
        claimPublished = true;
        const initialClaims = await readClaims(basePath);
        if (!initialClaims)
            return undefined;
        const maxTicket = initialClaims.reduce((max, claim) => claim.ticket === null ? max : Math.max(max, claim.ticket), 0);
        if (!Number.isSafeInteger(maxTicket + 1))
            return undefined;
        const ticket = { ticket: maxTicket + 1, token, version: 3 };
        const ticketCandidatePath = join(claimPath, `.ticket-${token}.tmp`);
        await writeFile(ticketCandidatePath, JSON.stringify(ticket), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(ticketCandidatePath, join(claimPath, LOCK_TICKET_FILE));
        const deadline = Date.now() + (options.timeoutMs ?? POLICY_LOCK_WAIT_MS);
        while (!options.signal?.aborted) {
            const claims = await readClaims(basePath);
            if (!claims)
                return undefined;
            const ownClaim = claims.find((claim) => claim.owner.token === token);
            if (!ownClaim || ownClaim.ticket !== ticket.ticket)
                return undefined;
            let blocked = false;
            for (const claim of claims) {
                if (claim.owner.token === token || !claimPrecedes(claim, ownClaim))
                    continue;
                const alive = await ownerAlive(claim.owner);
                if (alive === false) {
                    await removeClaimOwnedBy(claim.path, claim.owner.token);
                    continue;
                }
                blocked = true;
                break;
            }
            if (!blocked) {
                await cleanDeadPolicyArtifacts(directory);
                lockAcquired = true;
                return { release: async () => { await removeClaimOwnedBy(claimPath, token); } };
            }
            if (Date.now() >= deadline)
                return undefined;
            await waitForRetry(options.signal);
        }
        return undefined;
    }
    catch {
        return undefined;
    }
    finally {
        await rm(candidatePath, { force: true, recursive: true }).catch(() => undefined);
        if (claimPublished && !lockAcquired)
            await removeClaimOwnedBy(claimPath, token);
    }
}
