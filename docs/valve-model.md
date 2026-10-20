# Valve Regional Standings (VRS) Model Specification

This document details the mechanics, execution model, published file structure, quirks, and exact input data schema for Valve's Counter-Strike 2 Regional Standings model (`vendor/counter-strike_regional_standings` at commit `eec4853`). For how we run it per snapshot and verify the output, see [vrs-verification.md](vrs-verification.md).

---

## 1. Execution & Entry Points

### CLI Execution
Valve's model is written in CommonJS Node.js with no external npm dependencies:
```bash
cd vendor/counter-strike_regional_standings/model
node main.js '[0,1,2]' ../data/matchdata.json 2026_10_05
```

- Argument 1 (`regions`): JSON array of region indices (`0` = Europe, `1` = Americas, `2` = Asia). Default: `[0,1,2]`.
- Argument 2 (`dataFile`): Relative or absolute path to `matchdata.json`. Default: `../data/matchdata.json`.
- Argument 3 (`dateLabel`): String date stamp formatted as `YYYY_MM_DD`. If omitted, derived from the latest match timestamp in `America/Los_Angeles`.

### Output File Structure
- `live/<YYYY>/standings_global_<YYYY_MM_DD>.md`
- `live/<YYYY>/standings_europe_<YYYY_MM_DD>.md`
- `live/<YYYY>/standings_americas_<YYYY_MM_DD>.md`
- `live/<YYYY>/standings_asia_<YYYY_MM_DD>.md`
- `live/<YYYY>/details/<YYYY_MM_DD>/<NNNN>--<team>--<roster>.md`
- If the day of month is 7 or earlier (e.g. `2026_10_05`), identical copies are written to `invitation/<YYYY>/`.

### Module API
`model/ranking.js` exports:
```javascript
const [matches, teams] = Ranking.generateRanking(versionTimestamp = -1, filename);
```
- `versionTimestamp`: Optional end-of-window timestamp filter in seconds. Passing `-1` uses the maximum `matchStartTime` in the dataset.
- `filename`: Path to `matchdata.json`.

---

## 2. Two-Stage Model Pipeline

### Stage 1: Seeding & Modifiers
1. **Match Filtering**:
   - Incomplete matches (`team1Players.length !== 5 || team2Players.length !== 5`) are discarded.
   - Matches starting on or after Unix timestamp `1735689600` (2025-01-01 00:00:00 UTC) require `match.valveRanked === true`. Earlier matches pass unconditionally.
   - Time window is 180 days (`6 * 30 * 24 * 3600 = 15,552,000` seconds). The window ends at `endTime` (latest match timestamp or `versionTimestamp`). Matches before `startTime = endTime - 180 days` or after `endTime` are dropped.
   - Age weighting: Grace period is 30 days (`30 * 24 * 3600 = 2,592,000` seconds). Matches within 30 days of `endTime` receive age weight `1.0`. Matches older than 30 days scale linearly down to `0.0` at `startTime`.
   - Event validation: Events marked `finished: false` are excluded along with all their matches. Event names containing `"showmatch"` (case-insensitive) are excluded.
   - Linked Qualifiers: If event A links to event B via `qualifiedEvents` and event B is finished, event A's prize pool increases by `prizePool(B) * (0.5 ^ depth)`, capped at $1,000,000 per event.
2. **Roster Tracking**:
   - Matches are processed in reverse chronological order (`matchStartTime` desc).
   - A team roster matches an existing team if at least 3 of 5 player IDs overlap (`TEAM_OVERLAP_TO_SHARE_ROSTER = 3`).
   - Active roster is established from the most recent 10 matches (see Quirks).
