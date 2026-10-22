import type React from "react";
import type { SortState } from "../utils/tableSort.ts";

type Align = "left" | "right" | "center";

const alignClass: Record<Align, string> = {
    left: "text-left",
    right: "text-right",
    center: "text-center",
};

export const thClass =
    "py-2 px-3 text-[11px] font-mono uppercase tracking-wider text-muted font-medium whitespace-nowrap";
export const tdClass = "py-2 px-3 text-xs font-mono whitespace-nowrap";
// Tables read their surface from `--table-bg`, which `Card` and `Inset` set; the page background is the default.
const stickyThClass = "sticky-col-edge sticky left-0 z-30 bg-(--table-bg,var(--color-bg))";
// Sticky cells must be opaque, so they read the row's background from `--row-bg` set by `Row`.
const stickyTdClass = "sticky-col-edge sticky left-0 z-10 bg-(--row-bg) transition-colors";
const rowClass =
    "bg-(--row-bg) transition-colors [--row-bg:var(--table-bg,var(--color-bg))] hover:[--row-bg:var(--color-surface-2)]";
const highlightedRowClass =
    "bg-(--row-bg) transition-colors [--row-bg:color-mix(in_srgb,var(--color-accent)_10%,var(--table-bg,var(--color-bg)))] hover:[--row-bg:color-mix(in_srgb,var(--color-accent)_15%,var(--table-bg,var(--color-bg)))]";

export interface DataTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
    children: React.ReactNode;
    /** Pins the header below the app header at lg+; narrower screens keep horizontal scroll instead. */
    stickyHeader?: boolean;
}

// Any non-visible overflow makes the wrapper the sticky ancestor, so lg+ drops it to stick against the page.
const stickyHeaderContainerClass = "overflow-x-auto lg:overflow-visible lg:[&_thead]:top-(--app-header-h)";

export const DataTable = ({ children, className = "", stickyHeader = false, ...rest }: DataTableProps) => (
    <div className={stickyHeader ? stickyHeaderContainerClass : "overflow-x-auto"}>
        <table className={`w-full text-left border-collapse ${className}`} {...rest}>
            {children}
        </table>
    </div>
);

export const TableHead = ({
    children,
    className = "",
}: {
    children: React.ReactNode;
    className?: string;
}) => (
    <thead
        className={`sticky top-0 z-20 bg-(--table-bg,var(--color-bg)) border-b border-line ${className}`}
    >
        <tr>{children}</tr>
    </thead>
);

export const TableBody = ({ children }: { children: React.ReactNode }) => (
    <tbody className="divide-y divide-line">{children}</tbody>
);

export const Row = ({
    highlighted = false,
    className = "",
    ...rest
}: { highlighted?: boolean } & React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr className={`${highlighted ? highlightedRowClass : rowClass} ${className}`} {...rest} />
);

interface CellProps {
    align?: Align;
    sticky?: boolean;
}

export const Th = ({
    align = "right",
    sticky = false,
    className = "",
    ...rest
}: CellProps & React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th
        className={`${thClass} ${alignClass[align]} ${sticky ? stickyThClass : ""} ${className}`}
        {...rest}
    />
);

export const Td = ({
    align = "left",
    sticky = false,
    className = "",
    ...rest
}: CellProps & React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td
        className={`${tdClass} ${alignClass[align]} ${sticky ? stickyTdClass : ""} ${className}`}
        {...rest}
    />
);

export interface SortHeaderProps<K extends string> extends CellProps {
    sortKey: K;
    sort: SortState<K>;
    onSort: (key: K) => void;
    /** The column reads low to high in its default order (ranks), not high to low (ratings). */
    ascending?: boolean;
    children: React.ReactNode;
    className?: string;
}

export function SortHeader<K extends string>({
    sortKey,
    sort,
    onSort,
    ascending = false,
    align = "right",
    sticky = false,
    children,
    className = "",
}: SortHeaderProps<K>) {
    const active = sort.key === sortKey;
    return (
        <Th
            align={align}
            sticky={sticky}
            aria-sort={
                active ? (ascending !== sort.reversed ? "ascending" : "descending") : "none"
            }
            className={className}
        >
            <button
                type="button"
                onClick={() => onSort(sortKey)}
                className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-fg cursor-pointer ${
                    active ? "text-fg font-semibold" : "text-muted"
                }`}
            >
                {children}
                <span className={`text-[10px] ${active ? "text-accent" : "text-muted/30"}`}>
                    {active ? (sort.reversed ? "▴" : "▾") : "↕"}
                </span>
            </button>
        </Th>
    );
}

export const ProbabilityBar = ({ p, className = "" }: { p: number; className?: string }) => (
    <div className={`h-1.5 w-16 bg-surface-2 rounded-full overflow-hidden ${className}`}>
        <div
            className="h-full bg-accent"
            style={{ width: `${Math.min(100, Math.max(0, p * 100))}%` }}
        />
    </div>
);

export const FactorBar = ({ val, className = "" }: { val: number; className?: string }) => (
    <div className={`h-1.5 w-16 bg-surface-2 rounded-full overflow-hidden ${className}`}>
        <div
            className="h-full bg-accent"
            style={{ width: `${Math.min(100, Math.max(0, val * 100))}%` }}
        />
    </div>
);
