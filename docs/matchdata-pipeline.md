# Matchdata pipeline

## Overview

Valve's model reads a `matchdata.json` built from HLTV data, and Valve doesn't publish it. We rebuild it from the Liquipedia API. `scripts/fetch-liquipedia.ts` caches raw API rows in `data/raw/`. `scripts/lib/vrs/buildMatchdata.ts` (CLI: `scripts/build-matchdata.ts`) maps them to the schema in [valve-model.md](valve-model.md) §6, applies HLTV-coverage rules and `data/overrides.json`, and validates the result with `validateMatchdata`.

## Decisions

- **Liquipedia API is the source.** Valve's input is HLTV data (per the footer of every details file), and Valve's repo ships no current input data. Scraping HLTV or liquipedia.net HTML is ruled out: it gets the IP banned and revokes API access (`AGENTS.md`).
- **Raw Liquipedia data won't match Valve exactly.** HLTV and Liquipedia disagree on stand-ins, forfeits, which events count as ranked, club share, and how events are split. Generic rules close most of the gap, and a committed override file with a `reason` on every entry closes the rest.
- **Valve's model code is never modified.** All fixes go in the input data or in our wrapper.
- **Built matchdata is not committed.** CI uploads it as a workflow artifact. `data/overrides.json` is committed.
- **Event `finished` is decided per snapshot, not at build time.** Events carry `endDate`. `computeStandings` marks an event unfinished if it ends after the snapshot date or has matches after the snapshot's pull time. One matchdata file built today can therefore be verified against any past snapshot.

## Field mapping

| Valve field | Liquipedia source |
| --- | --- |
| `teamId` (matches and `prizeDistribution`) | team page name (`opponentname`, else template) |
| `playerId` | player page name |
| `countryIso` | player `flag`, else `nationality`/`nationality2` from `/player`, mapped to ISO2 through `COUNTRY_MAP` |
| `matchStartTime` | `extradata.timestamp`, else `date` as UTC |
| `winningTeam` | `winner` |
| `forfeited` | `walkover === "ff"` |
| `eventId` | tournament page, rolled up to `parent` |
| `prizePool` | tournament `prizepool`, formatted `"$N"` |
| `lan` | tournament `type === "offline"` |
| `prize` | placement `prizemoney` |
| `clubShare`, `qualifiedEvents` | always `0` and `[]` today (see [roadmap.md](roadmap.md), factor gaps) |

## HLTV-coverage rules

These imitate what HLTV, and therefore Valve, does and doesn't track:

- **`valveRanked`** is true when the tournament or match has a `publishertier`. `rankedEvents` and `unrankedEvents` in the overrides force it either way.
- **Untracked qualifiers.** Bo1 bracket matches are unranked when their round has more than 8 matches, or when the publisher tier is `Tier 2 Qualifier`. Neither kind appears in Valve's details files.
- **Lineups (`resolveLineups`).** Liquipedia lists everyone who played in a series, which can be 6+ players after a substitution, and sometimes fewer than 5. HLTV always has exactly 5. Over-full lineups keep the 5 players seen most often in the team's 5-player lineups within ±21 days. Short lineups are filled from the same pool. A match that can't be resolved to 5 is dropped.
- **Unmapped countries.** A match with a player whose country can't be mapped is dropped with a warning, rather than failing the whole build. Fix it with a `playerAliases` `countryIso` override.

## Overrides

`data/overrides.json` categories (types in `Overrides` in `buildMatchdata.ts`): `rankedEvents`, `unrankedEvents`, `eventRollups`, `eventOverrides`, `teamAliases`, `playerAliases`, `matchLineupFixes`, `prizeDistributionOverrides`, `excludedMatches`, `addedMatches`. Every entry needs a `reason`.

Rule: an override is allowed only if it improves the gate on every calibrated snapshot ([vrs-verification.md](vrs-verification.md)). An override that fixes one snapshot and hurts another is overfit.

## Identity

Liquipedia page names are the stable team and player IDs. Valve matches rosters by player ID (3 of 5 overlap) but keys active-roster counts by nick (quirk 3 in [valve-model.md](valve-model.md)), so display names matter to the VRS output.

Known debt: the 815 `teamAliases` and 1,015 `playerAliases` were generated automatically from the 5 Oct details files. They rename page names to Valve's display names, and their reasons say only "Aligned with N matches". A nick that Valve renamed after 5 Oct will diverge. Aliases must stay inside the VRS projection. Elo keys on page names.
