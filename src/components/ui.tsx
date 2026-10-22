import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonStyles.ts";

// Flat design-system primitives: see src/components/README.md before adding a page-level pattern.
export const labelClass =
    "text-[11px] font-mono uppercase tracking-wider text-muted font-medium";

export interface LabelProps extends React.HTMLAttributes<HTMLElement> {
    as?: "div" | "span" | "label";
    htmlFor?: string;
}

export const Label = ({
    as: Tag = "div",
    className = "",
    ...props
}: LabelProps) => <Tag className={`${labelClass} ${className}`} {...props} />;

export interface PageHeaderProps {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    eyebrow?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
    /** Fixes the title block's width so `actions` wrap at the same width whatever the title/subtitle text. */
    stableWrap?: boolean;
}

export const PageHeader = ({
    title,
    subtitle,
    eyebrow,
    actions,
    className = "",
    stableWrap = false,
}: PageHeaderProps) => (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className}`}>
        <div className={`min-w-0 ${stableWrap ? "sm:w-xl max-w-full" : ""}`}>
            {eyebrow !== undefined && <Label className="mb-1">{eyebrow}</Label>}
            <h1 className="text-xl font-bold tracking-tight text-fg">{title}</h1>
            {subtitle !== undefined && (
                <div className="text-xs font-mono text-muted mt-0.5">{subtitle}</div>
            )}
        </div>
        {actions !== undefined && (
            <div className="flex flex-wrap items-end gap-3">{actions}</div>
        )}
    </div>
);

export interface SectionProps
    extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    children?: React.ReactNode;
}

export const Section = ({
    title,
    subtitle,
    actions,
    children,
    className = "",
    ...props
}: SectionProps) => (
    <div className={`space-y-3 ${className}`} {...props}>
        {(title !== undefined || actions !== undefined) && (
            <div className="flex items-end justify-between gap-3 pb-1.5 border-b border-line">
                <div className="min-w-0">
                    {title !== undefined && (
                        <h2 className="text-sm font-semibold tracking-tight text-fg">
                            {title}
                        </h2>
                    )}
                    {subtitle !== undefined && (
                        <div className="text-xs font-mono text-muted mt-0.5">{subtitle}</div>
                    )}
                </div>
                {actions !== undefined && (
                    <div className="flex items-center gap-2">{actions}</div>
                )}
            </div>
        )}
        {children}
    </div>
);

// Pulls the next sibling to 16px inside a `space-y-10` page stack.
export const Toolbar = ({ className = "", ...props }: React.ComponentProps<"div">) => (
    <div className={`-mt-6 mb-4 ${className}`} {...props} />
);

export const Card = ({
    className = "",
    ...props
}: React.ComponentProps<"div">) => (
    <div
        className={`bg-surface border border-line rounded-sm [--table-bg:var(--color-surface)] ${className}`}
        {...props}
    />
);

export const Inset = ({
    className = "",
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={`bg-surface-2 border border-line rounded-sm p-3 [--table-bg:var(--color-surface-2)] ${className}`}
        {...props}
    />
);

export const EmptyState = ({
    className = "",
    ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
    <div
        className={`py-8 text-center text-xs font-mono text-muted ${className}`}
        {...props}
    />
);

export const LiveDot = () => (
    <span className="w-1.5 h-1.5 shrink-0 rounded-full bg-down animate-pulse motion-reduce:animate-none" title="Live">
        <span className="sr-only">Live</span>
    </span>
);

export type BadgeTone = "neutral" | "up" | "down" | "heat" | "accent";

const badgeToneClass: Record<BadgeTone, string> = {
    neutral: "bg-surface-2 text-muted border-line",
    up: "bg-up/15 text-up border-up/30",
    down: "bg-down/15 text-down border-down/30",
    heat: "bg-heat/15 text-heat border-heat/30",
    accent: "bg-accent/15 text-accent border-accent/30",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    tone?: BadgeTone;
}

export const Badge = ({
    tone = "neutral",
    className = "",
    ...props
}: BadgeProps) => (
    <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded-sm border text-[10px] font-mono font-medium uppercase ${badgeToneClass[tone]} ${className}`}
        {...props}
    />
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
}

