import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export function useQueryParams() {
    const [searchParams, setSearchParams] = useSearchParams();

    const setParams = useCallback(
        (updates: Record<string, string | null>) => {
            setSearchParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    for (const [key, value] of Object.entries(updates)) {
                        if (value === null) next.delete(key);
                        else next.set(key, value);
                    }
                    return next;
                },
                { replace: true }
            );
        },
        [setSearchParams]
    );

    return [searchParams, setParams] as const;
}