3. **Seeding Factors**:
   - **Bounty Offered**: Sum of top 10 age-scaled event prize winnings divided by the 5th-highest roster winnings across all teams, capped at 1.0, transformed by curve function:
     $$\text{curve}(x) = \frac{1}{1 + |\log_{10}(x)|}$$
   - **Opponent Network**: Sum of distinct opponents defeated (scaled by recency), divided by 5th-highest across all teams, capped at 1.0.
   - **LAN Factor**: Top 10 age-scaled LAN wins divided by 10, scaled against the 5th-highest across all teams, capped at 1.0.
   - **Bounty Collected**: Top 10 age- and prize-weighted opponent bounty values divided by 10, transformed by curve function. Event prize pool weight is $\text{curve}(\min(\text{prizePool}, 1000000) / 1000000)$.
   - Modifiers average:
     $$\text{seedValue} = \frac{\text{bountyOffered} + \text{bountyCollected} + \text{opponentNetwork} + \text{lanFactor}}{4}$$
   - Linear remapping: Min and max `seedValue` across all rosters map to $[400, 2000]$.

### Stage 2: Match Simulation (Glicko / Elo)
1. Glicko engine is configured with fixed RD = 75:
   $$RD = 75$$
2. Matches are sorted chronologically ascending (`matchStartTime` asc).
3. Each match executes `glicko.singleMatch(winner, loser, informationContent)`:
   - `informationContent` equals the age weight of the match.
4. Rosters with zero distinct wins (`distinctTeamsDefeated === 0`) are purged from standings (though they set seeding min/max).
5. Rosters with at least 5 matches played receive a global rank and regional rank. Rosters with fewer than 5 matches remain unranked.

---

## 3. Region Assignment

Region assignment is evaluated from the player nationalities in `activeRoster`:
- `countryIso` is mapped via `model/util/region.js`:
  - `EU` / `MENA` $\rightarrow 0$ (Europe)
  - `NA` / `SA` $\rightarrow 1$ (Americas)
  - `AF` $\rightarrow -1$ (Ignored / low priority)
  - All other mapped codes $\rightarrow 2$ (Asia)
- Priority order: Europe (3) > Americas (2) > Asia (1).
- The region with the plurality of active players is assigned. In the event of ties, higher regional priority breaks the tie.

---

## 4. Known Implementation Quirks

1. **`qualifiedEvents` Array Keying**:
   In `model/data_loader.js`, `teamJson.qualifiedEvents` (an array) is accumulated into `qualifiedEvents`, and `this.qualifiedEvents = qualifiedEvents[qualifiedEvents.length - 1]` can assign an array or integer depending on input nesting.
2. **`setActiveRoster` 10-Match Loop Bound**:
   `setActiveRoster()` iterates `for (let i = 0; i < matchCount; i++)` where `matchCount` is set in an `idx < 10` loop. Because of zero-indexing and strict inequality, a player whose most recent appearance was exactly the 10th match is omitted from consideration for the 5-player active roster.
3. **Nick vs ID Keying in Active Roster**:
   While team identity matches on `playerId`, `setActiveRoster` keys temporary player maps by `player.nick`. If a player changed nicks across matches on the same team, their match count splits across keys.

---

## 5. Data Availability Finding

Valve's repository ignores `data/` via `.gitignore`. The only tracked data file is `data/matchdata_sample_20230829.json`, an obsolete August 2023 schema lacking `finished`, `clubShare`, `qualifiedEvents`, and `valveRanked`. Running current model code against this sample crashes. Valve publishes output markdown files only and does not publish model input datasets.

---

## 6. Full `matchdata.json` Schema (Phase 2 Contract)

A valid `matchdata.json` file consists of a top-level object:
```json
{
  "matches": [...],
  "events": [...]
}
```

### Match Order & `umid` Assignment

Before initializing team entities, `DataLoader` sorts matches in reverse chronological order:
```javascript
sortMatches( matches, 'desc' ); // b.matchStartTime - a.matchStartTime
```
During `initTeams()`, each match is assigned a unique match index (`umid`) representing its index in this descending array:
```javascript
matches.forEach( (match, idx) => {
    match.umid = idx;
    ...
} );
```
This reverse-chronological pass ensures that a team's most recent match establishes its base roster. Earlier matches sharing $\ge 3$ player IDs are merged into this existing roster.

