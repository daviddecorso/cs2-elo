/** Player pages are keyed by the in-game name from the demos, which is unique across published players. */
export const playerPath = (name: string) => `/players/${encodeURIComponent(name)}`;
