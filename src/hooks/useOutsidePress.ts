import { useEffect, type RefObject } from "react";

export function useOutsidePress(ref: RefObject<HTMLElement | null>, active: boolean, onOutsidePress: () => void) {
    useEffect(() => {
        if (!active) return;
        const handleMouseDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onOutsidePress();
        };
        document.addEventListener("mousedown", handleMouseDown);
        return () => document.removeEventListener("mousedown", handleMouseDown);
    }, [ref, active, onOutsidePress]);
}
