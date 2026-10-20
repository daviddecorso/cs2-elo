/** Null when the file hasn't been generated: a 404, or the HTML page Vite's dev server returns for a missing file. */
export const fetchSimJson = async <T>(file: string): Promise<T | null> => {
    const res = await fetch(`${import.meta.env.BASE_URL}data/sim/${file}`);
    if (res.status === 404 || !res.headers.get("content-type")?.includes("json")) return null;
    if (!res.ok) throw new Error(`Failed to load ${file}: HTTP ${res.status}`);
    return res.json();
};
