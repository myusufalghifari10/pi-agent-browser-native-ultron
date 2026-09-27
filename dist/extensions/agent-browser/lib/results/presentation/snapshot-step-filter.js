// local patch: batch snapshot steps silently ignored the wrapper-only snapshot filter flags
// (--search / --filter). The top-level path handles them in
// lib/orchestration/browser-run/prepare/snapshot-filter.js; batch step presentation did not, so the
// flags reached upstream (which ignores them) and the unfiltered tree was rendered with no hint.
//
// ponytail: this mirrors the pure part of that filter (~25 lines) instead of importing the
// orchestration module, which would pull the orchestration layer into presentation and risk a
// circular import. Keep both copies in sync if upstream filter semantics change.
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function parseSnapshotStepFilter(commandTokens) {
    if (!Array.isArray(commandTokens) || commandTokens[0] !== "snapshot")
        return undefined;
    let role;
    let search;
    for (let index = 0; index < commandTokens.length; index += 1) {
        const token = commandTokens[index];
        if (token === "--search") {
            const value = commandTokens[index + 1];
            if (typeof value === "string" && !value.startsWith("-")) {
                search = value;
                index += 1;
            }
            continue;
        }
        if (token === "--filter") {
            const value = commandTokens[index + 1];
            if (typeof value === "string" && !value.startsWith("-")) {
                const roleMatch = /^role=(.+)$/i.exec(value.trim());
                if (roleMatch?.[1])
                    role = roleMatch[1].trim().toLowerCase();
                index += 1;
            }
        }
    }
    if (!role && !search)
        return undefined;
    return { role, search };
}
export function applySnapshotStepFilter(data, request) {
    if (!isRecord(data))
        return undefined;
    const refs = isRecord(data.refs) ? data.refs : {};
    const snapshot = typeof data.snapshot === "string" ? data.snapshot : "";
    const normalizedSearch = request.search?.trim().toLowerCase();
    const matchingRefIds = new Set();
    for (const [refId, refValue] of Object.entries(refs)) {
        if (!isRecord(refValue))
            continue;
        const role = typeof refValue.role === "string" ? refValue.role.toLowerCase() : "";
        const name = typeof refValue.name === "string" ? refValue.name : "";
        const roleMatches = request.role ? role === request.role : true;
        const searchMatches = normalizedSearch ? `${role} ${name}`.toLowerCase().includes(normalizedSearch) : true;
        if (roleMatches && searchMatches)
            matchingRefIds.add(refId);
    }
    const lines = snapshot.split(/\r?\n/);
    const visibleLines = lines.filter((line) => {
        const normalizedLine = line.toLowerCase();
        if (normalizedSearch && normalizedLine.includes(normalizedSearch))
            return true;
        return [...matchingRefIds].some((refId) => line.includes(`[ref=${refId}]`) || line.includes(`ref=${refId}`));
    });
    const filteredRefs = Object.fromEntries(Object.entries(refs).filter(([refId]) => matchingRefIds.has(refId)));
    return {
        data: {
            ...data,
            refs: filteredRefs,
            snapshot: visibleLines.length > 0 ? visibleLines.join("\n") : "(no snapshot lines matched the batch snapshot filter)",
        },
        matchedRefs: Object.keys(filteredRefs).length,
        role: request.role,
        search: request.search,
        totalLines: lines.filter((line) => line.length > 0).length,
        totalRefs: Object.keys(refs).length,
        visibleLines: visibleLines.length,
    };
}
export function formatSnapshotStepFilterSummary(filtered, request) {
    const matched = `${filtered.matchedRefs}/${filtered.totalRefs} direct refs matched${request.role ? ` role=${request.role}` : ""}${request.search ? ` search ${JSON.stringify(request.search)}` : ""}`;
    const surrounding = `${filtered.visibleLines} surrounding snapshot line${filtered.visibleLines === 1 ? "" : "s"} shown`;
    return `Snapshot filter: ${matched}; ${surrounding}.`;
}