Once teams are initialized, matches are sorted into forward chronological order:
```javascript
sortMatches( matches, 'asc' ); // a.matchStartTime - b.matchStartTime
```
Rating updates and Glicko iterations then proceed forward in time.

### Match Object
| Field | Type | Description & Usage |
| --- | --- | --- |
| `matchStartTime` | number (integer) | Unix timestamp in seconds. Used for 180-day windowing and age decay. |
| `team1Id` | string \| number | Team identifier in source database. Links to `event.prizeDistribution[].teamId`. Passed to `recordEventParticipation(events[match.eventId], match.team1Id)` to award prize earnings (`prize + clubShare`). If unmapped or missing, winnings default to 0. |
| `team2Id` | string \| number | Team identifier in source database. Links to `event.prizeDistribution[].teamId`. Passed to `recordEventParticipation(events[match.eventId], match.team2Id)` to award prize earnings (`prize + clubShare`). If unmapped or missing, winnings default to 0. |
| `team1Name` | string | Display name of team 1. |
| `team2Name` | string | Display name of team 2. |
| `team1Players` | Player[] | Array of exactly 5 player objects for team 1. |
| `team2Players` | Player[] | Array of exactly 5 player objects for team 2. |
| `eventId` | string \| number | References `event.eventId`. Must resolve to an entry in `events`. |
| `winningTeam` | number | `1` if team 1 won, `2` if team 2 won. Any other value causes undefined behavior. |
| `valveRanked` | boolean (optional) | Required for matches with `matchStartTime >= 1735689600`. Must be `true` to be ranked. |
| `forfeited` | boolean (optional) | If `true`, team pending update flag is retained. |
| `maps` | array (optional) | Map breakdown (ignored by ranking calculations). |

### Player Object
| Field | Type | Description & Usage |
| --- | --- | --- |
| `playerId` | string \| number | Unique player identifier. Used for 3-of-5 roster identity matching. |
| `nick` | string | Player nickname. Used in active roster map and markdown display. |
| `countryIso` | string | Two-letter ISO country code (e.g. `"dk"`, `"br"`, `"ua"`). Must exist in `region.js`. |
| `country` | string (optional) | Full country name. |
| `steamIds` | array (optional) | Array of Steam IDs. |

### Event Object
| Field | Type | Description & Usage |
| --- | --- | --- |
| `eventId` | string \| number | Unique event identifier matching `match.eventId`. |
| `eventName` | string | Event title. If lowercase contains `"showmatch"`, all its matches are ignored. |
| `prizePool` | string | Dollar amount formatted as `"$500,000"` or integer string. Capped at $1,000,000. |
| `lan` | boolean | `true` if played on LAN; `false` if online. Affects LAN factor. |
| `finished` | boolean | Must be `true`. If `false`, all matches in event are dropped. |
| `prizeDistribution` | PrizeItem[] | List of team placements and earnings. |

### PrizeDistribution Object & `teamId` Link
Each event indexes `prizeDistribution` entries by `teamId`:
```javascript
eventJson.prizeDistribution.forEach( teamJson => {
    this.prizeDistributionByTeamId[teamJson.teamId] = new EventTeam( teamJson );
} );
```
When a roster participates in an event match via `match.team1Id` or `match.team2Id`, `recordEventParticipation` looks up `event.prizeDistributionByTeamId[teamId]`. If a matching entry exists, the team is credited with `prize + clubShare`; otherwise earnings are 0.

| Field | Type | Description & Usage |
| --- | --- | --- |
| `teamId` | string \| number | Unique team identifier matching `match.team1Id` or `match.team2Id` to link tournament earnings to the participating roster. |
| `placement` | number | Finishing placement in the tournament. |
| `prize` | number | Base prize money in USD. |
| `clubShare` | number | Organizational club share added to `prize`: total prize credited is `prize + clubShare`. |
| `shared` | boolean (optional) | Whether prize was shared. |
| `qualifiedEvents` | array | Array of qualified event IDs for linked prize pools. Empty array `[]` if none. |
