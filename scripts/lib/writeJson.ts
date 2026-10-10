import fs from "node:fs";
import path from "node:path";

const withoutTimestamp = (json: string) => {
    const data = JSON.parse(json) as { generatedAt?: unknown };
    delete data.generatedAt;
    return JSON.stringify(data);
};

/** Skips a write that would change only `generatedAt`, so CI doesn't commit, deploy, and bust browser caches for nothing. */
export const writeJsonIfChanged = (file: string, json: string): boolean => {
    if (fs.existsSync(file) && withoutTimestamp(fs.readFileSync(file, "utf8")) === withoutTimestamp(json)) {
        return false;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, json);
    return true;
};

/** `writeJsonIfChanged` plus a one-line log; `detail` describes what was written. */
export const saveJson = (file: string, json: string, detail = "") => {
    const written = writeJsonIfChanged(file, json);
    const name = path.relative(process.cwd(), file);
    console.log(written ? `Wrote ${name}${detail && `: ${detail}`}` : `Unchanged ${name}`);
    return written;
};
