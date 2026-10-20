import { describe, expect, it } from "vitest";
import { isDefaultLogo, teamSlug } from "./logos.ts";

describe("teamSlug", () => {
    it("converts team names to URL-safe slugs", () => {
        expect(teamSlug("Team Vitality")).toBe("team-vitality");
        expect(teamSlug("MOUZ")).toBe("mouz");
        expect(teamSlug("9z Team")).toBe("9z-team");
        expect(teamSlug("FaZe Clan")).toBe("faze-clan");
        expect(teamSlug("Natus Vincere")).toBe("natus-vincere");
        expect(teamSlug("BET-M")).toBe("bet-m");
        expect(teamSlug("Devious Esports (Australian team)")).toBe("devious-esports-australian-team");
    });

    it("trims leading and trailing hyphens", () => {
        expect(teamSlug(" -Team- ")).toBe("team");
        expect(teamSlug("!Alpha!")).toBe("alpha");
    });
});

describe("isDefaultLogo", () => {
    it("detects generic default placeholder images", () => {
        expect(
            isDefaultLogo({
                image: "Counter-Strike 2 default lightmode.png",
                imageurl: "https://liquipedia.net/commons/images/thumb/5/57/Counter-Strike_2_default_lightmode.png/373px-Counter-Strike_2_default_lightmode.png",
            })
        ).toBe(true);
    });

    it("accepts custom team logos", () => {
        expect(
            isDefaultLogo({
                image: "Team Vitality 2023 lightmode.png",
                imageurl: "https://liquipedia.net/commons/images/thumb/e/e4/Team_Vitality_2023_lightmode.png/330px-Team_Vitality_2023_lightmode.png",
            })
        ).toBe(false);
    });
});