export const Button = ({
    variant = "secondary",
    size = "md",
    className = "",
    disabled,
    children,
    ...props
}: ButtonProps) => {
    return (
        <button
            className={buttonClasses({ variant, size, className })}
            disabled={disabled}
            {...props}
        >
            {children}
        </button>
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
    disabled?: boolean;
    "aria-label"?: string;
}

export function Segmented<T extends string | number>({
    options,
    value,
    onChange,
    className = "",
    size = "sm",
    disabled = false,
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
                const optValue =
                    typeof option === "object" && option !== null && "value" in option
                        ? option.value
                        : (option as T);
                const optLabel =
                    typeof option === "object" && option !== null && "label" in option
                        ? option.label
                        : String(option);
                const isActive = optValue === value;

                return (
                    <button
                        key={String(optValue)}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => onChange(optValue)}
                        disabled={disabled}
                        className={`${sizeStyles} font-mono font-medium transition-colors cursor-pointer select-none whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-50 ${
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

export interface SelectOption {
    value: string | number;
    label: string;
}

export interface SelectProps
    extends React.SelectHTMLAttributes<HTMLSelectElement> {
    label?: string;
    options: SelectOption[];
}

export const Select = ({
    label,
    options,
    className = "",
    id,
    ...props
}: SelectProps) => {
    return (
        <div className="flex flex-col gap-1">
            {label && (
                <Label as="label" htmlFor={id}>
                    {label}
                </Label>
            )}
            <select
                id={id}
                className={`h-8 px-2.5 text-xs font-mono bg-surface text-fg border border-line rounded-sm focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 transition-colors cursor-pointer ${className}`}
                {...props}
            >
                {options.map((opt) => (
                    <option key={String(opt.value)} value={opt.value}>
                        {opt.label}
                    </option>
                ))}
            </select>
        </div>
    );
};

export interface TextInputProps
    extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
    label?: string;
    size?: "sm" | "md";
}

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
    (
        {
            label,
            size = "sm",
            className = "",
            id,
            type = "search",
            ...props
        },
        ref
    ) => {
        const sizeStyles = {
            sm: "h-8 text-xs",
            md: "h-9 text-sm",
        }[size];

        return (
            <div className="flex flex-col gap-1">
                {label && (
                    <Label as="label" htmlFor={id}>
                        {label}
                    </Label>
                )}
                <input
                    ref={ref}
                    type={type}
                    id={id}
                    className={`${sizeStyles} px-2.5 font-mono bg-surface text-fg border border-line rounded-sm focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 transition-colors ${className}`}
                    {...props}
                />
            </div>
        );
    }
);
TextInput.displayName = "TextInput";

export interface StatTileProps {
    label: React.ReactNode;
    value: React.ReactNode;
    caption?: React.ReactNode;
    className?: string;
}

export const StatTile = ({ label, value, caption, className = "" }: StatTileProps) => {
    return (
        <div className={className}>
            <Label>{label}</Label>
            <div className="text-3xl font-mono font-bold text-fg mt-1">
                {value}
            </div>
            {caption && (
                <div className="text-xs font-mono text-muted mt-1">
                    {caption}
                </div>
            )}
        </div>
    );
};

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
export const DataRow = ({
    label,
    children,
}: {
    label: React.ReactNode;
    children: React.ReactNode;
}) => (
    <div className="flex justify-between gap-3">
        <dt className="text-muted shrink-0">{label}</dt>
        <dd className="text-fg text-right tabular-nums min-w-0 truncate">{children}</dd>
    </div>
);

export interface TooltipProps {
    content: React.ReactNode;
    children: React.ReactNode;
    className?: string;
    /** "bottom-end" hangs below the anchor, right-aligned; for triggers near the top-right edge. */
    placement?: "top" | "bottom-end";
    /** Skips focus and tap-to-toggle, for triggers inside a clickable parent that taps should reach. */
    hoverOnly?: boolean;
    stopPropagation?: boolean;
}

/** How long after a tap the browser's emulated mouseenter and focus can still arrive. */
const TOUCH_ECHO_MS = 700;
/** Pixels between a tooltip and its anchor, and the minimum between a tooltip and the viewport edge. */
const TOOLTIP_GAP = 6;
const TOOLTIP_EDGE = 8;

export const Tooltip = ({
    content,
    children,
    className = "",
    placement = "top",
    hoverOnly = false,
    stopPropagation = false,
}: TooltipProps) => {
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
    const triggerRef = useRef<HTMLSpanElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const lastTouchAt = useRef(-Infinity);

    const hide = () => setAnchor(null);
    // A tap toggles the tooltip itself, so the emulated hover and focus that follow it are ignored.
    const show = (e: React.SyntheticEvent<HTMLSpanElement>) => {
        if (performance.now() - lastTouchAt.current < TOUCH_ECHO_MS) return;
        setAnchor(e.currentTarget.getBoundingClientRect());
    };
    const toggleOnTouch = (e: React.PointerEvent<HTMLSpanElement>) => {
        if (e.pointerType !== "touch") return;
        lastTouchAt.current = performance.now();
        setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect());
    };

    useEffect(() => {
        if (!anchor) return;
        const hideOnOutsidePress = (e: PointerEvent) => {
            if (!triggerRef.current?.contains(e.target as Node)) hide();
        };
        // Fixed positioning goes stale once the page scrolls.
        window.addEventListener("scroll", hide, true);
        document.addEventListener("pointerdown", hideOnOutsidePress);
        return () => {
            window.removeEventListener("scroll", hide, true);
            document.removeEventListener("pointerdown", hideOnOutsidePress);
        };
    }, [anchor]);

    // Measured after render so the tooltip can be clamped inside the viewport before paint.
    useLayoutEffect(() => {
        const tooltip = tooltipRef.current;
        if (!anchor || !tooltip) {
            setPosition(null);
            return;
        }
        const { width, height } = tooltip.getBoundingClientRect();
        const viewportWidth = document.documentElement.clientWidth;
        const idealLeft =
            placement === "top" ? anchor.left + anchor.width / 2 - width / 2 : anchor.right - width;
        const left = Math.max(TOOLTIP_EDGE, Math.min(idealLeft, viewportWidth - width - TOOLTIP_EDGE));
        const above = anchor.top - TOOLTIP_GAP - height;
        const below = anchor.bottom + TOOLTIP_GAP;
        setPosition({ left, top: placement === "top" && above >= TOOLTIP_EDGE ? above : below });
    }, [anchor, placement, content]);

    return (
        <>
            <span
                ref={triggerRef}
                tabIndex={hoverOnly ? undefined : 0}
                onPointerDown={(e) => {
                    if (stopPropagation) e.stopPropagation();
                    if (!hoverOnly) toggleOnTouch(e);
                }}
                onClick={
                    stopPropagation
                        ? (e) => {
                              e.stopPropagation();
                          }
                        : undefined
                }
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={hoverOnly ? undefined : show}
                onBlur={hoverOnly ? undefined : hide}
                className={`${hoverOnly ? "" : "cursor-help focus-visible:outline-2 focus-visible:outline-accent"} ${className}`}
            >
                {children}
            </span>
            {anchor &&
                createPortal(
                    <Card
                        ref={tooltipRef}
                        role="tooltip"
                        style={position ?? { left: 0, top: 0, visibility: "hidden" }}
                        className="fixed z-50 w-max max-w-[min(20rem,calc(100vw-16px))] pointer-events-none whitespace-pre-line text-left px-2 py-1.5 text-fg text-xs font-mono shadow-md"
                    >
                        {content}
                    </Card>,
                    document.body
                )}
        </>
    );
};

const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
    open: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    children: React.ReactNode;
}

export const Modal = ({ open, onClose, title, children }: ModalProps) => {
    const dialogRef = useRef<HTMLDivElement>(null);
    const titleId = useId();

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
                return;
            }
            const dialog = dialogRef.current;
            if (e.key !== "Tab" || !dialog) return;
            const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE);
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (!first) {
                e.preventDefault();
            } else if (e.shiftKey && (active === first || active === dialog)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [open, onClose]);

    useEffect(() => {
        if (!open) return;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = prevOverflow;
        };
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const opener = document.activeElement as HTMLElement | null;
        dialogRef.current?.focus();
        return () => opener?.focus();
    }, [open]);

    if (!open) return null;

    return createPortal(
        <div
            onClick={(e) => {
                if (e.target === e.currentTarget) {
                    onClose();
                }
            }}
            className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 sm:p-6"
        >
            <Card
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? titleId : undefined}
                tabIndex={-1}
                className="w-full max-w-2xl max-h-[85vh] supports-[height:100dvh]:max-h-[85dvh] flex flex-col shadow-2xl focus:outline-hidden"
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-line shrink-0">
                    <div id={titleId} className="text-sm font-semibold text-fg truncate">
                        {title}
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="text-muted hover:text-fg cursor-pointer p-1 rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                    >
                        <svg
                            className="w-4 h-4"
                            viewBox="0 0 20 20"
                            fill="currentColor"
                            aria-hidden="true"
                        >
                            <path
                                fillRule="evenodd"
                                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                                clipRule="evenodd"
                            />
                        </svg>
                    </button>
                </div>
                <div className="p-4 sm:p-5 overflow-y-auto">
                    {children}
                </div>
            </Card>
        </div>,
        document.body
    );
};
