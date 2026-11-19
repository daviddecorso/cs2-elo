/** Team pages are keyed by Liquipedia page name, written the way Liquipedia's own URLs are. */
export const teamPath = (team: string) => `/teams/${encodeURIComponent(team.replace(/ /g, "_"))}`;

/** Inverse of `teamPath` for a router param, which React Router has already URI-decoded. */
export const teamFromParam = (param: string) => param.replace(/_/g, " ");
