const STORAGE_KEY = "theme";

const storedTheme = () => {
    try {
        return localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
};

export const isDarkTheme = () => {
    const stored = storedTheme();
    if (stored === "dark" || stored === "light") return stored === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
};

export const applyTheme = (dark = isDarkTheme()) => {
    document.documentElement.classList.toggle("dark", dark);
};

export type ThemeChoice = "system" | "light" | "dark";

export const getThemeChoice = (): ThemeChoice => {
    const stored = storedTheme();
    if (stored === "dark" || stored === "light") return stored;
    return "system";
};

export const setTheme = (choice: ThemeChoice) => {
    if (choice === "system") {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            // storage unavailable
        }
        applyTheme();
    } else {
        saveTheme(choice === "dark");
    }
};

export const saveTheme = (dark: boolean) => {
    applyTheme(dark);
    try {
        localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
    } catch {
        // storage unavailable; the choice lasts for this page only
    }
};
