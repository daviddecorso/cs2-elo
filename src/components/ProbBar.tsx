interface ProbBarProps {
    leftName: string;
    rightName: string;
    /** 0–1 probability for the left side. */
    leftProb: number;
}

export const ProbBar = ({ leftName, rightName, leftProb }: ProbBarProps) => {
    const leftPct = Math.round(leftProb * 100);
    const rightPct = 100 - leftPct;
    return (
        <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono text-muted">
                <span>
                    {leftName} {leftPct}%
                </span>
                <span>
                    {rightPct}% {rightName}
                </span>
            </div>
            <div className="h-2.5 w-full flex rounded-xs overflow-hidden bg-surface-2 border border-line">
                <div
                    style={{ width: `${leftProb * 100}%` }}
                    className="bg-accent transition-all duration-300"
                />
                <div
                    style={{ width: `${(1 - leftProb) * 100}%` }}
                    className="bg-muted/40 transition-all duration-300"
                />
            </div>
        </div>
    );
};
