# Liquipedia API v3

Base URL: `https://api.liquipedia.net/api/v3`. The OpenAPI spec and full docs (`/api/v3/openapi`, `/documentation/api/v3`) need a logged-in dashboard session and return 403 to API-key requests. This file is transcribed from the dashboard.

## Requests

All endpoints are `GET`. Required headers:

```
Authorization: Apikey $LIQUIPEDIA_API_KEY
User-Agent: cs2-elo (github.com/daviddecorso/cs2-elo)
Accept-Encoding: gzip
```

Example:

```bash
curl --compressed -H "Authorization: Apikey $LIQUIPEDIA_API_KEY" \
  'https://api.liquipedia.net/api/v3/team?wiki=counterstrike&limit=1&query=pagename,name'
# {"result":[{"pagename":"Team_Curse.EU","name":"Team Curse.EU","wiki":"counterstrike"}]}
```

## Common query parameters

These apply to every table endpoint. `teamtemplate` and `teamtemplatelist` take different parameters, listed below.

| Param | Required | Example | Notes |
| --- | --- | --- | --- |
| `wiki` | yes | `counterstrike` | Pipe-separate multiple wikis for multiwiki requests |
| `conditions` | no | `[[pagename::Some/Page]] AND [[namespace::0]]` | Filters |
| `query` | no | `pagename, pageid, namespace` | Fields to return |
| `limit` | no | `20` | |
| `offset` | no | `20` | Pagination |
| `order` | no | `pagename ASC` | |
| `groupby` | no | `pagename ASC` | For aggregate functions |

## Endpoints

| Path | Table | Extra params |
| --- | --- | --- |
| `/broadcasters` | broadcasters | |
| `/company` | company | |
| `/datapoint` | datapoint (wiki-specific, unstructured) | |
| `/externalmedialink` | externalmedialink | |
| `/match` | match2 | `rawstreams`, `streamurls` (`true`/`false`, default `false`) |
| `/placement` | placement | |
| `/player` | player | |
| `/series` | series | |
| `/squadplayer` | squadplayer | |
| `/standingsentry` | standing entries | |
| `/standingstable` | standing table | |
| `/team` | team | |
| `/tournament` | tournament | |
| `/transfer` | transfer | |
| `/teamtemplate` | single team template | `wiki`, `template` (e.g. `teamliquid`) required; `date` (`YYYY-MM-DD`) for historical logos |
| `/teamtemplatelist` | team templates, 200 per page | `wiki` required; `pagination` (page number) |

## Responses

| Code | Meaning | Body |
| --- | --- | --- |
| 200 | Success (may include warnings) | `{"result": [...]}` |
| 403 | Invalid API key | `{"error": ["..."]}` |
| 404 | Data does not exist | `{"error": ["..."]}` |
| 429 | Over API limit | `{"error": ["..."]}` |

The response body can have three keys:

- `result`: array of row objects, empty on invalid requests.
- `error` (optional): array of strings explaining what went wrong.
- `warning` (optional): array of strings for non-fatal issues, such as deprecations or failures to read some page. If warnings keep appearing unexpectedly, Liquipedia asks to be told.

Behavior to handle:

- Results can contain duplicates. Dedupe them in code or use a `groupby`.
- In multiwiki requests, `limit`, `offset`, `order` and `groupby` apply to each wiki separately.

## Rate limits

Limits are hourly and per wiki and table. The 429 error reads `API key "<key>" limits for wiki "counterstrike" and table "match" exceeded.`, so it **echoes the full API key**, and the client redacts it. The exact quota isn't published on the dashboard. On 2026-10-19, two CI runs plus two local fetches of the full 190-day window (about 55 requests each, mostly `/match` and `/placement`) within ten minutes exceeded the `match` table limit.

`scripts/fetch-liquipedia.ts` keeps a local store in `data/raw/` with a `meta.json` recording its window and the date of its last full refresh. A normal run refetches only the last 14 days, plus any part of the requested window the store doesn't cover. It does a full refresh weekly or with `--full`. Fetched ranges replace stored rows, so edits and deletions carry over. Pages are requested with `order=objectname ASC` so offset pagination stays stable. The nightly workflow persists `data/raw/` with `actions/cache`.

