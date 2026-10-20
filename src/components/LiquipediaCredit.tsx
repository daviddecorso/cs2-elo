const linkClass = "underline hover:text-fg transition-colors";

export const LiquipediaCredit = ({ what = "Match, tournament and team logo data" }: { what?: string }) => (
    <div className="mt-4 text-xs text-muted">
        {what} sourced from{" "}
        <a href="https://liquipedia.net/counterstrike/" target="_blank" rel="noopener noreferrer" className={linkClass}>
            Liquipedia
        </a>{" "}
        under{" "}
        <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer" className={linkClass}>
            CC-BY-SA 3.0
        </a>
        .
    </div>
);
