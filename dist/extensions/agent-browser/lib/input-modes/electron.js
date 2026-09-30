import { unwrapItemEnvelopeDeep } from "./shared.js";

import { isRecord } from "../parsing.js";
import { AGENT_BROWSER_ELECTRON_ACTIONS, AGENT_BROWSER_ELECTRON_HANDOFFS, AGENT_BROWSER_ELECTRON_LIST_FIELDS, AGENT_BROWSER_ELECTRON_PROBE_FIELDS, AGENT_BROWSER_ELECTRON_RESERVED_APP_ARGS, AGENT_BROWSER_ELECTRON_TARGET_TYPES, } from "./types.js";
function validateOptionalNonEmptyString(input, fieldName) {
    const value = input[fieldName];
    if (value === undefined)
        return {};
    if (typeof value !== "string" || value.trim().length === 0) {
        return { error: `electron.${fieldName} must be a non-empty string when provided.` };
    }
    return { value: value.trim() };
}
function validateOptionalElectronStringArray(input, fieldName) {
    // Caller-supplied array parameter, refused by the host for the same reason as the other four
    // sites. The wave23 comment claimed electron was healed while this file never imported the
    // helper — a comment asserting a fix that did not exist. Correcting the code is not enough; the
    // comment and the test that repeated the claim are corrected too.
    const value = unwrapItemEnvelopeDeep(input[fieldName]);
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
        return `electron.${fieldName} must be an array of non-empty strings when provided.`;
    }
    return undefined;
}
function validateOptionalElectronEnum(input, fieldName, values) {
    const value = input[fieldName];
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !values.includes(value)) {
        return `electron.${fieldName} must be one of: ${values.join(", ")}.`;
    }
    return undefined;
}
function getReservedElectronAppArg(appArgs) {
    return appArgs?.find((arg) => {
        const trimmed = arg.trim();
        return trimmed === "--" || AGENT_BROWSER_ELECTRON_RESERVED_APP_ARGS.some((reserved) => trimmed === reserved || trimmed.startsWith(`${reserved}=`));
    });
}
function validateElectronLaunchAppArgs(appArgs) {
    const reservedArg = getReservedElectronAppArg(appArgs);
    return reservedArg
        ? `electron.appArgs must not include wrapper-owned launch flag ${reservedArg}.`
        : undefined;
}
function validateOptionalElectronPositiveInteger(input, fieldName) {
    const value = input[fieldName];
    if (value === undefined)
        return {};
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return { error: `electron.${fieldName} must be a positive integer when provided.` };
    }
    return { value };
}
function onlyAllowedElectronFields(input, action, allowedFields) {
    return Object.keys(input).find((fieldName) => !allowedFields.has(fieldName))
        ? `electron.${action} does not support electron.${Object.keys(input).find((fieldName) => !allowedFields.has(fieldName))}.`
        : undefined;
}
export function compileAgentBrowserElectron(input) {
    if (!isRecord(input))
        return { error: "electron must be an object." };
    const action = input.action;
    if (typeof action !== "string" || !AGENT_BROWSER_ELECTRON_ACTIONS.includes(action)) {
        return { error: `electron.action must be one of: ${AGENT_BROWSER_ELECTRON_ACTIONS.join(", ")}.` };
    }
    for (const fieldName of ["query", "appPath", "appName", "bundleId", "executablePath", "launchId"]) {
        const validation = validateOptionalNonEmptyString(input, fieldName);
        if (validation.error)
            return { error: validation.error };
    }
    for (const fieldName of ["appArgs", "allow", "deny"]) {
        const error = validateOptionalElectronStringArray(input, fieldName);
        if (error)
            return { error };
    }
    const handoffError = validateOptionalElectronEnum(input, "handoff", AGENT_BROWSER_ELECTRON_HANDOFFS);
    if (handoffError)
        return { error: handoffError };
    const targetTypeError = validateOptionalElectronEnum(input, "targetType", AGENT_BROWSER_ELECTRON_TARGET_TYPES);
    if (targetTypeError)
        return { error: targetTypeError };
    for (const fieldName of ["maxResults", "timeoutMs"]) {
        const validation = validateOptionalElectronPositiveInteger(input, fieldName);
        if (validation.error)
            return { error: validation.error };
    }
    if (input.all !== undefined && input.all !== true) {
        return { error: "electron.all must be true when provided." };
    }
    if (action === "list") {
        const unsupportedListField = Object.keys(input).find((fieldName) => !AGENT_BROWSER_ELECTRON_LIST_FIELDS.has(fieldName));
        if (unsupportedListField) {
            return { error: `electron.list only supports query and maxResults; remove electron.${unsupportedListField}.` };
        }
        return {
            compiled: {
                action: "list",
                maxResults: validateOptionalElectronPositiveInteger(input, "maxResults").value,
                query: validateOptionalNonEmptyString(input, "query").value,
            },
        };
    }
    if (action === "probe") {
        const unsupportedProbeField = Object.keys(input).find((fieldName) => !AGENT_BROWSER_ELECTRON_PROBE_FIELDS.has(fieldName));
        if (unsupportedProbeField) {
            return { error: `electron.probe only supports action, launchId, and timeoutMs; remove electron.${unsupportedProbeField}.` };
        }
        const launchId = validateOptionalNonEmptyString(input, "launchId").value;
        const timeoutMs = validateOptionalElectronPositiveInteger(input, "timeoutMs").value;
        return {
            compiled: {
                action: "probe",
                ...(launchId ? { launchId } : {}),
                ...(timeoutMs ? { timeoutMs } : {}),
            },
        };
    }
    if (action === "launch") {
        const allowedFields = new Set(["action", "allow", "appArgs", "appName", "appPath", "bundleId", "deny", "executablePath", "handoff", "targetType", "timeoutMs"]);
        const unsupportedFieldError = onlyAllowedElectronFields(input, action, allowedFields);
        if (unsupportedFieldError)
            return { error: unsupportedFieldError };
        const appArgs = input.appArgs?.map((item) => item.trim());
        const appArgsError = validateElectronLaunchAppArgs(appArgs);
        if (appArgsError)
            return { error: appArgsError };
        const targetFields = ["appPath", "appName", "bundleId", "executablePath"];
        const providedTargets = targetFields.filter((fieldName) => input[fieldName] !== undefined);
        if (providedTargets.length !== 1) {
            return { error: "electron.launch requires exactly one of appPath, appName, bundleId, or executablePath." };
        }
        return {
            compiled: {
                action: "launch",
                allow: input.allow?.map((item) => item.trim()),
                appArgs,
                deny: input.deny?.map((item) => item.trim()),
                appName: validateOptionalNonEmptyString(input, "appName").value,
                appPath: validateOptionalNonEmptyString(input, "appPath").value,
                bundleId: validateOptionalNonEmptyString(input, "bundleId").value,
                executablePath: validateOptionalNonEmptyString(input, "executablePath").value,
                handoff: input.handoff ?? "snapshot",
                targetType: input.targetType ?? "page",
                timeoutMs: validateOptionalElectronPositiveInteger(input, "timeoutMs").value,
            },
        };
    }
    const allowedFields = new Set(["action", "all", "launchId", "timeoutMs"]);
    const unsupportedFieldError = onlyAllowedElectronFields(input, action, allowedFields);
    if (unsupportedFieldError)
        return { error: unsupportedFieldError };
    if (input.all === true && input.launchId !== undefined) {
        return { error: `electron.${action} accepts launchId or all, not both.` };
    }
    return {
        compiled: {
            action: action,
            all: input.all === true || undefined,
            launchId: validateOptionalNonEmptyString(input, "launchId").value,
            timeoutMs: validateOptionalElectronPositiveInteger(input, "timeoutMs").value,
        },
    };
}
