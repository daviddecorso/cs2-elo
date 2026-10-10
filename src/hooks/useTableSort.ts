import { useQueryParams } from "./useQueryParams.ts";
import { readSort, sortParams } from "../utils/tableSort.ts";

export function useTableSort<K extends string>(keys: readonly K[]) {
    const [searchParams, setParams] = useQueryParams();
    const sort = readSort(searchParams, keys);
    const onSort = (key: K) => setParams(sortParams(sort, key, keys[0]));
    return { sort, onSort };
}
