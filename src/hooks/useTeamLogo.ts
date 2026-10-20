import { useQuery } from "@tanstack/react-query";

export interface LogoEntry {
    slug: string;
    hasDark: boolean;
}

export type LogoManifest = Record<string, LogoEntry>;

const fetchLogos = async (): Promise<LogoManifest> => {
    try {
        const res = await fetch(`${import.meta.env.BASE_URL}data/logos.json`);
        if (!res.ok) return {};
        return (await res.json()) as LogoManifest;
    } catch {
        return {};
    }
};

export const useLogosManifest = () =>
    useQuery({
        queryKey: ["logos"],
        queryFn: fetchLogos,
        staleTime: Infinity,
    });

export const useTeamLogo = (team: string): LogoEntry | null => {
    const { data } = useLogosManifest();
    return data?.[team] ?? null;
};
