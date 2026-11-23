import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import type { ScheduledMatch } from "../elo/types.ts";
import { VetoForecast } from "./VetoForecast.tsx";

const side = (team: string) => ({ team, rank: null, vrsRank: null, rating: 0, rated: true });
const sides: ScheduledMatch["sides"] = [side("HEROIC"), side("Imperial")];

describe("VetoForecast", () => {
    it("shows labels and likeliest picks without percentages", () => {
        const html = renderToString(
            <VetoForecast
                sides={sides}
                veto={{ kind: "chances", maps: [{ map: "Mirage", chance: "likely", pickedBy: [1] }, { map: "Nuke", chance: "unlikely" }] }}
            />
        );
        expect(html).toContain("likely");
        expect(html).toContain("Imperial");
        expect(html).not.toContain("%");
    });

    it("omits the pick column when no pick is named", () => {
        const html = renderToString(<VetoForecast sides={sides} veto={{ kind: "chances", maps: [{ map: "Mirage", chance: "likely" }] }} />);
        expect(html).not.toContain("Likeliest pick");
    });

    it("lists a Bo1 shortlist in order", () => {
        const html = renderToString(<VetoForecast sides={sides} veto={{ kind: "shortlist", maps: ["Mirage", "Nuke", "Ancient"] }} />);
        expect(html.indexOf("Mirage")).toBeLessThan(html.indexOf("Nuke"));
        expect(html).toContain("top 3 maps");
    });
});
