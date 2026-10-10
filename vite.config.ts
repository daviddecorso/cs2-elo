import { cpSync, existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const base = "/cs2/";
const siteRoot = "dist";

export function siteFiles(): Plugin {
    return {
        name: "site-files",
        apply: "build",
        writeBundle() {
            if (existsSync("site")) {
                cpSync("site", siteRoot, { recursive: true });
            }
        },
    };
}

export default defineConfig(() => ({
    base,
    build: { outDir: `${siteRoot}${base}` },
    plugins: [
        react(),
        tailwindcss(),
        siteFiles(),
    ],
}));
