const LAST_RELOAD_KEY = "stale-chunk-reload-at";
const RELOAD_COOLDOWN_MS = 10_000;

export const reloadOnStaleChunk = () => {
    window.addEventListener("vite:preloadError", () => {
        try {
            const lastReload = Number(sessionStorage.getItem(LAST_RELOAD_KEY));
            if (Date.now() - lastReload < RELOAD_COOLDOWN_MS) return;
            sessionStorage.setItem(LAST_RELOAD_KEY, String(Date.now()));
        } catch {
            return;
        }
        window.location.reload();
    });
};
