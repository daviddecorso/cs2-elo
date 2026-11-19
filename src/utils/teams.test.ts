import { describe, expect, it } from "vitest";
import { teamFromParam, teamPath } from "./teams.ts";

describe("teamPath", () => {
    it("writes spaces as underscores and round-trips through a decoded router param", () => {
        for (const team of ["Team Vitality", "MOUZ", "9z Team", "Ninjas in Pyjamas", "M80", "B8 Esports", "Team Liquid.", "Nemiga Gaming/Old"]) {
            const segment = teamPath(team).slice("/teams/".length);
            expect(teamFromParam(decodeURIComponent(segment))).toBe(team);
        }
        expect(teamPath("Team Vitality")).toBe("/teams/Team_Vitality");
    });
});
