import { useState } from "react";
import { useTeamLogo } from "../hooks/useTeamLogo.ts";

interface TeamLogoProps {
    team: string;
    size?: number;
    className?: string;
}

const letterOf = (name: string): string => name.trim().charAt(0).toUpperCase() || "?";

export const TeamLogo = ({ team, size = 20, className = "" }: TeamLogoProps) => {
    const entry = useTeamLogo(team);
    const [hasError, setHasError] = useState(false);

    const letter = letterOf(team);
    const badgeFontSize = size <= 16 ? "text-[9px]" : size <= 20 ? "text-[10px]" : "text-xs";
    const badgeStyle = { width: size, height: size };

    if (!entry || hasError) {
        return (
            <span
                aria-hidden="true"
                style={badgeStyle}
                className={`inline-flex items-center justify-center shrink-0 rounded bg-surface-2 text-muted font-mono font-medium select-none border border-line/60 ${badgeFontSize} ${className}`}
            >
                {letter}
            </span>
        );
    }

    const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
    const lightSrc = `${base}logos/${entry.slug}.webp`;
    const darkSrc = `${base}logos/${entry.slug}-dark.webp`;

    return (
        <span className="inline-flex items-center justify-center shrink-0" style={badgeStyle}>
            <img
                src={lightSrc}
                alt=""
                loading="lazy"
                onError={() => setHasError(true)}
                style={badgeStyle}
                className={`object-contain shrink-0 ${entry.hasDark ? "dark:hidden" : ""} ${className}`}
            />
            {entry.hasDark && (
                <img
                    src={darkSrc}
                    alt=""
                    loading="lazy"
                    onError={() => setHasError(true)}
                    style={badgeStyle}
                    className={`object-contain shrink-0 hidden dark:block ${className}`}
                />
            )}
        </span>
    );
};