## Fields

Field lists come from the full documentation on the dashboard. Tables not listed here haven't been transcribed yet.

### `/match` (match2)

| Field | Type |
| --- | --- |
| `pageid` | number |
| `pagename` | string |
| `namespace` | number |
| `objectname` | string |
| `match2id` | string |
| `match2bracketid` | string |
| `status` | string |
| `winner` | string |
| `walkover` | string |
| `resulttype` | string |
| `finished` | boolean |
| `mode` | string |
| `type` | string |
| `section` | string |
| `game` | string |
| `patch` | string |
| `links` | json |
| `bestof` | number |
| `date` | exactdate |
| `dateexact` | boolean |
| `stream` | json |
| `vod` | string |
| `tournament` | string |
| `parent` | string |
| `tickername` | string |
| `shortname` | string |
| `series` | string |
| `icon` | string |
| `iconurl` | string |
| `icondark` | string |
| `icondarkurl` | string |
| `liquipediatier` | string |
| `liquipediatiertype` | string |
| `publishertier` | string |
| `extradata` | json |
| `match2bracketdata` | json |
| `match2games` | json |
| `match2opponents` | json |

#### Observed shapes

Taken from one real response: FURIA 3–2 BetBoom Team, Thunderpick World Championship 2026 playoffs, 2026-10-18. Fields that weren't populated in that match may have other shapes.

Types differ from the documented ones in a few places:

- `finished` and `dateexact` come back as `1`/`0`, not `true`/`false`.
- `winner` is a string opponent index (`"1"`, `"2"`), not a number.
- An empty json field is `[]`, not `{}` (e.g. `extradata` on opponents and players).
- `date` is `"YYYY-MM-DD HH:MM:SS"` in UTC. `extradata.timestamp` is the same moment in Unix seconds.

Top-level match fields:

- `pagename` is the tournament page. `match2id` is `<match2bracketid>_R<round>-M<match>`, and it's unique within a page.
- `liquipediatier` is a string (`"1"`). `publishertier` is free text (`"Tier 1"`).
- `game` is `"cs2"` for CS2 matches. The counterstrike wiki also holds older games, so filter on it.
- `extradata` has `featured`, `hidden`, `overturned`, `timestamp`, `timezoneid`, `timezoneoffset`.
- `links.stats[n]["1"]` is the HLTV map-stats URL for map `n`. `links.hltv["1"]["1"]` is the HLTV match URL.
- `match2bracketdata` holds the bracket position: `bracketType`, `bracketsection`, `coordinates`, and the ids of adjacent matches in the bracket.

`match2opponents` is an array with one entry per side, in opponent order:

```json
{
  "id": 1, "type": "team", "name": "BetBoom Team", "template": "betboom team 2024",
  "score": 2, "status": "S", "placement": 2,
  "match2players": [{ "id": 1, "opid": 1, "name": "S1ren", "displayname": "s1ren", "flag": "Russia", "extradata": [] }],
  "teamtemplate": { "template": "...", "page": "BetBoom Team", "name": "BetBoom Team", "shortname": "BB", "imageurl": "...", "imagedarkurl": "..." }
}
```

- `score` is maps won in a series.
- `status` `"S"` means a normal score.
- `placement` `1` is the winner.
- `teamtemplate.page` is the team's wiki page name, the stable key for the team. `template` is versioned (`"... 2024"`) and changes when the team rebrands.

`match2games` is an array with one entry per map:

```json
{
  "map": "Dust II", "match2gameid": 1, "winner": "2", "scores": [6, 13],
  "opponents": [{ "status": "S", "score": 6 }, { "status": "S", "score": 13 }],
  "participants": [], "length": "", "vod": "", "date": "2026-10-18 15:55:00",
  "extradata": {
    "t1halfs": { "1": 4, "2": 2 }, "t2halfs": { "1": 8, "2": 5 },
    "t1sides": { "1": "ct", "2": "t" }, "t2sides": { "1": "t", "2": "ct" },
    "timestamp": 1792338900, "dateexact": true
  }
}
```

