import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import { writeSecureTempFile } from "./temp.js";
const isolatedAgentBrowserEnvironment = new AsyncLocalStorage();
const agentBrowserProcessEnvironment = new AsyncLocalStorage();
const PROXY_ENV_NAMES = new Set(["ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]);
export function getAgentBrowserProcessEnvironment(baseEnv = process.env) {
    const isolatedConfig = isolatedAgentBrowserEnvironment.getStore();
    if (isolatedConfig === undefined)
        return { ...baseEnv, ...agentBrowserProcessEnvironment.getStore() };
    return {
        ...Object.fromEntries(Object.entries(baseEnv).filter(([name]) => {
            const normalizedName = name.toUpperCase();
            return !normalizedName.startsWith("AGENT_BROWSER_") && !PROXY_ENV_NAMES.has(normalizedName);
        })),
        AGENT_BROWSER_CONFIG: isolatedConfig,
    };
}
export function withAgentBrowserProcessEnvironment(env, run) {
    return agentBrowserProcessEnvironment.run({ ...agentBrowserProcessEnvironment.getStore(), ...env }, run);
}
export async function withIsolatedAgentBrowserEnvironment(run) {
    if (isolatedAgentBrowserEnvironment.getStore() !== undefined)
        return await run();
    const path = await writeSecureTempFile({ content: "{}", prefix: "script-config", suffix: ".json" });
    try {
        return await isolatedAgentBrowserEnvironment.run(path, run);
    }
    finally {
        await rm(path, { force: true });
    }
}
