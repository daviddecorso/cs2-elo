import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { slugify, useScrollToHash } from "../hooks/useScrollToHash.ts";
import { LiquipediaCredit } from "../components/LiquipediaCredit.tsx";

type Example = { tone: "up" | "down" | "flat"; text: string };

const EXAMPLES: Example[] = [
    { tone: "up", text: "Sweeping a top-tier opponent 13-4 on LAN" },
    { tone: "down", text: "Barely scraping past an online tier-3 opponent in double overtime" },
    { tone: "flat", text: "Winning by exactly the predicted round spread" },
    { tone: "up", text: "Losing 11-13 as a massive underdog against a top-5 team" },
    { tone: "down", text: "Dropping a map as a 90% favorite" },
    { tone: "up", text: "Outperforming rating expectation in an inter-region LAN match" },
];

const VALUED = [
    "Round margin of victory versus pregame expectation",
    "Opponent roster strength and track record",
    "LAN stage matches over online qualifier matches",
    "Liquipedia tournament tiers (Tier 1 Premier events count most)",
    "Cross-region LAN match results linking regional pools",
    "Per-map tactical strengths and pool preferences",
];

const NOT_VALUED = [
    "Raw map wins without regard to round score",
    "Organization brand, fan prestige, or historical legacy",
    "Trophies won with a different five-player lineup",
    "Unplayed, forfeited, or abandoned maps",
    "Subjective committee seeding or invites",
];

const toneClass: Record<Example["tone"], string> = {
    up: "text-up",
    down: "text-down",
    flat: "text-muted",
};

const toneSymbol: Record<Example["tone"], string> = {
    up: "[+]",
    down: "[-]",
    flat: "[=]",
};

const REVISED_ON = "10-20-2026";

const Section = ({
    id,
    title,
    children,
}: {
    id?: string;
    title: string;
    children: ReactNode;
}) => {
    const sectionId = id ?? slugify(title);
    return (
        <section id={sectionId} className="space-y-3 scroll-mt-20">
            <h2 className="flex items-baseline gap-3 font-bold uppercase tracking-wider">
                <a href={`#${sectionId}`} className="group hover:underline underline-offset-2">
                    {title}
                    <span
                        className="ml-2 text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                        aria-hidden
                    >
                        #
                    </span>
                </a>
                <span className="flex-1 border-b border-dotted border-muted/60" />
            </h2>
            <div className="space-y-3">{children}</div>
        </section>
    );
};

const TractorStrip = ({ side }: { side: "left" | "right" }) => (
    <div
        aria-hidden
        className={`tractor-feed hidden sm:block w-8 shrink-0 border-dashed border-line ${
            side === "left" ? "border-r" : "border-l"
        }`}
    />
);

const TOC = [
    { title: "Why", id: "why" },
    { title: "The core idea", id: "the-core-idea" },
    { title: "What moves a rating", id: "what-moves-a-rating" },
    { title: "What we value", id: "what-we-value" },
    { title: "Why only these", id: "why-only-these" },
    { title: "Rosters & the 3/5 rule", id: "rosters-and-the-3-5-rule" },
    { title: "Map vs. series forecasts", id: "map-vs-series-forecasts" },
    { title: "LAN vs. Online & Event tiers", id: "lan-vs-online-and-event-tiers" },
    { title: "Cross-region calibration", id: "cross-region-calibration" },
    { title: "Map pool offsets", id: "map-pool-offsets" },
    { title: "Tournament simulator", id: "tournament-simulator" },
    { title: "Elo vs. VRS", id: "elo-vs-vrs" },
];

