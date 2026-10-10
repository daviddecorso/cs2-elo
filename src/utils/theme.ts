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

export const saveTheme = (dark: boolean) => {
    applyTheme(dark);
    try {
        localStorage.setItem(STORAGE_KEY, dark ? "dark" : "light");
    } catch {
        // storage unavailable; the choice lasts for this page only
    }
};
