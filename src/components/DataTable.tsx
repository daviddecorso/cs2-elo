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
const stickyThClass = "sticky-col-edge sticky left-0 z-10 bg-(--table-bg,var(--color-bg))";
const stickyTdClass = "sticky-col-edge sticky left-0 z-10 bg-(--row-bg) transition-colors";
const rowClass =
    "bg-(--row-bg) transition-colors [--row-bg:var(--table-bg,var(--color-bg))] hover:[--row-bg:var(--color-surface-2)]";
const highlightedRowClass =
    "bg-(--row-bg) transition-colors [--row-bg:color-mix(in_srgb,var(--color-accent)_10%,var(--table-bg,var(--color-bg)))] hover:[--row-bg:color-mix(in_srgb,var(--color-accent)_15%,var(--table-bg,var(--color-bg)))]";

export interface DataTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
    children: React.ReactNode;
}

export const DataTable = ({ children, className = "", ...rest }: DataTableProps) => (
    <div className="overflow-x-auto">
        <table className={`w-full text-left border-collapse ${className}`} {...rest}>
            {children}
        </table>
    </div>
);

export const TableHead = ({ children }: { children: React.ReactNode }) => (
    <thead className="border-b border-line">
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

export const FactorBar = ({ val, className = "" }: { val: number; className?: string }) => (
    <div className={`h-1.5 w-16 bg-surface-2 rounded-full overflow-hidden ${className}`}>
        <div
            className="h-full bg-accent"
            style={{ width: `${Math.min(100, Math.max(0, val * 100))}%` }}
        />
    </div>
);