export const Methodology = () => {
    useScrollToHash();

    return (
        <div className="py-2">
            <article className="mx-auto flex max-w-3xl bg-paper border border-line shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_-8px_rgba(0,0,0,0.12)] font-mono text-[13px] leading-relaxed text-fg">
                <TractorStrip side="left" />
                <div className="flex-1 min-w-0 px-5 py-8 sm:px-12 sm:py-12 space-y-8">
                    <header className="space-y-3">
                        <div className="flex flex-wrap justify-between gap-x-6 text-[11px] uppercase tracking-wider text-muted">
                            <span>Davelo CS2 Rating System v1.0</span>
                            <span>Revised {REVISED_ON}</span>
                        </div>
                        <div className="border-t-[3px] border-double border-fg" />
                        <h1 className="text-lg font-bold uppercase tracking-[0.2em]">
                            Methodology
                        </h1>
                        <div className="border-t-[3px] border-double border-fg" />
                    </header>

                    <nav
                        aria-label="Table of contents"
                        className="p-3 border border-dashed border-line bg-surface/50 text-xs"
                    >
                        <div className="font-bold uppercase tracking-wider mb-2 text-muted">
                            Table of Contents
                        </div>
                        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                            {TOC.map(({ id, title }) => (
                                <li key={id}>
                                    <a href={`#${id}`} className="text-accent hover:underline">
                                        {title}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </nav>

                    <Section title="Why">
                        <p>
                            Competitive Counter-Strike 2 features hundreds of professional squads across Europe,
                            the Americas, and Asia. Traditional rankings often rely on prize money totals, subjective
                            voter polls, or infrequent official snapshots. Without an objective system tracking every
                            map played, results against unranked or emerging squads are valued arbitrarily.
                        </p>
                        <p>
                            With Major qualifications, RMR invitations, and tournament seeding directly determined by
                            ranking points, an independent, transparent, and empirically verified rating model is
                            essential.
                        </p>
                    </Section>

                    <Section title="The core idea">
                        <p>
                            Before every map, each team&apos;s current rating generates a win probability and expected
                            round margin. After the map concludes, both ratings update based on how far the actual
                            score exceeded or fell short of expectation.
                        </p>
                        <p>
                            Ratings are zero-sum: what one squad gains, the other relinquishes. Winning a map by 13-11
                            when expected to win 13-4 causes a rating penalty. Playing competitive rounds against an
                            elite opponent as an underdog yields positive rating growth.
                        </p>
                    </Section>

                    <Section title="What moves a rating">
                        <ul className="space-y-1.5">
                            {EXAMPLES.map((e) => (
                                <li key={e.text} className="flex gap-3">
                                    <span
                                        className={`shrink-0 font-bold ${toneClass[e.tone]}`}
                                        aria-hidden
                                    >
                                        {toneSymbol[e.tone]}
                                    </span>
                                    <span>{e.text}</span>
                                </li>
                            ))}
                        </ul>
                    </Section>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <Section title="What we value">
                            <ul className="space-y-1.5">
                                {VALUED.map((v) => (
                                    <li key={v} className="flex gap-3">
                                        <span className="shrink-0 text-muted" aria-hidden>
                                            +
                                        </span>
                                        <span>{v}</span>
                                    </li>
                                ))}
                            </ul>
                        </Section>
                        <Section title="What we don't">
                            <ul className="space-y-1.5">
                                {NOT_VALUED.map((v) => (
                                    <li key={v} className="flex gap-3">
                                        <span className="shrink-0 text-muted" aria-hidden>
                                            -
                                        </span>
                                        <span>{v}</span>
                                    </li>
                                ))}
                            </ul>
                        </Section>
                    </div>

                    <Section title="Why only these">
                        <p>
                            Every model parameter must improve out-of-sample prediction accuracy. Rewarding historical
                            reputation or granting bonus points for narrow victories distorts future match projections.
                            A 13-11 win is virtually identical in performance to an 11-13 loss; treating them as diametric
                            opposites degrades predictive fidelity.
                        </p>
                    </Section>

                    <Section title="Rosters & the 3/5 rule">
                        <p>
                            Ratings adhere to five-player lineages rather than corporate team logos. A lineage carries
                            forward as long as three of its five core players remain together—the same criterion
                            enforced by Valve for Major invitations.
                        </p>
                        <p>
                            When a squad changes one or two players, its rating regresses partially toward the tier
                            average to account for synergy loss and uncertainty. Brand-new lineups begin from the
                            weighted average rating of the individual players&apos; prior core lineages.
                        </p>
                    </Section>

                    <Section title="Map vs. series forecasts">
                        <p>
                            Ratings update on every individual map, not per best-of-3 series. A series forecast averages
                            map win probabilities across the active competitive pool and compounds them into Bo1, Bo3,
                            or Bo5 series probabilities.
                        </p>
                        <p>
                            Because maps within a single match share momentum and psychological conditions, a series
                            temperature parameter (0.8) softens the compound probabilities. Without this correction,
                            Bo3 forecasts become overconfident despite calibrated individual maps.
                        </p>
                    </Section>

                    <Section title="LAN vs. Online & Event tiers">
                        <p>
                            Match outcomes on stage at premier LANs receive greater weight than online qualifiers.
                            Online play introduces latency variance, anti-cheat differences, and inconsistent player
                            setups.
                        </p>
                        <p>
                            Events categorized under Liquipedia Tier 1 (Majors, IEM, BLAST Premier) receive maximum
                            K-factor weighting, while Tier 2 and Tier 3 tournaments decay proportionally.
                        </p>
                    </Section>

                    <Section title="Cross-region calibration">
                        <p>
                            Counter-Strike teams predominantly compete in isolated regional circuits across Europe,
                            North America, South America, and Asia. Without calibration, regional bubbles can develop
                            inflated ratings.
                        </p>
                        <p>
                            Matches between rosters from different geographic regions carry an elevated K-factor
                            multiplier. These international LAN clashes anchor the global rating scale together.
                        </p>
                    </Section>

                    <Section title="Map pool offsets">
                        <p>
                            Every roster maintains specific rating offsets for each map in the active duty pool
                            (Dust II, Mirage, Inferno, Nuke, Ancient, Anubis, Train). These offsets capture map-specific
                            proficiencies while remaining centered on zero and shrunk toward the mean.
                        </p>
                    </Section>

                    <Section title="Tournament simulator">
                        <p>
                            The tournament simulator runs 10,000 Monte Carlo iterations for upcoming events and Major
                            invitation races. Each match draws from the model&apos;s series win probabilities, while
                            incorporating simulated rating drift between stages.
                        </p>
                    </Section>

                    <Section title="Elo vs. VRS">
                        <p>
                            We validate the Elo model by testing whether its predictions outperform Valve Regional
                            Standings (VRS) point differentials on out-of-sample matches. The backtest gate requires
                            that Elo achieve lower binary cross-entropy log loss on all 2026 series where both squads
                            hold VRS rankings.
                        </p>
                        <p>
                            Inspect full empirical results, calibration curves, and score comparisons on the{" "}
                            <Link to="/model" className="underline underline-offset-2 hover:text-accent font-semibold">
                                Model performance page
                            </Link>
                            .
                        </p>
                    </Section>

                    <footer className="pt-6 border-t border-line text-xs text-muted">
                        <LiquipediaCredit what="Match records, tournament tiers, and roster history" />
                    </footer>
                </div>
                <TractorStrip side="right" />
            </article>
        </div>
    );
};
