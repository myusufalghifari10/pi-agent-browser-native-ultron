import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { directoryContainsSymlink, ensureManagedSessionRestoreStorageIsSecure, ensureOwnerOnlyDirectory, getManagedRestoreSessionsDirectory, isManagedSessionRestoreKey, resolveManagedSessionRestoreCheckoutRoot, resolveManagedSessionRestoreHome, } from "./managed-session-storage.js";
const OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP = 2;
const OWNED_RESTORE_SNAPSHOT_MAX_RECORDS = 256;
const OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES = 16 * 1_024;
const OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX = ".pi-agent-browser-owned-snapshots-v2";
const OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY = ".checkout-lineage-v1";
const OWNED_RESTORE_SNAPSHOT_TEMP_MAX_AGE_MS = 30_000;
const OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
function pathExistsOrIsUnreadable(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (error) {
        return error.code !== "ENOENT";
    }
}
function validateOwnedSnapshotPath(options) {
    if (!isAbsolute(options.path))
        return undefined;
    let path;
    try {
        path = realpathSync(options.path);
    }
    catch {
        return undefined;
    }
    const directory = getManagedRestoreSessionsDirectory(options.home, options.namespace);
    const name = basename(path);
    if (dirname(path) !== directory || !name.startsWith(`${options.restoreKey}-`))
        return undefined;
    if (!/\.json(?:\.enc)?$/.test(name))
        return undefined;
    try {
        const entry = lstatSync(path);
        return !entry.isSymbolicLink() && entry.isFile() ? path : undefined;
    }
    catch {
        return undefined;
    }
}
function getManifestDirectory(directory, restoreKey) {
    return join(directory, `${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-${restoreKey}`);
}
function ensureManifestDirectory(path, platform) {
    if (platform !== "win32")
        return ensureOwnerOnlyDirectory(path, platform) && !directoryContainsSymlink(path);
    try {
        mkdirSync(path, { recursive: true });
        const entry = lstatSync(path);
        return !entry.isSymbolicLink() && entry.isDirectory() && !directoryContainsSymlink(path);
    }
    catch {
        return false;
    }
}
function getCheckoutLineageHash(cwd, platform) {
    const checkoutRoot = resolveManagedSessionRestoreCheckoutRoot(cwd, platform);
    if (!checkoutRoot)
        return undefined;
    const normalizedRoot = platform === "win32" ? checkoutRoot.toLowerCase() : checkoutRoot;
    return createHash("sha256").update(`managed-snapshot-lineage-v1:${platform}:${normalizedRoot}`).digest("hex");
}
function manifestHasLineage(directory, lineage, platform) {
    const lineageDirectory = join(directory, OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY);
    try {
        const directoryEntry = lstatSync(lineageDirectory);
        if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory() || directoryContainsSymlink(lineageDirectory))
            return false;
        if (platform !== "win32") {
            const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
            if (uid === undefined || directoryEntry.uid !== uid || (directoryEntry.mode & 0o077) !== 0)
                return false;
        }
        const entry = lstatSync(join(lineageDirectory, lineage));
        if (entry.isSymbolicLink() || !entry.isFile() || entry.size !== 0)
            return false;
        return platform === "win32" || (entry.mode & 0o077) === 0;
    }
    catch {
        return false;
    }
}
function ensureManifestLineage(directory, lineage, platform) {
    const lineageDirectory = join(directory, OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY);
    if (!ensureManifestDirectory(lineageDirectory, platform))
        return false;
    const path = join(lineageDirectory, lineage);
    try {
        writeFileSync(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
        if (platform !== "win32")
            chmodSync(path, 0o600);
    }
    catch (error) {
        if (error.code !== "EEXIST")
            return false;
    }
    return manifestHasLineage(directory, lineage, platform);
}
function removeManifestLineages(directory, platform) {
    const lineageDirectory = join(directory, OWNED_RESTORE_SNAPSHOT_LINEAGE_DIRECTORY);
    try {
        if (!ensureManifestDirectory(lineageDirectory, platform))
            return;
        for (const entry of readdirSync(lineageDirectory, { withFileTypes: true })) {
            if (entry.isFile() && /^[a-f\d]{64}$/.test(entry.name))
                unlinkSync(join(lineageDirectory, entry.name));
        }
        rmdirSync(lineageDirectory);
    }
    catch { }
}
function getRecordPath(directory, snapshotPath) {
    const digest = createHash("sha256").update(snapshotPath).digest("hex");
    return join(directory, `${digest}.json`);
}
function writeRecord(directory, snapshotPath, platform) {
    const content = JSON.stringify(snapshotPath);
    if (Buffer.byteLength(content) > OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES)
        return false;
    const path = getRecordPath(directory, snapshotPath);
    try {
        const entry = lstatSync(path);
        if (entry.isSymbolicLink() || !entry.isFile())
            return false;
        if (entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES && JSON.parse(readFileSync(path, "utf8")) === snapshotPath) {
            if (platform !== "win32" && (entry.mode & 0o077) !== 0)
                return false;
            return true;
        }
        unlinkSync(path);
    }
    catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
            return false;
        try {
            unlinkSync(path);
        }
        catch { }
    }
    const temporaryPath = join(directory, `.tmp-${process.pid}-${randomUUID()}`);
    try {
        writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        renameSync(temporaryPath, path);
        if (platform !== "win32")
            chmodSync(path, 0o600);
        return true;
    }
    catch {
        try {
            const entry = lstatSync(path);
            return !entry.isSymbolicLink()
                && entry.isFile()
                && entry.size <= OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES
                && (platform === "win32" || (entry.mode & 0o077) === 0)
                && JSON.parse(readFileSync(path, "utf8")) === snapshotPath;
        }
        catch {
            return false;
        }
    }
    finally {
        try {
            unlinkSync(temporaryPath);
        }
        catch { }
    }
}
function readRecord(options) {
    try {
        const entry = lstatSync(options.path);
        if (entry.isSymbolicLink() || !entry.isFile() || entry.size > OWNED_RESTORE_SNAPSHOT_RECORD_MAX_BYTES)
            return undefined;
        if (options.platform !== "win32" && (entry.mode & 0o077) !== 0)
            return undefined;
        const parsed = JSON.parse(readFileSync(options.path, "utf8"));
        if (typeof parsed !== "string" || !isAbsolute(parsed))
            return undefined;
        const snapshotPath = validateOwnedSnapshotPath({ home: options.home, namespace: options.namespace, path: parsed, restoreKey: options.restoreKey });
        return snapshotPath && getRecordPath(dirname(options.path), snapshotPath) === options.path ? snapshotPath : undefined;
    }
    catch {
        return undefined;
    }
}
function pruneExpiredOtherRestoreKeys(options) {
    let removed = 0;
    let entries;
    try {
        entries = readdirSync(options.directory, { withFileTypes: true });
    }
    catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(`${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-`))
            continue;
        const restoreKey = entry.name.slice(`${OWNED_RESTORE_SNAPSHOT_MANIFEST_PREFIX}-`.length);
        if (!isManagedSessionRestoreKey(restoreKey) || restoreKey === options.protectedRestoreKey)
            continue;
        const manifestDirectory = join(options.directory, entry.name);
        if (!ensureManifestDirectory(manifestDirectory, options.platform))
            continue;
        if (!manifestHasLineage(manifestDirectory, options.lineage, options.platform))
            continue;
        let snapshots;
        try {
            snapshots = scanOwnedSnapshots({ home: options.home, manifestDirectory, namespace: options.namespace, platform: options.platform, restoreKey });
        }
        catch {
            continue;
        }
        for (const snapshot of snapshots) {
            if (snapshot.mtimeMs >= options.staleBefore)
                continue;
            try {
                const current = lstatSync(snapshot.path);
                if (current.isSymbolicLink() || !current.isFile() || current.mtimeMs !== snapshot.mtimeMs)
                    continue;
                unlinkSync(snapshot.path);
                try {
                    unlinkSync(snapshot.recordPath);
                }
                catch { }
                removed += 1;
            }
            catch (error) {
                if (error.code === "ENOENT") {
                    try {
                        unlinkSync(snapshot.recordPath);
                    }
                    catch { }
                }
            }
        }
        try {
            const remainingRecords = readdirSync(manifestDirectory).filter((name) => /^[a-f\d]{64}\.json$/.test(name));
            if (remainingRecords.length === 0)
                removeManifestLineages(manifestDirectory, options.platform);
            if (readdirSync(manifestDirectory).length === 0)
                rmdirSync(manifestDirectory);
        }
        catch { }
    }
    return removed;
}
function scanOwnedSnapshots(options) {
    const snapshots = [];
    for (const entry of readdirSync(options.manifestDirectory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith(".tmp-")) {
            const temporaryPath = join(options.manifestDirectory, entry.name);
            try {
                if (Date.now() - lstatSync(temporaryPath).mtimeMs > OWNED_RESTORE_SNAPSHOT_TEMP_MAX_AGE_MS)
                    unlinkSync(temporaryPath);
            }
            catch { }
            continue;
        }
        if (!entry.isFile() || !/^[a-f\d]{64}\.json$/.test(entry.name))
            continue;
        const recordPath = join(options.manifestDirectory, entry.name);
        const path = readRecord({ ...options, path: recordPath });
        if (!path) {
            try {
                unlinkSync(recordPath);
            }
            catch { }
            continue;
        }
        try {
            snapshots.push({ mtimeMs: lstatSync(path).mtimeMs, path, recordPath });
        }
        catch {
            try {
                unlinkSync(recordPath);
            }
            catch { }
        }
    }
    return snapshots.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
}
/** After an owned close, expire only close-proven snapshots while retaining two fallbacks. */
export function pruneOwnedManagedSessionRestoreSnapshots(options) {
    const parentEnv = options.parentEnv ?? process.env;
    const platform = options.platform ?? process.platform;
    const restoreKey = options.restoreKey;
    if (!isManagedSessionRestoreKey(restoreKey))
        return 0;
    const home = resolveManagedSessionRestoreHome(parentEnv, platform);
    if (!home)
        return 0;
    const directory = getManagedRestoreSessionsDirectory(home, options.namespace);
    const manifestDirectory = getManifestDirectory(directory, restoreKey);
    const hasCurrentManifest = pathExistsOrIsUnreadable(manifestDirectory);
    if (!ensureManagedSessionRestoreStorageIsSecure(parentEnv, platform, options.namespace))
        return 0;
    if ((options.statePath || hasCurrentManifest) && !ensureManifestDirectory(manifestDirectory, platform))
        return 0;
    const lineage = getCheckoutLineageHash(options.cwd, platform);
    if ((options.statePath || hasCurrentManifest) && (!lineage || !ensureManifestLineage(manifestDirectory, lineage, platform)))
        return 0;
    if (options.statePath) {
        const ownedPath = validateOwnedSnapshotPath({ home, namespace: options.namespace, path: options.statePath, restoreKey });
        if (ownedPath && !writeRecord(manifestDirectory, ownedPath, platform))
            return 0;
    }
    const staleBefore = Date.now() - OWNED_RESTORE_SNAPSHOT_MAX_AGE_MS;
    let removed = 0;
    for (let pass = 0; (options.statePath || hasCurrentManifest) && pass <= OWNED_RESTORE_SNAPSHOT_MAX_RECORDS; pass += 1) {
        const snapshots = scanOwnedSnapshots({ home, manifestDirectory, namespace: options.namespace, platform, restoreKey });
        const candidates = snapshots.filter((snapshot, index) => index >= OWNED_RESTORE_SNAPSHOT_MAX_RECORDS
            || (index >= OWNED_RESTORE_SNAPSHOT_FAMILIES_TO_KEEP && snapshot.mtimeMs < staleBefore));
        if (candidates.length === 0)
            break;
        let changed = false;
        for (const snapshot of candidates) {
            try {
                const current = lstatSync(snapshot.path);
                if (current.isSymbolicLink() || !current.isFile() || current.mtimeMs !== snapshot.mtimeMs)
                    continue;
                unlinkSync(snapshot.path);
                try {
                    unlinkSync(snapshot.recordPath);
                }
                catch { }
                removed += 1;
                changed = true;
            }
            catch (error) {
                if (error.code === "ENOENT") {
                    try {
                        unlinkSync(snapshot.recordPath);
                    }
                    catch { }
                    changed = true;
                }
            }
        }
        if (!changed)
            break;
    }
    const protectedRestoreKey = restoreKey;
    if (!lineage)
        return removed;
    removed += pruneExpiredOtherRestoreKeys({
        directory,
        home,
        lineage,
        namespace: options.namespace,
        platform,
        protectedRestoreKey,
        staleBefore,
    });
    return removed;
}
