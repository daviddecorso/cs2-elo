import path from "node:path";
import { loadValveCjs } from "../vrs/valveModel.ts";

const valveRegion = loadValveCjs(
    path.resolve(import.meta.dirname, "../../../vendor/counter-strike_regional_standings/model/util/region.js")
) as { getCountryRegion: (iso: string) => number };

/** Valve's region index (0 Europe, 1 Americas, 2 Asia), or null for Africa and unmapped countries. */
export const countryRegion = (iso: string): number | null => {
    if (!iso) return null;
    try {
        const region = valveRegion.getCountryRegion(iso);
        return region >= 0 ? region : null;
    } catch {
        return null;
    }
};

/** Majority region of a lineup, or null without a strict plurality. */
export const lineupRegion = (countries: string[]): number | null => {
    const counts = [0, 0, 0];
    for (const c of countries) {
        const r = countryRegion(c);
        if (r !== null) counts[r]++;
    }
    const best = Math.max(...counts);
    if (best === 0 || counts.filter((n) => n === best).length > 1) return null;
    return counts.indexOf(best);
};
