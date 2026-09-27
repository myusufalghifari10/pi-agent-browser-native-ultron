import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionCommandData } from "./session-state.js";

const GEOLOCATION_STUB_PATH = join(tmpdir(), "piab-geolocation-init-script.js");

export function getGeolocationOperands(commandTokens) {
    if (!Array.isArray(commandTokens) || commandTokens.length !== 4)
        return undefined;
    if (commandTokens[0] !== "set")
        return undefined;
    if (commandTokens[1] !== "geo" && commandTokens[1] !== "geolocation")
        return undefined;
    const latitude = Number(commandTokens[2]);
    const longitude = Number(commandTokens[3]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return undefined;
    return { latitude, longitude };
}

export function buildGeolocationStubSource({ latitude, longitude }) {
    return `(() => {
  const coords = ${JSON.stringify({ accuracy: 1, altitude: null, altitudeAccuracy: null, heading: null, latitude, longitude, speed: null })};
  const position = () => ({ coords: { ...coords }, timestamp: Date.now() });
  const deliver = (callback) => { setTimeout(() => callback(position()), 0); };
  const stub = {
    clearWatch: () => {},
    getCurrentPosition: (success, error) => {
      if (typeof success === "function") deliver(success);
      else if (typeof error === "function") setTimeout(() => error({ code: 1, message: "geolocation is unavailable" }), 0);
    },
    watchPosition: (success) => { if (typeof success === "function") deliver(success); return 1; },
  };
  try { Object.defineProperty(navigator, "geolocation", { configurable: true, value: stub }); }
  catch { try { navigator.geolocation = stub; } catch {} }
  try {
    const queryPermissions = navigator.permissions?.query?.bind(navigator.permissions);
    if (queryPermissions) {
      navigator.permissions.query = (descriptor) => descriptor?.name === "geolocation"
        ? Promise.resolve({ name: "geolocation", onchange: null, state: "granted" })
        : queryPermissions(descriptor);
    }
  }
  catch {}
  return true;
})()`;
}

// local patch: upstream 0.37.0 `set geo` succeeds and installs the device-geolocation override, but it never
// grants the geolocation permission, so pages always receive "User denied Geolocation"
// (`navigator.permissions.query({name:"geolocation"})` reports `denied`) and the documented emulation is
// invisible to the page. The wrapper installs a page-level stub in the active document so the requested
// coordinates are actually readable, and writes an init-script file for the documented way to keep
// geolocation working after a navigation (`--init-script` + `sessionMode: "fresh"`; there is no runtime
// add-initscript command upstream).
export async function collectGeolocationStubNote(options) {
    const operands = getGeolocationOperands(options.commandTokens);
    if (!operands || typeof options.sessionName !== "string" || options.sessionName.length === 0)
        return undefined;
    const source = buildGeolocationStubSource(operands);
    let initScriptPath;
    try {
        await writeFile(GEOLOCATION_STUB_PATH, `${source};\n`, { mode: 0o600 });
        initScriptPath = GEOLOCATION_STUB_PATH;
    }
    catch {
        initScriptPath = undefined;
    }
    const applied = await runSessionCommandData({
        args: ["eval", "--stdin"],
        cwd: options.cwd,
        namespace: options.namespace,
        sessionName: options.sessionName,
        signal: options.signal,
        stdin: source,
    }).catch(() => undefined);
    const header = "Set geo compatibility: agent-browser 0.37.0 installs the geolocation override but never grants the geolocation permission, so the page itself still receives `User denied Geolocation`.";
    const appliedText = applied === undefined
        ? " The wrapper could not install its page-level `navigator.geolocation` stub in the active document; treat these coordinates as visible to the CLI only."
        : " The wrapper installed a page-level `navigator.geolocation` stub in the active document, so the page now reads these coordinates.";
    const recipeText = initScriptPath
        ? ` To keep geolocation working after a navigation, relaunch with \`sessionMode: "fresh"\` and \`--init-script ${initScriptPath}\` (stub written for ${operands.latitude}, ${operands.longitude}).`
        : "";
    return `${header}${appliedText}${recipeText}`;
}