- `scores` is rounds won on that map.
- `t1halfs`/`t2halfs` are rounds per half. Overtime adds more halves: a 19–16 map had keys `1` through `6`.
- `t1sides`/`t2sides` give the side each team played in each half.
- `participants` (per-player stats) and `length` were empty in this sample.

#### Forfeits

Taken from G2 Esports vs FaZe Clan, ESL Pro League Season 22 Stage 2, 2025-10-04. FaZe forfeited because they couldn't field an eligible lineup.

| Field | Normal match | Forfeit |
| --- | --- | --- |
| `walkover` | `""` | `"ff"` |
| `resulttype` | `""` | `"default"` |
| `finished` | `1` | `1` |
| `winner` | `"1"`/`"2"` | `"1"`/`"2"` |
| opponent `status` | `"S"` | `"W"` for the winner, `"FF"` for the forfeiting side |
| opponent `score` | maps won | `-1` for both sides |
| `match2games` | one entry per map | `[]` |

- A forfeit still counts as finished and still has a winner. To skip forfeits, check `walkover`/`resulttype`, not `finished`.
- `extradata.comment` holds the explanation as raw wikitext with unrendered ref markers. Don't display it as-is.
- The query `conditions=[[walkover::!]]` (`!` means not empty) returns only matches with a walkover set.

The format of `stream` depends on the `streamurls` and `rawstreams` parameters:

| `streamurls` | `rawstreams` | `stream` contains |
| --- | --- | --- |
| `false` | `false` | Liquipedia stream names (default) |
| `true` | `false` | Links to Liquipedia stream pages |
| `true` | `true` | Links to the provider's own page. Supported providers: Afreeca TV, Bilibili, BOOYAH!, CC, Douyu TV, Facebook, huya.com, Mildom, Trovo, Twitch |
| `false` | `true` | Provider stream IDs, e.g. for embedding |

### `/tournament`

| Field | Type |
| --- | --- |
| `pageid` | number |
| `pagename` | string |
| `namespace` | number |
| `objectname` | string |
| `name` | string |
| `shortname` | string |
| `tickername` | string |
| `banner` | string |
| `bannerurl` | string |
| `bannerdark` | string |
| `bannerdarkurl` | string |
| `icon` | string |
| `iconurl` | string |
| `icondark` | string |
| `icondarkurl` | string |
| `seriespage` | string |
| `serieslist` | json |
| `previous` | string |
| `previous2` | string |
| `next` | string |
| `next2` | string |
| `game` | string |
| `mode` | string |
| `patch` | string |
| `endpatch` | string |
| `type` | string |
| `organizers` | string |
| `startdate` | date |
| `enddate` | date |
| `sortdate` | date |
| `locations` | json |
| `prizepool` | number |
| `participantsnumber` | number |
| `liquipediatier` | string |
| `liquipediatiertype` | string |
| `publishertier` | string |
| `status` | string |
| `maps` | string |
| `format` | string |
| `sponsors` | string |
| `extradata` | json |

## Probed Findings

- **Valve-ranked event marking**: `publishertier` on `/tournament` (and `/match`) marks Valve-ranked events (`"Major Championship"`, `"Tier 1"`, `"Tier 1 Qualifier"`, `"Tier 2"`, `"Tier 2 Qualifier"`, `"Wildcard"`). Tournaments with an empty `publishertier` (`""`) are unranked. Tournament `extradata` only contains `startdatetext`, `enddatetext`, and sometimes `series2`.
- **`/placement` prize rows and qualification links**: `/placement` exposes per-team prize rows keyed by `opponenttemplate` (and `opponentname`), with `prizemoney` in numeric USD. Structured next-event or `qualifiedEvents` links are not directly exposed in `/placement` (`qualifier`, `qualifierpage`, and `qualifierurl` contain human-readable names or URLs rather than parent/child event IDs).
- **`match2players` accuracy with stand-ins**: `match2players` on `/match` accurately reflects the lineup that actually played on the server, including stand-ins. Verified against Valve 2026-10-05 details file match ID 3555 (IEM Cologne 2026 Stage 3, Legacy vs G2), where Legacy fielded `saadzin` (stand-in for `try`) and G2 fielded `SunPayus` (stand-in).

