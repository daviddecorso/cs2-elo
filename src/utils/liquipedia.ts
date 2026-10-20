export const liquipediaUrl = (page: string) => `https://liquipedia.net/counterstrike/${encodeURIComponent(page.replace(/ /g, "_"))}`;
