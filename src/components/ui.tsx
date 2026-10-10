import type React from "react";

// Flat design-system primitives ported from cfb-elo; build page chrome from these instead of inline classes.
export const labelClass = "text-[11px] font-mono uppercase tracking-wider text-muted font-medium";

export interface LabelProps extends React.HTMLAttributes<HTMLElement> {
    as?: "div" | "span" | "label";
    htmlFor?: string;
}

export const Label = ({ as: Tag = "div", className = "", ...props }: LabelProps) => (
    <Tag className={`${labelClass} ${className}`} {...props} />
);

export interface PageHeaderProps {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    eyebrow?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
}

export const PageHeader = ({ title, subtitle, eyebrow, actions, className = "" }: PageHeaderProps) => (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className}`}>
        <div className="min-w-0">
            {eyebrow !== undefined && <Label className="mb-1">{eyebrow}</Label>}
            <h1 className="text-xl font-bold tracking-tight text-fg">{title}</h1>
            {subtitle !== undefined && (
                <div className="text-xs font-mono text-muted mt-0.5">{subtitle}</div>
            )}
        </div>
        {actions !== undefined && <div className="flex flex-wrap items-end gap-3">{actions}</div>}
    </div>
);

export interface SectionProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
}

export const Section = ({ title, subtitle, actions, children, className = "", ...props }: SectionProps) => (
    <div className={`space-y-3 ${className}`} {...props}>
        {(title !== undefined || actions !== undefined) && (
            <div className="flex items-end justify-between gap-3 pb-1.5 border-b border-line">
                <div className="min-w-0">
                    {title !== undefined && (
                        <h2 className="text-sm font-semibold tracking-tight text-fg">{title}</h2>
                    )}
                    {subtitle !== undefined && (
                        <div className="text-xs font-mono text-muted mt-0.5">{subtitle}</div>
                    )}
                </div>
                {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
            </div>
        )}
        {children}
    </div>
);

export const Inset = ({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={`bg-surface-2 border border-line rounded-sm p-3 [--table-bg:var(--color-surface-2)] ${className}`}
        {...props}
    />
);

export const EmptyState = ({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div className={`py-8 text-center text-xs font-mono text-muted ${className}`} {...props} />
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md" | "icon";
}

export const Button = ({
    variant = "secondary",
    size = "md",
    className = "",
    type = "button",
    ...props
}: ButtonProps) => {
    const base =
        "inline-flex items-center justify-center font-medium rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:opacity-50 disabled:pointer-events-none cursor-pointer";

    const variantStyles = {
        primary: "bg-accent text-white hover:opacity-90 active:opacity-100",
        secondary: "bg-surface text-fg border border-line hover:bg-surface-2 active:bg-surface-2",
        ghost: "bg-transparent text-fg hover:bg-surface-2 active:bg-surface-2",
    }[variant];

    const sizeStyles = {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        icon: "h-8 w-8 text-xs",
    }[size];

    return (
        <button
            type={type}
            className={`${base} ${variantStyles} ${sizeStyles} ${className}`}
            {...props}
        />
    );
};

export interface SegmentedOption<T extends string | number> {
    value: T;
    label: React.ReactNode;
}

export interface SegmentedProps<T extends string | number> {
    options: Array<SegmentedOption<T> | T>;
    value: T;
    onChange: (value: T) => void;
    className?: string;
    size?: "sm" | "md";
    "aria-label"?: string;
}

export function Segmented<T extends string | number>({
    options,
    value,
    onChange,
    className = "",
    size = "sm",
    "aria-label": ariaLabel,
}: SegmentedProps<T>) {
    const sizeStyles = {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
    }[size];

    return (
        <div
            role="group"
            aria-label={ariaLabel}
            className={`inline-flex rounded-sm border border-line divide-x divide-line overflow-hidden shrink-0 ${className}`}
        >
            {options.map((option) => {
                const optValue = typeof option === "object" ? option.value : option;
                const optLabel = typeof option === "object" ? option.label : String(option);
                const isActive = optValue === value;

                return (
                    <button
                        key={String(optValue)}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => onChange(optValue)}
                        className={`${sizeStyles} font-mono font-medium transition-colors cursor-pointer select-none whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] ${
                            isActive
                                ? "bg-fg text-bg"
                                : "bg-surface text-muted hover:text-fg hover:bg-surface-2"
                        }`}
                    >
                        {optLabel}
                    </button>
                );
            })}
        </div>
    );
}

export const LoadingBar = ({ label = "Loading…" }: { label?: string }) => (
    <div role="status" className="min-h-[50vh] flex items-center justify-center">
        <div className="text-center space-y-3">
            <div className="w-48 h-0.5 bg-line overflow-hidden mx-auto">
                <div className="w-full h-full bg-accent animate-pulse" />
            </div>
            <p className="text-xs font-mono text-muted">{label}</p>
        </div>
    </div>
);

/** A label/value row; render inside a `<dl>`. */
export const DataRow = ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => (
    <div className="flex justify-between gap-3">
        <dt className="text-muted shrink-0">{label}</dt>
        <dd className="text-fg text-right tabular-nums min-w-0 truncate">{children}</dd>
    </div>
);
