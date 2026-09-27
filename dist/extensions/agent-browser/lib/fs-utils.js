import { access, stat } from "node:fs/promises";
export async function pathExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
export async function directoryExists(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
