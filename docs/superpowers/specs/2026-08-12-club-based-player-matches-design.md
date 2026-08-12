# Club-Based `getPlayerMatches` — Design

**Date:** 2026-08-12
**Branch:** `searchClubs` (functions submodule)
**Status:** Approved — pending dev-environment verification

## Purpose

`getPlayerMatches` currently returns only the matches a player has personally enrolled
in, driven by rows in `test.player_match_map`. A player therefore cannot see a fixture
their club is playing until they have already been added to it.

Change the query to return **all matches the player's club is involved in**, given a
`clubId`, provided the player is a member of that club. Enrollment (`player_match_map`)
stops deciding which matches are *listed* and continues to decide only who is *playing*
in each one.

## Decisions

- **Club matching:** gated on `match_type` — `club_id` for `INTRA_CLUB`, `home_team` /
  `away_team` for `INTER_CLUB`. See the query in the Model section.

  **This decision was revised on 2026-08-12 after review.** The original spec called for
  an ungated `club_id = $1 OR home_team = $1 OR away_team = $1`. That is a **cross-club
  data leak**: for `INTRA_CLUB` matches, `createMatchModel` writes the real club to
  `club_id`, then `addTeamsToMatch` (`Mutations.js:55`) *overwrites* `home_team` /
  `away_team` with `test.temp_teams` IDs. `temp_teams.id` and `clubs.id` are independent
  sequences of small integers, so `home_team = $clubId` routinely compares a temp-team ID
  against a club ID and matches by coincidence. Club 7's intra-club match, whose temp
  teams are IDs 12 and 13, would be returned to any member of club 12 — along with club
  7's player names via the `playersHome` / `playersAway` resolvers.

  The `away_team` branch must be kept for `INTER_CLUB`. `createMatchModel`
  (`PlayModel.js:130`) writes `awayTeam || null`, so `away_team` holds the *invited club's*
  ID from creation onward — it is NULL only when a match was created with no opponent at
  all. The row's `club_id` is always the home club, so `away_team = $1` is the only thing
  that lets the invited club see the fixture.

  (An earlier draft of this spec claimed `away_team` stays NULL until an invitation is
  accepted. That was wrong; the conclusion is unchanged but the reason is as stated above.)
- **Match status:** rows with `match_status = 'MATCH_INVITATION_DECLINED'` are excluded.
  Under the old enrollment-scoped query only the organiser ever saw a declined invite;
  club-scoping would otherwise surface it to every member of both clubs as a permanent
  phantom fixture. Pending invites (`MATCH_AWAITING_OPPONENT_RESPONSE`) are **kept** —
  both clubs have a legitimate reason to see an invitation awaiting response.
- **Membership check:** enforced in the resolver via the existing `fetchPlayerClubMap`
  helper. A non-member gets an explicit error, not an empty list, so the client can
  distinguish "not your club" from "no matches yet".
- **`playerId` source:** stays an input argument, as today. Reading it from the JWT (as
  `getPlayerClubs` and `getPlayerAlertsForClub` do) is the more secure design and is
  noted as future work, but is out of scope here to keep the change focused.
- **`clubId` is required.** Pre-launch, so a breaking input change is acceptable and
  preferable to carrying two code paths indefinitely. Clients omitting it get a
  GraphQL validation error rather than silently wrong data.
- **Ordering:** `match_start_time ASC`, no time-window filter. Past and future matches
  are both returned; the client decides how to split them. Today's query is unordered,
  so this only removes nondeterminism.
- **Soft deletes:** filtered via `is_deleted IS NOT TRUE`. See Prerequisite below.

## Prerequisite (manual DDL — no migration system in this repo) — DONE

`test.matches` originally had no `is_deleted` column: the field existed on
`test.player_match_map` and `test.players` and was exposed on the `Match` GraphQL type,
but no column backed it. Added out-of-band on 2026-08-12:

```sql
ALTER TABLE test.matches ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
```

`IS NOT TRUE` (rather than `= false`) is used in the query so any pre-existing `NULL`
values behave as "not deleted".

## GraphQL API

In `graphql/schema/Play.js`:

```graphql
input playerMatchInput {
  playerId: Int!
  clubId: Int!      # new, required
}

getPlayerMatches(data: playerMatchInput!): [Match]
```

Return type is unchanged. `playerMatchInput` is used by no other query or mutation, so
the added field affects `getPlayerMatches` only.

## Resolver (`graphql/resolvers/Play/Queries.js`)

`getPlayerMatches(_obj, { data })`:

1. Throw `"Player ID is required"` if `playerId` is absent.
2. Throw `"Club ID is required"` if `clubId` is absent.
3. `await fetchPlayerClubMap(playerId, clubId)` — if the result is empty, throw
   `"Player is not a member of this club"`.
4. `await getClubMatchesFromDb(clubId)`.
5. Map each row through `mapMatchRow` (below) and return.
6. Database failures wrap as `"Failed to fetch club matches: " + error.message`,
   matching the existing error style.

`fetchPlayerClubMap` is already exported from `PlayModel.js` and already imported
elsewhere in the resolver layer; it needs adding to this file's import list.

### Shared row mapper

