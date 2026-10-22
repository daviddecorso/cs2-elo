import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export function slugify(text: string) {
    return text
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

// Lazy-loaded pages mount after the browser's own hash scroll has already run.
export function useScrollToHash() {
    const { hash } = useLocation();

    useEffect(() => {
        if (hash) document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView();
    }, [hash]);
}
