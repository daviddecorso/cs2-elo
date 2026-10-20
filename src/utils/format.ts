/** Simulated probabilities: "–" for never, "<1%" and ">99%" at the extremes so rounding never claims certainty. */
export const percent = (p: number): string => {
    if (p <= 0) return "–";
    if (p >= 1) return "100%";
    if (p < 0.01) return "<1%";
    if (p > 0.99) return ">99%";
    return `${Math.round(p * 100)}%`;
};
