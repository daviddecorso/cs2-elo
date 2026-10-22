export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "icon";

export interface ButtonClassOptions {
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
}

export const buttonClasses = ({
    variant = "secondary",
    size = "md",
    className = "",
}: ButtonClassOptions = {}) => {
    const base =
        "inline-flex items-center justify-center font-medium rounded-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 disabled:opacity-50 disabled:pointer-events-none cursor-pointer";

    const variantStyles: Record<ButtonVariant, string> = {
        primary: "bg-accent text-white hover:opacity-90 active:opacity-100",
        secondary:
            "bg-surface text-fg border border-line hover:bg-surface-2 active:bg-surface-2",
        ghost: "bg-transparent text-fg hover:bg-surface-2 active:bg-surface-2",
    };

    const sizeStyles: Record<ButtonSize, string> = {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        icon: "h-8 w-8 text-xs",
    };

    return `${base} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`.trim();
};
