import type { ExcitementTier } from "../utils/matches.ts";

export const EXCITEMENT_STYLES: Record<ExcitementTier, { text: string; bg: string }> = {
    elite: {
        text: "text-orange-600 dark:text-orange-400",
        bg: "bg-orange-500 dark:bg-orange-400",
    },
    high: {
        text: "text-heat",
        bg: "bg-heat",
    },
    medium: {
        text: "text-yellow-600 dark:text-yellow-400",
        bg: "bg-yellow-500 dark:bg-yellow-400",
    },
    low: {
        text: "text-muted",
        bg: "bg-muted",
    },
};
