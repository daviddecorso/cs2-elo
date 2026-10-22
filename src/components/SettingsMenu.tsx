import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Label, Segmented } from "./ui.tsx";
import { useOutsidePress } from "../hooks/useOutsidePress.ts";
import { getThemeChoice, setTheme, type ThemeChoice } from "../utils/theme.ts";

export function SettingsMenu() {
    const [open, setOpen] = useState(false);
    const [themeChoice, setThemeChoice] = useState<ThemeChoice>(getThemeChoice);
    const ref = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useOutsidePress(ref, open, close);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && close();
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [open, close]);

    return (
        <div ref={ref} className="relative">
            <Button
                variant="ghost"
                size="icon"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-haspopup="true"
                aria-label="Settings"
                title="Settings"
            >
                <svg
                    className={`w-4 h-4 ${open ? "text-accent" : "text-fg"}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
            </Button>
            {open && (
                <div
                    role="dialog"
                    aria-label="Settings"
                    className="absolute right-0 top-full mt-2 w-60 bg-surface border border-line rounded-sm shadow-lg p-3 space-y-3 font-mono z-50"
                >
                    <div className="space-y-1">
                        <Label>Theme</Label>
                        <Segmented
                            options={[
                                { value: "system", label: "System" },
                                { value: "light", label: "Light" },
                                { value: "dark", label: "Dark" },
                            ]}
                            value={themeChoice}
                            onChange={(v) => {
                                const choice = v as ThemeChoice;
                                setTheme(choice);
                                setThemeChoice(choice);
                            }}
                            className="w-full [&>button]:flex-1"
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
