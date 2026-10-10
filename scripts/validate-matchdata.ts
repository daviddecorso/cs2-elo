import fs from "node:fs";
import path from "node:path";
import { validateMatchdata } from "./lib/vrs/matchdataSchema.ts";

const targetPath = process.argv[2];
if (!targetPath) {
    console.error("Usage: vite-node scripts/validate-matchdata.ts <path/to/matchdata.json>");
    process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), targetPath);
if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(1);
}

const raw = fs.readFileSync(resolvedPath, "utf8");
let data: unknown;
try {
    data = JSON.parse(raw);
} catch (err) {
    console.error(`Failed to parse JSON: ${String(err)}`);
    process.exit(1);
}

const { errors, warnings } = validateMatchdata(data);

if (warnings.length > 0) {
    console.warn(`Warnings (${warnings.length}):`);
    for (const w of warnings) {
        console.warn(`  - ${w}`);
    }
}

if (errors.length > 0) {
    console.error(`Errors (${errors.length}):`);
    for (const e of errors) {
        console.error(`  - ${e}`);
    }
    process.exit(1);
}

console.log(`Validation passed: ${targetPath} has 0 errors.`);
process.exit(0);
