import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TeamLogo } from "./TeamLogo.tsx";

const render = (ui: React.ReactNode, logos: Record<string, { slug: string; hasDark: boolean }> = {}) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["logos"], logos);
    return renderToString(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
};

describe("TeamLogo", () => {
    it("renders fallback text badge when logo is missing", () => {
        const html = render(<TeamLogo team="NonExistentTeam" />);
        expect(html).toContain("N");
        expect(html).not.toContain("<img");
    });

    it("renders single light image when dark variant does not exist", () => {
        const html = render(<TeamLogo team="MOUZ" />, {
            MOUZ: { slug: "mouz", hasDark: false },
        });
        expect(html).toContain("/logos/mouz.webp");
        expect(html).not.toContain("-dark.webp");
        expect(html).not.toContain("dark:hidden");
    });

    it("renders both light and dark variant images when hasDark is true", () => {
        const html = render(<TeamLogo team="Team Vitality" />, {
            "Team Vitality": { slug: "team-vitality", hasDark: true },
        });
        expect(html).toContain("/logos/team-vitality.webp");
        expect(html).toContain("/logos/team-vitality-dark.webp");
        expect(html).toContain("dark:hidden");
        expect(html).toContain("hidden dark:block");
    });

    it("respects custom size", () => {
        const html = render(<TeamLogo team="Unknown" size={32} />);
        expect(html).toContain("width:32px");
        expect(html).toContain("height:32px");
    });
});