The 13-line snake_case → camelCase block is currently duplicated verbatim between
`getPlayerMatches` and `getMatchById`. Since `getPlayerMatches` is being rewritten,
extract it once:

```js
const mapMatchRow = (match) => ({
  ...match,
  matchStartTime: match.match_start_time,
  matchEndTime: match.match_end_time,
  matchType: match.match_type,
  paymentUpiId: match.payment_upi_id,
  paymentMode: match.payment_mode,
  entryAmount: match.entry_amount,
  matchStatus: match.match_status,
  homeTeamJerseyColor: match.home_team_jersey_color,
  awayTeamJerseyColor: match.away_team_jersey_color,
  matchFormat: match.format,
  homeTeamGoals: match.home_team_goals,
  awayTeamGoals: match.away_team_goals,
});
```

Used by both `getPlayerMatches` and `getMatchById`. Not exported — module-local.

## Model (`graphql/model/PlayModel.js`)

`getPlayerMatchesFromDb(playerId)` is replaced by `getClubMatchesFromDb(clubId)`:

```sql
SELECT *
FROM test.matches m
WHERE m.is_deleted IS NOT TRUE
  AND m.match_status IS DISTINCT FROM 'MATCH_INVITATION_DECLINED'
  AND (
    (m.match_type = 'INTRA_CLUB' AND m.club_id = $1)
    OR (m.match_type = 'INTER_CLUB' AND (m.home_team = $1 OR m.away_team = $1))
  )
ORDER BY m.match_start_time ASC
```

`IS DISTINCT FROM` rather than `<>` so rows with a `NULL` `match_status` are retained;
plain `<>` would evaluate to `NULL` and drop them.

The old function has no remaining callers once the resolver is updated, so it is removed
from both the module body and the exports rather than left dead.

## Match field resolvers — unchanged

The entire `Match` linkup is untouched: `venue`, `organiser`, `homeTeam`, `awayTeam`,
`playersHome`, `playersAway` and their DataLoaders all keep working as-is,
because the shape of the row passed to them is identical.

`playersHome` / `playersAway` continue to read `player_match_map`. This is intentional:
the match *list* is now club-scoped, but *enrollment within* a match is still per-player.
A club match with nobody enrolled yet correctly returns empty player arrays.

### Enrolled-players N+1: considered and rejected (2026-08-12)

A whole-change review flagged that `fetchEnrolledPlayers(matchId, teamId)` is a raw
`pool.query` run once per team per match, so a club-scoped list would cost `2 × matches`
un-batched queries. A batched per-request DataLoader was built, reviewed, and then
**reverted**.

The finding does not apply to how this API is actually used. GraphQL field resolvers are
lazy: `playersHome` / `playersAway` execute only when the client's selection set requests
them. The match-list screen requests match details and team names only, so those
resolvers never run and no enrollment query is issued. The detail screen (`getMatchById`)
does request players, but for a single match — two queries, with no sibling nodes for a
DataLoader to batch against.

The loader was therefore ~60 lines of machinery that never executed on either path, and
it carried real risk: a NULL `away_team` (normal for a pending invitation) parsed to
`NaN`, which `pg` serializes as the string `"NaN"`, failing the entire batch and with it
every player field in the request. It also introduced a latent `int8`/`bigint`
strict-comparison hazard. Reverting removed both.

**Revisit if** a list-style query ever selects `playersHome` / `playersAway` across many
matches — then the N+1 becomes live and the loader is the right fix.

## Behaviour change to expect

A player who is a club member now sees club matches they have **not** enrolled in —
that is the point of the change. Conversely, a match a player enrolled in for a club
they have since left, or a match belonging to a different club, no longer appears under
that `clubId`. Callers that previously showed "my matches" across all clubs must now
query per club.

## Error handling

| Condition | Result |
|---|---|
| `playerId` missing | `"Player ID is required"` |
| `clubId` missing | `"Club ID is required"` (schema rejects it first in practice) |
| Player not in club | `"Player is not a member of this club"` |
| Club has no matches | `[]` — not an error |
| Database failure | `"Failed to fetch club matches: …"` |

## Verification

No test harness exists in the repo (the suite was removed in `2533889`); verification is
manual against the dev environment. Confirm the `is_deleted` column exists first, then
check:

- Member of a club with inter-club matches where the club is **home** → returned
- Member of a club with inter-club matches where the club is **away** → returned
- Club with **intra-club** matches → returned (the `club_id` branch; this is the case
  most likely to regress)
- A match the player is **not** enrolled in → still listed, with empty or partial
  `playersHome` / `playersAway`
- Non-member `playerId` + `clubId` → membership error, not an empty array
- Club with no matches → empty array
- Results ordered by `match_start_time` ascending, past matches included
- `homeTeam` / `awayTeam` resolve correctly for both `INTER_CLUB` (club) and
  `INTRA_CLUB` (temp team) via the `TeamData` union
- `getMatchById` still returns identical output after the `mapMatchRow` extraction

Hold the commit until this passes on dev.

## Out of scope

- Moving `playerId` to the JWT (future hardening; would remove the ability to query on
  behalf of another player)
- Pagination or time-window filtering of the match list
- Backfilling `club_id` for historical rows, if any predate that column
- Any change to enrollment semantics or `player_match_map`
