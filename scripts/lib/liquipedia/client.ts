import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LiquipediaQueryOptions {
    wiki?: string;
    conditions?: string;
    query?: string;
    limit?: number;
    offset?: number;
    order?: string;
    groupby?: string;
    rawstreams?: boolean;
    streamurls?: boolean;
    useCache?: boolean;
    cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface LiquipediaResponse<T> {
    result?: T[];
    error?: string[];
    warning?: string[];
}

const ensureEnvLoaded = (): void => {
    if (!process.env.LIQUIPEDIA_API_KEY) {
        if (typeof process.loadEnvFile === "function" && fs.existsSync(".env")) {
            try {
                process.loadEnvFile();
            } catch {
                // Ignore missing or malformed .env
            }
        }
    }
};

const getApiKey = (): string => {
    ensureEnvLoaded();
    const key = process.env.LIQUIPEDIA_API_KEY;
    if (!key) {
        throw new Error(
            "LIQUIPEDIA_API_KEY environment variable is missing. It must be set in .env or the environment."
        );
    }
    return key;
};

const CACHE_DIR = path.resolve(process.cwd(), ".cache/liquipedia");

const getCacheKey = (endpoint: string, params: Record<string, string>): string => {
    const sorted = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
    const raw = `${endpoint}?${new URLSearchParams(sorted).toString()}`;
    return crypto.createHash("sha256").update(raw).digest("hex");
};


export const fetchLiquipediaPage = async <T = Record<string, unknown>>(
    endpoint: string,
    params: Record<string, string>,
    useCache = true,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS
): Promise<T[]> => {
    const apiKey = getApiKey();

    if (useCache) {
        const cacheKey = getCacheKey(endpoint, params);
        const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
        if (fs.existsSync(cachePath)) {
            try {
                const stat = fs.statSync(cachePath);
                if (Date.now() - stat.mtimeMs < cacheTtlMs) {
                    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as T[];
                    return cached;
                }
            } catch {
                // If cache corrupted or expired, continue to fetch
            }
        }
    }

    const queryUrl = new URL(`https://api.liquipedia.net/api/v3/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
        queryUrl.searchParams.set(k, v);
    }

    const response = await fetch(queryUrl.toString(), {
        method: "GET",
        headers: {
            Authorization: `Apikey ${apiKey}`,
            "User-Agent": "cs2-elo (github.com/daviddecorso/cs2-elo)",
            "Accept-Encoding": "gzip",
        },
    });

    // Liquipedia's error bodies echo the API key.
    const redact = (text: string) => text.replaceAll(apiKey, "[redacted]");

    // Limits are hourly per table and retries count against them, so a 429 fails immediately.
    if (response.status === 429) {
        throw new Error(`Liquipedia API rate limited (429) on /${endpoint}; wait for the hourly limit to reset`);
    }

    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Liquipedia API error: status ${response.status} ${response.statusText}: ${redact(body)}`
        );
    }

    const data = (await response.json()) as LiquipediaResponse<T>;
    if (data.error && data.error.length > 0) {
        throw new Error(`Liquipedia API returned error: ${redact(data.error.join(", "))}`);
    }

    const result = data.result ?? [];

    if (useCache) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const cacheKey = getCacheKey(endpoint, params);
        const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
        fs.writeFileSync(cachePath, JSON.stringify(result), "utf8");
    }

    return result;
};

export const getRowDedupeKey = (row: Record<string, unknown>): string => {
    if (row.match2id) {
        return `${row.pagename ?? ""}:${row.match2id}`;
    }
    if (row.objectname) {
        return `${row.pagename ?? ""}:${row.objectname}`;
    }
    if (row.pageid) {
        return `${row.pageid}`;
    }
    if (row.pagename) {
        return `${row.pagename}`;
    }
    return JSON.stringify(row);
};

export const fetchLiquipediaAll = async <T = Record<string, unknown>>(
    endpoint: string,
    options: LiquipediaQueryOptions = {}
): Promise<T[]> => {
    const wiki = options.wiki ?? "counterstrike";
    const pageSize = options.limit ?? 500;
    let offset = options.offset ?? 0;
    const useCache = options.useCache ?? true;

    const baseParams: Record<string, string> = {
        wiki,
        limit: String(pageSize),
    };

    if (options.conditions) baseParams.conditions = options.conditions;
    if (options.query) baseParams.query = options.query;
    if (options.order) baseParams.order = options.order;
    if (options.groupby) baseParams.groupby = options.groupby;
    if (options.rawstreams !== undefined) baseParams.rawstreams = String(options.rawstreams);
    if (options.streamurls !== undefined) baseParams.streamurls = String(options.streamurls);

    const rows: T[] = [];
    const seenKeys = new Set<string>();

    while (true) {
        const pageParams = { ...baseParams, offset: String(offset) };
        const pageRows = await fetchLiquipediaPage<T>(
            endpoint,
            pageParams,
            useCache,
            options.cacheTtlMs
        );

        let newRowsCount = 0;
        for (const row of pageRows) {
            const key = getRowDedupeKey(row as Record<string, unknown>);
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                rows.push(row);
                newRowsCount++;
            }
        }

        if (pageRows.length < pageSize || newRowsCount === 0) {
            break;
        }

        offset += pageSize;
    }

    return rows;
};
