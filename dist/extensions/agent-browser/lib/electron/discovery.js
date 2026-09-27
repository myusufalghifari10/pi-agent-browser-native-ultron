import { constants as fsConstants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathExists } from "../fs-utils.js";
export const ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS = 50;
export const ELECTRON_DISCOVERY_MAX_RESULTS = 200;
const LINUX_ELECTRON_CANDIDATE_MAX_DEPTH = 7;
const LINUX_ELECTRON_CANDIDATE_MAX_ENTRIES = 5_000;
const LINUX_NON_EXECUTABLE_CANDIDATE_EXTENSIONS = new Set([".asar", ".dat", ".desktop", ".json", ".md", ".pak", ".png", ".so", ".txt"]);
const ELECTRON_SENSITIVE_APP_CATEGORY_PATTERNS = [
    { category: "notes", patterns: [/\bobsidian\b/i, /\bnotion\b/i, /\blogseq\b/i] },
    { category: "chat", patterns: [/\bslack\b/i, /\bdiscord\b/i, /\bteams\b/i, /\bsignal\b/i, /\btelegram\b/i, /\bwhatsapp\b/i] },
    { category: "mail", patterns: [/\bmail\b/i, /\boutlook\b/i, /\bthunderbird\b/i, /\bspark\b/i, /\bproton[- ]?mail\b/i] },
    { category: "developer-workspace", patterns: [/\bvisual studio code\b/i, /\bvs ?code\b/i, /\bcode - insiders\b/i, /^code$/i, /\bcursor\b/i, /\bwindsurf\b/i] },
    { category: "passwords-auth", patterns: [/\b1password\b/i, /\bbitwarden\b/i, /\blastpass\b/i, /\bdashlane\b/i, /\bauthy\b/i, /\bauthenticator\b/i, /\bkeepass\b/i] },
];
function normalizeSensitivityValue(value) {
    return value?.trim().replace(/[_./\\-]+/g, " ").replace(/\s+/g, " ") || undefined;
}
export function getElectronAppSensitivity(app) {
    const metadataValues = [app.name, app.bundleId, app.desktopId, app.appPath, app.executablePath]
        .map(normalizeSensitivityValue)
        .filter((value) => value !== undefined);
    const categories = ELECTRON_SENSITIVE_APP_CATEGORY_PATTERNS
        .filter(({ patterns }) => metadataValues.some((value) => patterns.some((pattern) => pattern.test(value))))
        .map(({ category }) => category);
    if (categories.length === 0)
        return undefined;
    return {
        categories: [...new Set(categories)].sort(),
        level: "likely-sensitive",
        reason: "App name, bundle id, desktop id, or path matched common private-data app patterns; discovery still does not enforce policy.",
    };
}
function annotateElectronAppSensitivity(app) {
    const sensitivity = getElectronAppSensitivity(app);
    return sensitivity ? { ...app, sensitivity } : app;
}
function normalizeMaxResults(maxResults) {
    if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults <= 0) {
        return ELECTRON_DISCOVERY_DEFAULT_MAX_RESULTS;
    }
    return Math.min(maxResults, ELECTRON_DISCOVERY_MAX_RESULTS);
}
function resolveLocations(locations) {
    const homeDir = locations?.homeDir ?? homedir();
    return {
        darwinApplicationDirectories: locations?.darwinApplicationDirectories ?? ["/Applications", join(homeDir, "Applications")],
        flatpakSystemAppDirectory: locations?.flatpakSystemAppDirectory ?? "/var/lib/flatpak/app",
        flatpakUserAppDirectory: locations?.flatpakUserAppDirectory ?? join(homeDir, ".local", "share", "flatpak", "app"),
        homeDir,
        linuxDesktopDirectories: locations?.linuxDesktopDirectories ?? [
            join(homeDir, ".local", "share", "applications"),
            "/usr/share/applications",
            "/var/lib/snapd/desktop/applications",
            join(homeDir, ".local", "share", "flatpak", "exports", "share", "applications"),
            "/var/lib/flatpak/exports/share/applications",
        ],
        pathEnv: locations?.pathEnv ?? process.env.PATH ?? "",
        snapBinDirectory: locations?.snapBinDirectory ?? "/snap/bin",
        snapMountDirectory: locations?.snapMountDirectory ?? "/snap",
    };
}
async function isDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
async function isFile(path) {
    try {
        return (await stat(path)).isFile();
    }
    catch {
        return false;
    }
}
async function isExecutableFile(path) {
    try {
        const metadata = await stat(path);
        if (!metadata.isFile())
            return false;
        await access(path, fsConstants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function resolveRealPath(path) {
    try {
        return await realpath(path);
    }
    catch {
        return path;
    }
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function decodeXmlEntities(value) {
    return value
        .replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'");
}
function readPlistString(plist, key) {
    const pattern = new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`, "i");
    const match = pattern.exec(plist);
    return match ? decodeXmlEntities(match[1]?.trim() ?? "") : undefined;
}
async function readMacInfoPlist(appPath) {
    try {
        const plist = await readFile(join(appPath, "Contents", "Info.plist"), "utf8");
        return {
            CFBundleDisplayName: readPlistString(plist, "CFBundleDisplayName") ?? "",
            CFBundleExecutable: readPlistString(plist, "CFBundleExecutable") ?? "",
            CFBundleIdentifier: readPlistString(plist, "CFBundleIdentifier") ?? "",
            CFBundleName: readPlistString(plist, "CFBundleName") ?? "",
        };
    }
    catch {
        return {};
    }
}
async function resolveMacExecutablePath(appPath, executableName, fallbackName) {
    const macOsDirectory = join(appPath, "Contents", "MacOS");
    if (executableName && executableName.trim().length > 0) {
        const executablePath = join(macOsDirectory, executableName);
        return await pathExists(executablePath) ? executablePath : undefined;
    }
    try {
        const entries = await readdir(macOsDirectory, { withFileTypes: true });
        const exact = entries.find((entry) => entry.isFile() && entry.name === fallbackName);
        const candidate = exact ?? entries.find((entry) => entry.isFile());
        return candidate ? join(macOsDirectory, candidate.name) : undefined;
    }
    catch {
        return undefined;
    }
}
export async function inspectDarwinApp(appPath) {
    const frameworkPath = join(appPath, "Contents", "Frameworks", "Electron Framework.framework");
    const resourcesPath = join(appPath, "Contents", "Resources");
    const hasElectronFramework = await isDirectory(frameworkPath);
    const hasAppPayload = await pathExists(join(resourcesPath, "app.asar")) || await isDirectory(join(resourcesPath, "app"));
    if (!hasElectronFramework || !hasAppPayload)
        return undefined;
    const info = await readMacInfoPlist(appPath);
    const appDirectoryName = basename(appPath, ".app");
    const executablePath = await resolveMacExecutablePath(appPath, info.CFBundleExecutable, appDirectoryName);
    if (!executablePath)
        return undefined;
    const name = info.CFBundleDisplayName || info.CFBundleName || appDirectoryName;
    return {
        appPath,
        bundleId: info.CFBundleIdentifier || undefined,
        executablePath,
        name,
        platform: "darwin",
    };
}
async function discoverDarwinApps(locations) {
    const apps = [];
    let skippedCount = 0;
    for (const directory of locations.darwinApplicationDirectories) {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.name.endsWith(".app"))
                continue;
            const appPath = join(directory, entry.name);
            try {
                const app = await inspectDarwinApp(appPath);
                if (app)
                    apps.push(app);
            }
            catch {
                skippedCount += 1;
            }
        }
    }
    return { apps, skippedCount };
}
function unescapeDesktopValue(value) {
    return value
        .replace(/\\s/g, " ")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\");
}
function parseDesktopBoolean(value) {
    return value?.trim().toLowerCase() === "true";
}
function parseDesktopFile(text, filePath) {
    const fields = new Map();
    let inDesktopEntry = false;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#"))
            continue;
        if (line.startsWith("[") && line.endsWith("]")) {
            inDesktopEntry = line === "[Desktop Entry]";
            continue;
        }
        if (!inDesktopEntry)
            continue;
        const separatorIndex = line.indexOf("=");
        if (separatorIndex <= 0)
            continue;
        const key = line.slice(0, separatorIndex);
        const value = unescapeDesktopValue(line.slice(separatorIndex + 1));
        fields.set(key, value);
    }
    if (fields.get("Type") !== "Application")
        return undefined;
    if (parseDesktopBoolean(fields.get("NoDisplay")) || parseDesktopBoolean(fields.get("Hidden")))
        return undefined;
    const exec = fields.get("Exec")?.trim();
    if (!exec)
        return undefined;
    const desktopId = basename(filePath, ".desktop");
    return {
        comment: fields.get("Comment") || undefined,
        desktopId,
        exec,
        filePath,
        icon: fields.get("Icon") || undefined,
        name: fields.get("Name") || desktopId,
    };
}
function stripDesktopExecFieldCodes(exec) {
    const placeholder = "\u0000PERCENT\u0000";
    return exec
        .replaceAll("%%", placeholder)
        .replace(/%[A-Za-z]/g, "")
        .replaceAll(placeholder, "%");
}
function tokenizeDesktopExec(exec) {
    const tokens = [];
    let current = "";
    let quote;
    let escaped = false;
    for (const char of stripDesktopExecFieldCodes(exec)) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (escaped)
        current += "\\";
    if (current.length > 0)
        tokens.push(current);
    return tokens;
}
function stripEnvLauncher(tokens) {
    if (tokens.length === 0 || basename(tokens[0] ?? "") !== "env")
        return tokens;
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index] ?? "";
        if (token.startsWith("-")) {
            index += token === "-u" || token === "--unset" || token === "--chdir" ? 2 : 1;
            continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
            index += 1;
            continue;
        }
        break;
    }
    return tokens.slice(index);
}
async function directoryContainsChromePak(directory) {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.some((entry) => entry.isFile() && /^chrome_.*\.pak$/i.test(entry.name));
    }
    catch {
        return false;
    }
}
export async function hasLinuxElectronEvidence(executablePath) {
    const resolvedExecutablePath = await resolveRealPath(executablePath);
    if (!await isExecutableFile(resolvedExecutablePath))
        return false;
    const executableDirectory = dirname(resolvedExecutablePath);
    if (!await directoryContainsChromePak(executableDirectory))
        return false;
    const resourceBases = [executableDirectory, dirname(executableDirectory)];
    for (const base of resourceBases) {
        const resourcesDirectory = join(base, "resources");
        if (await pathExists(join(resourcesDirectory, "app.asar")) || await isDirectory(join(resourcesDirectory, "app"))) {
            return true;
        }
    }
    return false;
}
async function findExecutableInPath(command, pathEnv) {
    if (command.includes("/"))
        return undefined;
    for (const directory of pathEnv.split(":")) {
        if (directory.length === 0)
            continue;
        const candidate = join(directory, command);
        if (await isFile(candidate))
            return candidate;
    }
    return undefined;
}
function pathIsWithin(path, parent) {
    const relativePath = relative(resolve(parent), resolve(path));
    return relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
function isLikelyExecutableCandidate(path) {
    return !LINUX_NON_EXECUTABLE_CANDIDATE_EXTENSIONS.has(extname(path).toLowerCase());
}
async function findElectronBinaryUnder(root, preferredNames) {
    if (!await isDirectory(root))
        return undefined;
    const preferredNameSet = new Set(preferredNames.filter((name) => name.length > 0));
    const allFileCandidates = [];
    let visitedEntries = 0;
    async function visit(directory, depth) {
        if (depth > LINUX_ELECTRON_CANDIDATE_MAX_DEPTH || visitedEntries >= LINUX_ELECTRON_CANDIDATE_MAX_ENTRIES)
            return undefined;
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            return undefined;
        }
        for (const entry of entries) {
            visitedEntries += 1;
            if (visitedEntries > LINUX_ELECTRON_CANDIDATE_MAX_ENTRIES)
                return undefined;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                const found = await visit(path, depth + 1);
                if (found)
                    return found;
            }
            else if (entry.isFile() && isLikelyExecutableCandidate(path)) {
                if (preferredNameSet.has(entry.name) && await hasLinuxElectronEvidence(path))
                    return await resolveRealPath(path);
                allFileCandidates.push(path);
            }
        }
        return undefined;
    }
    const preferredMatch = await visit(root, 0);
    if (preferredMatch)
        return preferredMatch;
    for (const candidate of allFileCandidates) {
        if (await hasLinuxElectronEvidence(candidate))
            return await resolveRealPath(candidate);
    }
    return undefined;
}
function getSnapCandidateNames(commandName, desktopId) {
    const names = [commandName, commandName.split(".")[0] ?? "", desktopId.split(".")[0] ?? ""];
    return [...new Set(names.filter((name) => name.length > 0))];
}
async function resolveSnapExecutable(commandPath, entry, locations) {
    const commandName = basename(commandPath);
    for (const snapName of getSnapCandidateNames(commandName, entry.desktopId)) {
        const root = join(locations.snapMountDirectory, snapName, "current");
        const candidate = await findElectronBinaryUnder(root, [commandName, commandName.split(".").at(-1) ?? commandName]);
        if (candidate)
            return candidate;
    }
    return undefined;
}
function getFlatpakAppId(tokens, desktopId) {
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
        const token = tokens[index] ?? "";
        if (!token.startsWith("-") && token.includes(".") && token !== "flatpak")
            return token;
    }
    return desktopId;
}
function getFlatpakCommandName(tokens) {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? "";
        if (token.startsWith("--command="))
            return token.slice("--command=".length);
        if (token === "--command")
            return tokens[index + 1];
    }
    return undefined;
}
function getFlatpakRoots(entry, locations) {
    const userExportDirectory = join(locations.homeDir, ".local", "share", "flatpak", "exports", "share", "applications");
    const systemExportDirectory = "/var/lib/flatpak/exports/share/applications";
    if (pathIsWithin(entry.filePath, userExportDirectory)) {
        return [locations.flatpakUserAppDirectory, locations.flatpakSystemAppDirectory];
    }
    if (pathIsWithin(entry.filePath, systemExportDirectory)) {
        return [locations.flatpakSystemAppDirectory, locations.flatpakUserAppDirectory];
    }
    return [locations.flatpakUserAppDirectory, locations.flatpakSystemAppDirectory];
}
async function resolveFlatpakExecutable(tokens, entry, locations) {
    const appId = getFlatpakAppId(tokens, entry.desktopId);
    const commandName = getFlatpakCommandName(tokens);
    const preferredNames = commandName ? [commandName] : [];
    for (const root of getFlatpakRoots(entry, locations)) {
        const filesRoot = join(root, appId, "current", "active", "files");
        const candidate = await findElectronBinaryUnder(filesRoot, preferredNames);
        if (candidate)
            return candidate;
    }
    return undefined;
}
async function resolveLinuxExecutable(entry, locations) {
    const tokens = stripEnvLauncher(tokenizeDesktopExec(entry.exec));
    const executableToken = tokens[0];
    if (!executableToken)
        return undefined;
    if (basename(executableToken) === "flatpak") {
        const executablePath = await resolveFlatpakExecutable(tokens, entry, locations);
        return executablePath ? { executablePath, packageSource: "flatpak" } : undefined;
    }
    let executablePath = executableToken;
    if (!isAbsolute(executablePath)) {
        const pathExecutable = await findExecutableInPath(executablePath, locations.pathEnv);
        if (!pathExecutable)
            return undefined;
        executablePath = pathExecutable;
    }
    if (pathIsWithin(executablePath, locations.snapBinDirectory)) {
        const snapExecutable = await resolveSnapExecutable(executablePath, entry, locations);
        return snapExecutable ? { executablePath: snapExecutable, packageSource: "snap" } : undefined;
    }
    return { executablePath: await resolveRealPath(executablePath), packageSource: "desktop" };
}
async function inspectLinuxDesktopFile(filePath, locations) {
    let text;
    try {
        text = await readFile(filePath, "utf8");
    }
    catch {
        return undefined;
    }
    const entry = parseDesktopFile(text, filePath);
    if (!entry)
        return undefined;
    const resolution = await resolveLinuxExecutable(entry, locations);
    if (!resolution)
        return undefined;
    if (!await hasLinuxElectronEvidence(resolution.executablePath))
        return undefined;
    return {
        comment: entry.comment,
        desktopId: entry.desktopId,
        executablePath: resolution.executablePath,
        icon: entry.icon,
        name: entry.name,
        packageSource: resolution.packageSource,
        platform: "linux",
    };
}
async function discoverLinuxApps(locations) {
    const apps = [];
    let skippedCount = 0;
    for (const directory of locations.linuxDesktopDirectories) {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isFile() || extname(entry.name) !== ".desktop")
                continue;
            try {
                const app = await inspectLinuxDesktopFile(join(directory, entry.name), locations);
                if (app)
                    apps.push(app);
            }
            catch {
                skippedCount += 1;
            }
        }
    }
    return { apps, skippedCount };
}
function appMatchesQuery(app, query) {
    if (!query)
        return true;
    const normalizedQuery = query.toLowerCase();
    const searchableValues = [app.name, app.bundleId, app.appPath, app.executablePath, app.comment, app.desktopId, app.icon, app.packageSource]
        .filter((value) => typeof value === "string" && value.length > 0)
        .map((value) => value.toLowerCase());
    return searchableValues.some((value) => value.includes(normalizedQuery));
}
function dedupeApps(apps) {
    const seen = new Set();
    const deduped = [];
    for (const app of apps) {
        const key = app.appPath ?? app.executablePath;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(app);
    }
    return deduped;
}
function sortApps(apps) {
    return [...apps].sort((left, right) => {
        const nameComparison = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        return nameComparison === 0 ? left.executablePath.localeCompare(right.executablePath) : nameComparison;
    });
}
function findMacAppBundleAncestor(path) {
    const parts = resolve(path).split(/[\\/]+/);
    const appIndex = parts.findIndex((part) => part.endsWith(".app"));
    return appIndex >= 0 ? parts.slice(0, appIndex + 1).join("/") || "/" : undefined;
}
async function inspectWin32Executable(executablePath) {
    const resolvedExecutablePath = await resolveRealPath(executablePath);
    if (!await isExecutableFile(resolvedExecutablePath))
        return undefined;
    const executableDirectory = dirname(resolvedExecutablePath);
    const resourcesDirectory = join(executableDirectory, "resources");
    const hasAppPayload = await pathExists(join(resourcesDirectory, "app.asar")) || await isDirectory(join(resourcesDirectory, "app"));
    const hasPak = await directoryContainsChromePak(executableDirectory) || await pathExists(join(executableDirectory, "resources.pak"));
    if (!hasAppPayload || !hasPak)
        return undefined;
    return {
        executablePath: resolvedExecutablePath,
        name: basename(resolvedExecutablePath, extname(resolvedExecutablePath)),
        platform: "win32",
    };
}
export async function inspectElectronExecutablePath(executablePath, platform = process.platform) {
    const resolvedExecutablePath = await resolveRealPath(executablePath);
    if (platform === "darwin") {
        const appPath = findMacAppBundleAncestor(resolvedExecutablePath);
        return appPath ? inspectDarwinApp(appPath) : undefined;
    }
    if (platform === "linux") {
        if (!await hasLinuxElectronEvidence(resolvedExecutablePath))
            return undefined;
        return {
            executablePath: resolvedExecutablePath,
            name: basename(resolvedExecutablePath),
            platform: "linux",
        };
    }
    if (platform === "win32") {
        return inspectWin32Executable(resolvedExecutablePath);
    }
    return undefined;
}
export async function inspectElectronAppPath(appPath, platform = process.platform) {
    if (platform === "darwin" || appPath.endsWith(".app")) {
        return inspectDarwinApp(appPath);
    }
    return inspectElectronExecutablePath(appPath, platform);
}
export async function discoverElectronApps(options = {}) {
    const platform = options.platform ?? process.platform;
    const query = options.query?.trim() || undefined;
    const maxResults = normalizeMaxResults(options.maxResults);
    const locations = resolveLocations(options.locations);
    let discovered;
    if (platform === "darwin") {
        discovered = await discoverDarwinApps(locations);
    }
    else if (platform === "linux") {
        discovered = await discoverLinuxApps(locations);
    }
    else {
        return { apps: [], maxResults, omittedCount: 0, platform: "unsupported", query };
    }
    const filteredApps = sortApps(dedupeApps(discovered.apps.map(annotateElectronAppSensitivity).filter((app) => appMatchesQuery(app, query))));
    const apps = filteredApps.slice(0, maxResults);
    return {
        apps,
        maxResults,
        omittedCount: Math.max(0, filteredApps.length - apps.length),
        platform,
        query,
        skippedCount: discovered.skippedCount || undefined,
    };
}
