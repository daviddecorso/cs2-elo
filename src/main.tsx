import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import App from "./App.tsx";
import { reloadOnStaleChunk } from "./utils/reloadOnStaleChunk.ts";
import { applyTheme } from "./utils/theme.ts";

reloadOnStaleChunk();
applyTheme();

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>
);
