import path from "node:path";
import { getNetworkRequestCount } from "./lib/liquipedia/client.ts";
import { fetchUpcoming } from "./lib/liquipedia/upcoming.ts";
import { loadEventConfigs } from "./lib/sim/config.ts";

const flag = process.argv.indexOf("--discover");
const discover = flag >= 0 ? (process.argv[flag + 1] ?? "").split(",").filter(Boolean) : [];
const parents = [...new Set([...loadEventConfigs().map((c) => c.liquipedia), ...discover])];
const today = new Date().toISOString().slice(0, 10);

fetchUpcoming(path.resolve("data/raw"), today, parents)
    .then(() => console.log(`${getNetworkRequestCount()} API requests.`))
    .catch((err) => {
        console.error("fetch-upcoming failed:", err);
        process.exit(1);
    });
