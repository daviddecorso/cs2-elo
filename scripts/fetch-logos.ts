import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { isDefaultLogo, teamSlug, type LogoManifest, type RawTemplate } from "./lib/logos.ts";

const USER_AGENT = "cs2-elo (github.com/daviddecorso/cs2-elo)";
const LOGOS_DIR = path.resolve(process.cwd(), "public/logos");
const MANIFEST_PATH = path.resolve(process.cwd(), "public/data/logos.json");
const MATCHES_PATH = path.resolve(process.cwd(), "data/raw/matches.json");
const ELO_PATH = path.resolve(process.cwd(), "public/data/elo/latest.json");
const VRS_PATH = path.resolve(process.cwd(), "public/data/vrs/latest.json");
const VRS_MAP_PATH = path.resolve(process.cwd(), "data/elo/vrsTeamMap.json");
const OVERRIDES_PATH = path.resolve(process.cwd(), "data/overrides.json");
const SIM_EVENTS_DIR = path.resolve(process.cwd(), "public/data/sim/events");

const parseArgs = () => {
    const args = process.argv.slice(2);
    let dryRun = false;
    let limit: number | null = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--dry-run") dryRun = true;
        else if (args[i] === "--limit" && args[i + 1]) limit = Number(args[++i]);
    }
    return { dryRun, limit };
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchAndSave = async (url: string, outPath: string): Promise<boolean> => {
    if (fs.existsSync(outPath)) return true;
    try {
        const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        if (!res.ok) {
            console.warn(`Failed to fetch ${url}: HTTP ${res.status}`);
            return false;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        await sharp(buffer).resize(64, 64, { fit: "inside" }).webp({ quality: 80 }).toFile(outPath);
        return true;
    } catch (err) {
        console.warn(`Error processing ${url}:`, err instanceof Error ? err.message : err);
        return false;
    }
};

const main = async () => {
    const { dryRun, limit } = parseArgs();

    if (!fs.existsSync(MATCHES_PATH)) {
        console.error("data/raw/matches.json does not exist. Run fetch-liquipedia first.");
        process.exit(1);
    }

    fs.mkdirSync(LOGOS_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });

    // Invert VRS team mappings to map VRS teamName <-> Liquipedia team page
    const vrsToLiq = new Map<string, string>();
    const liqToVrs = new Map<string, string>();
    if (fs.existsSync(VRS_MAP_PATH)) {
        const teamMap = JSON.parse(fs.readFileSync(VRS_MAP_PATH, "utf8")) as Record<string, { vrsTeam?: string }>;
        for (const [liq, obj] of Object.entries(teamMap)) {
            if (obj.vrsTeam) {
                vrsToLiq.set(obj.vrsTeam, liq);
                liqToVrs.set(liq, obj.vrsTeam);
            }
        }
    }
    if (fs.existsSync(OVERRIDES_PATH)) {
        const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8")) as {
            teamAliases?: Record<string, { targetTeamId?: string }>;
        };
        for (const [liq, obj] of Object.entries(overrides.teamAliases ?? {})) {
            if (obj.targetTeamId) {
                vrsToLiq.set(obj.targetTeamId, liq);
                liqToVrs.set(liq, obj.targetTeamId);
            }
        }
    }

    // Index all team templates from matches.json in reverse chronological order
    const rawMatches = JSON.parse(fs.readFileSync(MATCHES_PATH, "utf8")) as Array<{
        match2opponents?: Array<{
            name?: string;
            teamtemplate?: RawTemplate;
        }>;
    }>;

    const templates = new Map<string, RawTemplate>();
    for (let i = rawMatches.length - 1; i >= 0; i--) {
        const m = rawMatches[i];
        for (const opp of m.match2opponents ?? []) {
            const tmpl = opp.teamtemplate;
            if (!tmpl || !tmpl.imageurl) continue;
            if (isDefaultLogo(tmpl)) continue;
            if (tmpl.page && !templates.has(tmpl.page)) templates.set(tmpl.page, tmpl);
            if (opp.name && !templates.has(opp.name)) templates.set(opp.name, tmpl);
            if (tmpl.name && !templates.has(tmpl.name)) templates.set(tmpl.name, tmpl);
        }
    }

    // Collect all active target teams
    const teamsToProcess = new Set<string>();

    if (fs.existsSync(ELO_PATH)) {
        const elo = JSON.parse(fs.readFileSync(ELO_PATH, "utf8")) as { rosters: Array<{ team: string }> };
        for (const r of elo.rosters) teamsToProcess.add(r.team);
    }

    if (fs.existsSync(VRS_PATH)) {
        const vrs = JSON.parse(fs.readFileSync(VRS_PATH, "utf8")) as { rosters: Array<{ teamName: string }> };
        for (const r of vrs.rosters) teamsToProcess.add(r.teamName);
    }

    if (fs.existsSync(SIM_EVENTS_DIR)) {
        const eventFiles = fs.readdirSync(SIM_EVENTS_DIR).filter((f) => f.endsWith(".json"));
        for (const f of eventFiles) {
            try {
                const event = JSON.parse(fs.readFileSync(path.join(SIM_EVENTS_DIR, f), "utf8")) as {
                    teams?: Array<{ team: string }>;
                };
                for (const t of event.teams ?? []) teamsToProcess.add(t.team);
            } catch {
                // Ignore invalid or empty sim event files
            }
        }
    }

    const teamList = limit ? Array.from(teamsToProcess).slice(0, limit) : Array.from(teamsToProcess);
    console.log(`Processing logos for ${teamList.length} active teams...`);

    // Load existing manifest if present to preserve known mappings
    const manifest: LogoManifest = fs.existsSync(MANIFEST_PATH)
        ? (JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as LogoManifest)
        : {};

    type DownloadTask = { url: string; outPath: string };
    const downloadQueue: DownloadTask[] = [];

    const assignAlias = (name: string, entry: { slug: string; hasDark: boolean }) => {
        manifest[name] = entry;
        if (name.startsWith("Team ")) {
            manifest[name.slice(5)] = entry;
        } else {
            manifest[`Team ${name}`] = entry;
        }
    };

    for (const team of teamList) {
        const mappedLiq = vrsToLiq.get(team);
        const mappedVrs = liqToVrs.get(team);
        const tmpl =
            templates.get(team) ||
            (mappedLiq ? templates.get(mappedLiq) : undefined) ||
            (mappedVrs ? templates.get(mappedVrs) : undefined) ||
            templates.get(team.replace(/^Team\s+/i, "")) ||
            templates.get(`Team ${team}`);

        if (!tmpl || !tmpl.imageurl) continue;

        const canonicalName = tmpl.page || tmpl.name || team;
        const slug = teamSlug(canonicalName);
        if (!slug) continue;

        const hasDark = Boolean(tmpl.imagedarkurl && tmpl.imagedarkurl !== tmpl.imageurl);
        const entry = { slug, hasDark };

        assignAlias(team, entry);
        if (canonicalName) assignAlias(canonicalName, entry);
        if (mappedLiq) assignAlias(mappedLiq, entry);
        if (mappedVrs) assignAlias(mappedVrs, entry);
        if (tmpl.page) assignAlias(tmpl.page, entry);
        if (tmpl.name) assignAlias(tmpl.name, entry);

        const lightOut = path.join(LOGOS_DIR, `${slug}.webp`);
        if (!fs.existsSync(lightOut)) {
            downloadQueue.push({ url: tmpl.imageurl, outPath: lightOut });
        }

        if (hasDark && tmpl.imagedarkurl) {
            const darkOut = path.join(LOGOS_DIR, `${slug}-dark.webp`);
            if (!fs.existsSync(darkOut)) {
                downloadQueue.push({ url: tmpl.imagedarkurl, outPath: darkOut });
            }
        }
    }

    // Deduplicate download queue by outPath
    const uniqueTasks = new Map<string, DownloadTask>();
    for (const task of downloadQueue) {
        uniqueTasks.set(task.outPath, task);
    }
    const tasks = Array.from(uniqueTasks.values());

    console.log(`Found ${Object.keys(manifest).length} team mappings. ${tasks.length} new logo files to download.`);

    if (dryRun) {
        console.log("Dry run: skipping downloads and manifest save.");
        return;
    }

    let completed = 0;
    const CONCURRENCY = 4;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.all(
            batch.map(async (task) => {
                await fetchAndSave(task.url, task.outPath);
                completed++;
                if (completed % 25 === 0 || completed === tasks.length) {
                    process.stdout.write(`Downloaded ${completed}/${tasks.length} logos...\r`);
                }
            })
        );
        await delay(50);
    }
    if (tasks.length > 0) console.log();

    // Sort manifest alphabetically
    const sortedManifest = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(sortedManifest, null, 2)}\n`);
    console.log(`Wrote ${Object.keys(sortedManifest).length} team logo entries to ${MANIFEST_PATH}`);
};

main().catch((err) => {
    console.error("fetch-logos failed:", err);
    process.exit(1);
});
