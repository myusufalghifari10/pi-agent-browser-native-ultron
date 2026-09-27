import { isAbsolute, resolve } from "node:path";
import { isCloseCommand } from "../../command-taxonomy.js";
import { executableExistsOnPath } from "../../executable-path.js";
function resolveArtifactPath(cwd, path) {
    return isAbsolute(path) ? path : resolve(cwd, path);
}
function manifestContainsArtifact(manifest, cwd, artifact) {
    if (!manifest)
        return false;
    const requestedAbsolutePath = resolveArtifactPath(cwd, artifact.path);
    const expectedKind = artifact.kind === "screenshot" ? "image" : "video";
    return manifest.entries.some((entry) => {
        const entryAbsolutePath = entry.absolutePath ?? resolveArtifactPath(cwd, entry.path);
        return entry.storageScope === "explicit-path" && entry.kind === expectedKind && entryAbsolutePath === requestedAbsolutePath && entry.retentionState === "live" && entry.exists === true;
    });
}
async function isArtifactRequired(artifact) {
    if (artifact.required)
        return true;
    return artifact.kind === "recording" && await executableExistsOnPath("ffmpeg");
}
export async function findRequestedArtifactCloseViolation(options) {
    if (!isCloseCommand(options.command))
        return undefined;
    const missingArtifacts = [];
    for (const artifact of options.promptPolicy.requestedArtifacts) {
        if (!await isArtifactRequired(artifact))
            continue;
        if (!manifestContainsArtifact(options.artifactManifest, options.cwd, artifact))
            missingArtifacts.push(artifact);
    }
    if (missingArtifacts.length === 0)
        return undefined;
    const missingList = missingArtifacts.map((artifact) => `${artifact.kind}: ${artifact.path}`).join(", ");
    return {
        message: `Blocked browser close because requested artifact path${missingArtifacts.length === 1 ? " is" : "s are"} missing or unverified: ${missingList}. Save the requested artifact path first, or report why an optional artifact is unavailable before closing.`,
        missingArtifacts,
        reason: "requested-artifacts-missing-before-close",
    };
}
