import type { Region, Standings } from "../../../src/vrs/types.ts";

export interface StrictMismatch {
    rosterKey: string;
    teamName: string;
    reason: string;
    modelValue?: unknown;
    publishedValue?: unknown;
}

export interface RegionAgreement {
    exact: number;
    total: number;
}

export interface RankDeviation {
    rosterKey: string;
    teamName: string;
    deviation: number;
    modelRank: number | null;
    publishedRank: number | null;
}

export interface CutoffMismatch {
    region: Region;
    rosterKey: string;
    teamName: string;
    cutoff: number;
    modelRegionalRank: number | null;
    publishedRegionalRank: number | null;
}

export interface ComparisonReport {
    passed: boolean;
    strictMismatches: StrictMismatch[];
    exactMatchesPerRegion: Record<Region, RegionAgreement>;
    largestRankDeviation: RankDeviation | null;
    pointsError: {
        mean: number;
        max: number;
    };
    cutoffMismatches: CutoffMismatch[];
}

export const compareStandings = (
    model: Standings,
    published: Standings,
    cutoffs: Record<Region, number>
): ComparisonReport => {
    const strictMismatches: StrictMismatch[] = [];
    const modelMap = new Map(model.rosters.map((r) => [r.rosterKey, r]));
    const publishedMap = new Map(published.rosters.map((r) => [r.rosterKey, r]));

    const exactMatchesPerRegion: Record<Region, RegionAgreement> = {
        Europe: { exact: 0, total: 0 },
        Americas: { exact: 0, total: 0 },
        Asia: { exact: 0, total: 0 },
    };

    published.rosters.forEach((p) => {
        if (exactMatchesPerRegion[p.region]) {
            exactMatchesPerRegion[p.region].total += 1;
        }
    });

    let maxDeviation: RankDeviation | null = null;
    const pointErrors: number[] = [];
    const cutoffMismatches: CutoffMismatch[] = [];

    // Check published vs model
    published.rosters.forEach((p) => {
        const m = modelMap.get(p.rosterKey);
        if (!m) {
            strictMismatches.push({
                rosterKey: p.rosterKey,
                teamName: p.teamName,
                reason: "Roster missing in model output",
            });
            return;
        }

        // Rank comparison
        if (m.globalRank !== p.globalRank) {
            strictMismatches.push({
                rosterKey: p.rosterKey,
                teamName: p.teamName,
                reason: `Global rank mismatch: model=${m.globalRank}, published=${p.globalRank}`,
                modelValue: m.globalRank,
                publishedValue: p.globalRank,
            });
        }

        if (m.regionalRank !== p.regionalRank) {
            strictMismatches.push({
                rosterKey: p.rosterKey,
                teamName: p.teamName,
                reason: `Regional rank mismatch (${p.region}): model=${m.regionalRank}, published=${p.regionalRank}`,
                modelValue: m.regionalRank,
                publishedValue: p.regionalRank,
            });
        } else if (p.regionalRank !== null && exactMatchesPerRegion[p.region]) {
            exactMatchesPerRegion[p.region].exact += 1;
        }

        // Points comparison
        const mRounded = Math.round(m.points);
        const pRounded = Math.round(p.points);
        if (mRounded !== pRounded) {
            strictMismatches.push({
                rosterKey: p.rosterKey,
                teamName: p.teamName,
                reason: `Points mismatch: model=${mRounded} (${m.points.toFixed(1)}), published=${pRounded}`,
                modelValue: mRounded,
                publishedValue: pRounded,
            });
        }

        const pointDiff = Math.abs(m.points - p.points);
        pointErrors.push(pointDiff);

        // Global deviation
        if (m.globalRank !== null && p.globalRank !== null) {
            const dev = Math.abs(m.globalRank - p.globalRank);
            if (!maxDeviation || dev > maxDeviation.deviation) {
                maxDeviation = {
                    rosterKey: p.rosterKey,
                    teamName: p.teamName,
                    deviation: dev,
                    modelRank: m.globalRank,
                    publishedRank: p.globalRank,
                };
            }
        }

        // Cutoff ±3 band check
        const cutoff = cutoffs[p.region];
        if (cutoff !== undefined) {
            const inModelBand =
                m.regionalRank !== null &&
                m.regionalRank >= cutoff - 3 &&
                m.regionalRank <= cutoff + 3;
            const inPublishedBand =
                p.regionalRank !== null &&
                p.regionalRank >= cutoff - 3 &&
                p.regionalRank <= cutoff + 3;

            if ((inModelBand || inPublishedBand) && m.regionalRank !== p.regionalRank) {
                cutoffMismatches.push({
                    region: p.region,
                    rosterKey: p.rosterKey,
                    teamName: p.teamName,
                    cutoff,
                    modelRegionalRank: m.regionalRank,
                    publishedRegionalRank: p.regionalRank,
                });
            }
        }
    });

    // Check for ranked rosters in model missing in published
    model.rosters.forEach((m) => {
        if (m.globalRank !== null && m.globalRank > 0 && !publishedMap.has(m.rosterKey)) {
            strictMismatches.push({
                rosterKey: m.rosterKey,
                teamName: m.teamName,
                reason: "Extra roster present in model but missing in published",
            });
        }
    });

    const meanPointsError =
        pointErrors.length > 0
            ? pointErrors.reduce((a, b) => a + b, 0) / pointErrors.length
            : 0;
    const maxPointsError = pointErrors.length > 0 ? Math.max(...pointErrors) : 0;

    return {
        passed: strictMismatches.length === 0,
        strictMismatches,
        exactMatchesPerRegion,
        largestRankDeviation: maxDeviation,
        pointsError: {
            mean: meanPointsError,
            max: maxPointsError,
        },
        cutoffMismatches,
    };
};
