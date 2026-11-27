import type { EloParams } from "./params.ts";

/** Player-level Elo from results only: a side's strength is the mean rating of its lineup. On its own scale, centred near 0. */
export class PlayerRatings {
    private rating = new Map<string, number>();
    private maps = new Map<string, number>();
    private params: EloParams;

    constructor(params: EloParams) {
        this.params = params;
    }

    /** Where an unrated player in `lineup` starts: the mean of 2+ rated teammates, else `−playerTierGap · (tier − 1)`. */
    private seedFor(lineup: string[], tier: number): number {
        const rated = lineup.filter((player) => this.rating.has(player));
        return rated.length >= 2
            ? rated.reduce((sum, player) => sum + this.rating.get(player)!, 0) / rated.length
            : -this.params.playerTierGap * (tier - 1);
    }

    /** Mean rating of `lineup`, unrated players at their seed; doesn't add them. */
    teamRating(lineup: string[], tier: number): number {
        if (lineup.length === 0) return 0;
        const seed = this.seedFor(lineup, tier);
        return lineup.reduce((sum, player) => sum + (this.rating.get(player) ?? seed), 0) / lineup.length;
    }

    /** `teamRating`, adding unrated players at their seed. */
    seed(lineup: string[], tier: number): number {
        const seed = this.seedFor(lineup, tier);
        for (const player of lineup) {
            if (this.rating.has(player)) continue;
            this.rating.set(player, seed);
            this.maps.set(player, 0);
        }
        return this.teamRating(lineup, tier);
    }

    /** One map: `gap` is lineups[0]'s team rating minus lineups[1]'s before it, `margin` the round margin, `y` 1 if lineups[0] won. */
    update(lineups: [string[], string[]], tier: number, gap: number, margin: number, y: 0 | 1): void {
        const p = this.params;
        const mult = 1 + p.playerMarginWeight * Math.log1p(Math.abs(margin));
        const delta = p.playerK * p.playerTierK ** (tier - 1) * mult * (y - 1 / (1 + 10 ** (-gap / p.scale)));
        lineups.forEach((lineup, side) => {
            const sign = side === 0 ? 1 : -1;
            for (const player of lineup) {
                const n = this.maps.get(player) ?? 0;
                const provisional = 1 + p.playerProvisionalK * Math.max(0, 1 - n / p.playerProvisionalMaps);
                this.rating.set(player, (this.rating.get(player) ?? 0) + sign * delta * provisional);
                this.maps.set(player, n + 1);
            }
        });
    }
}
