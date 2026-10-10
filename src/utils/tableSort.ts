export interface SortState<K extends string> {
    key: K;
    reversed: boolean;
}

/** Reads `sort` and `rev` from the query string; `keys[0]` is the default column. */
export const readSort = <K extends string>(
    params: URLSearchParams,
    keys: readonly K[]
): SortState<K> => {
    const key = params.get("sort") as K | null;
    return {
        key: key !== null && keys.includes(key) ? key : keys[0],
        reversed: params.get("rev") === "1",
    };
};

/** Query-string updates for a header click: a second click on the active column reverses it. */
export const sortParams = <K extends string>(
    current: SortState<K>,
    key: K,
    defaultKey: K
): Record<string, string | null> => ({
    sort: key === defaultKey ? null : key,
    rev: current.key === key && !current.reversed ? "1" : null,
});

/** Local-state counterpart of `sortParams`. */
export const nextSort = <K extends string>(current: SortState<K>, key: K): SortState<K> => ({
    key,
    reversed: current.key === key && !current.reversed,
});

const isMissing = (v: number | string | undefined | null): v is undefined | null =>
    v === undefined || v === null || (typeof v === "number" && Number.isNaN(v));

/**
 * Orders two column values: low to high when `ascending` (ranks), high to low otherwise
 * (ratings), flipped when `reversed`. Missing values stay last either way.
 */
export const columnOrder = <V extends number | string | null>(
    a: V | undefined,
    b: V | undefined,
    { ascending = false, reversed = false }: { ascending?: boolean; reversed?: boolean }
): number => {
    if (isMissing(a) || isMissing(b)) {
        return (isMissing(a) ? 1 : 0) - (isMissing(b) ? 1 : 0);
    }
    const cmp =
        typeof a === "string" ? a.localeCompare(b as string) : (a as number) - (b as number);
    return ascending !== reversed ? cmp : -cmp;
};

/** Orders by rank, best first unless reversed; unranked rows stay last either way. */
export const rankOrder = (
    a: number | null | undefined,
    b: number | null | undefined,
    reversed: boolean
): number => columnOrder(a, b, { ascending: true, reversed });
