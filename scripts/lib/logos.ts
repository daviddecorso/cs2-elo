export interface LogoEntry {
    slug: string;
    hasDark: boolean;
}

export type LogoManifest = Record<string, LogoEntry>;

export interface RawTemplate {
    page?: string;
    name?: string;
    template?: string;
    image?: string;
    imagedark?: string;
    imageurl?: string;
    imagedarkurl?: string;
}

export const teamSlug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

export const isDefaultLogo = (tmpl: RawTemplate): boolean => {
    const img = (tmpl.image ?? "").toLowerCase();
    const url = (tmpl.imageurl ?? "").toLowerCase();
    return img.includes("default") || url.includes("default");
};
