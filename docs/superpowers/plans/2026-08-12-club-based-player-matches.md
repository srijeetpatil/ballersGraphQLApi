# Club-Based `getPlayerMatches` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change `getPlayerMatches` from returning a player's enrolled matches to returning all matches belonging to a given club, provided the player is a member of that club.

**Architecture:** Three-layer change following the repo's existing shape — GraphQL schema (`schema/Play.js`) gains a required `clubId` input field; the resolver (`resolvers/Play/Queries.js`) gains a club-membership guard and delegates row mapping to a new module-local helper; the model (`model/PlayModel.js`) swaps its `player_match_map` join for a direct club-scoped query against `test.matches`. No `Match` field resolver or DataLoader changes.

**Tech Stack:** Node 20, Firebase Cloud Functions, express-graphql, `graphql` v14 (`buildSchema` SDL), `pg` connection pool, lodash.

**Spec:** `docs/superpowers/specs/2026-08-12-club-based-player-matches-design.md`

## Global Constraints

- Schema is SDL-string based via `buildSchema` in `graphql/schema/Play.js` — there are no `.graphql` files to edit.
- No test framework is installed. `package.json` declares `node --test test/` but the suite was deleted in commit `2533889`. **Do not add tests** — verification is manual against the dev environment.
- No migration system. The required DDL (`test.matches.is_deleted`) was applied manually on 2026-08-12 and is already in place.
- **Do not commit until Task 4 (dev verification) passes.** Tasks 1–3 leave the working tree dirty on purpose.
- Error message strings must match the spec's table verbatim.
- Match the surrounding style: `const` arrow functions, double-quoted strings, 2-space indent, parameterized `$1` queries via `pool.query`.

---

### Task 1: Replace the model query with a club-scoped one

**Files:**
- Modify: `functions/graphql/model/PlayModel.js:278-285` (replace `getPlayerMatchesFromDb`)
- Modify: `functions/graphql/model/PlayModel.js:456` (exports entry)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getClubMatchesFromDb(clubId)` → `Promise<Array<Object>>`, resolving to raw `test.matches` rows (snake_case columns) ordered by `match_start_time` ascending. Propagates the raw `pg` error on DB failure (the resolver wraps it). Task 3 consumes this.

- [ ] **Step 1: Replace the function body**

In `functions/graphql/model/PlayModel.js`, replace this block at line 278:

```js
const getPlayerMatchesFromDb = async (playerId) => {
  const query = `select * from 
  (select match_id from test.player_match_map where player_id = $1) as pmm
  inner join test.matches m on pmm.match_id = m.id;`;

  const result = await pool.query(query, [playerId]);
  return result.rows;
};
```

with:

```js
const getClubMatchesFromDb = async (clubId) => {
  const query = `
    SELECT *
    FROM test.matches m
    WHERE m.is_deleted IS NOT TRUE
      AND (m.club_id = $1 OR m.home_team = $1 OR m.away_team = $1)
    ORDER BY m.match_start_time ASC;
  `;

  const result = await pool.query(query, [clubId]);
  return result.rows;
};
```

The model deliberately does **not** wrap errors — the resolver in Task 3 adds the
`"Failed to fetch club matches: "` prefix. Wrapping in both layers would produce a
doubled prefix in the client-facing message.

Note the three-column predicate: `club_id` catches `INTRA_CLUB` matches (whose `home_team`/`away_team` hold `temp_teams` IDs, not club IDs), while `home_team`/`away_team` catch `INTER_CLUB` matches including those where the club is the away side.

- [ ] **Step 2: Update the exports block**

At `functions/graphql/model/PlayModel.js:456`, replace the line:

```js
  getPlayerMatchesFromDb,
```

with:

```js
  getClubMatchesFromDb,
```

- [ ] **Step 3: Verify no stale references remain in the model**

Run:

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi && \
  grep -rn "getPlayerMatchesFromDb" --include="*.js" functions | grep -v node_modules
```

Expected: exactly one remaining hit, `functions/graphql/resolvers/Play/Queries.js:10` (the import), which Task 3 removes. If the model file still appears, Steps 1–2 were incomplete.

- [ ] **Step 4: Do not commit**

Leave changes uncommitted. Commits happen in Task 5, after dev verification.

---

### Task 2: Add required `clubId` to the schema input

**Files:**
- Modify: `functions/graphql/schema/Play.js:44-46` (`playerMatchInput`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `playerMatchInput` with fields `playerId: Int!` and `clubId: Int!`. Task 3's resolver reads both off `args.data`.

- [ ] **Step 1: Add the field**

In `functions/graphql/schema/Play.js`, replace this block at line 44:

```graphql
  input playerMatchInput {
    playerId: Int!
  }
```

with:

```graphql
  input playerMatchInput {
    playerId: Int!
    clubId: Int!
  }
```

Leave the `getPlayerMatches(data: playerMatchInput!): [Match]` line at line 135 exactly as-is — the return type does not change.

- [ ] **Step 2: Confirm the input is used by nothing else**

Run:

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi && \
  grep -rn "playerMatchInput" --include="*.js" functions | grep -v node_modules
```

Expected: exactly two hits, both in `functions/graphql/schema/Play.js` — the input definition and the `getPlayerMatches` query signature. Any third hit means another operation shares this input and would be broken by the required field; stop and report it.

- [ ] **Step 3: Do not commit**

Leave changes uncommitted.

---

### Task 3: Rewrite the resolver and extract the row mapper

**Files:**
- Modify: `functions/graphql/resolvers/Play/Queries.js:6-14` (imports)
- Modify: `functions/graphql/resolvers/Play/Queries.js:64-87` (`getPlayerMatches`)
- Modify: `functions/graphql/resolvers/Play/Queries.js:141-155` (`getMatchById` return block)

**Interfaces:**
- Consumes: `getClubMatchesFromDb(clubId)` from Task 1; `playerMatchInput.clubId` from Task 2; `fetchPlayerClubMap(playerId, clubId)` → `Promise<Array<Object>>`, already exported from `PlayModel.js:15` (returns matching `test.player_club_map` rows; empty array means not a member).
- Produces: no new exports. `getPlayerMatches` keeps its existing name and export.

- [ ] **Step 1: Update the model imports**

In `functions/graphql/resolvers/Play/Queries.js`, in the `require("../../model/PlayModel")` destructure at lines 6-14, replace:

```js
  getPlayerMatchesFromDb,
```

with:

```js
  getClubMatchesFromDb,
  fetchPlayerClubMap,
```

- [ ] **Step 2: Add the shared row mapper**

Insert this immediately above `const getPlayerMatches` (line 64), after `getAllVenues`:

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

Do **not** add it to `module.exports` — it is module-local.

- [ ] **Step 3: Rewrite `getPlayerMatches`**

Replace the whole function (lines 64-87 in the original file):

```js
const getPlayerMatches = async (_obj, args) => {
  const { data } = args;
  const playerId = data.playerId;
  const clubId = data.clubId;

  if (!playerId) {
    throw new Error("Player ID is required");
  }

  if (!clubId) {
    throw new Error("Club ID is required");
  }

  const membership = await fetchPlayerClubMap(playerId, clubId);
  if (!membership.length) {
    throw new Error("Player is not a member of this club");
  }

  try {
    const matches = await getClubMatchesFromDb(clubId);
    return matches.map(mapMatchRow);
  } catch (error) {
    throw new Error("Failed to fetch club matches: " + error.message);
  }
};
```

The membership check sits outside the `try` so a genuine non-member error surfaces as itself rather than being rewrapped as a fetch failure.

- [ ] **Step 4: Use the mapper in `getMatchById`**

In `getMatchById`, replace the 14-line return block (originally lines 141-155):

```js
    return {
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
    };
```

with:

```js
    return mapMatchRow(match);
```

Leave the surrounding `try`/`catch` and the "Match not found" check untouched.

- [ ] **Step 5: Verify the module loads and no stale references remain**

Run:

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && \
  node -e "require('./graphql/schema/Play'); require('./graphql/resolvers/Play'); console.log('modules load OK')" && \
  grep -rn "getPlayerMatchesFromDb" --include="*.js" . | grep -v node_modules
```

Expected: `modules load OK` printed, and the `grep` produces **no output** (exit code 1). A syntax error, a bad SDL string, or a leftover reference all fail here. Note this only proves the modules parse and the schema builds — it does not hit the database.

- [ ] **Step 6: Do not commit**

Leave changes uncommitted. Proceed to Task 4.

---

### Task 4: Verify on the dev environment

**Files:** none — this is a manual verification gate.

**Interfaces:**
- Consumes: the complete change from Tasks 1–3.
- Produces: a go/no-go decision for Task 5.

- [ ] **Step 1: Start the emulator**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && npm run serve
```

Open the GraphiQL endpoint the emulator prints for `ballersApiPlay`, at path `/graphql`.

- [ ] **Step 2: Confirm the `is_deleted` column is live**

The column was added manually on 2026-08-12. Confirm against the dev database before trusting any result below:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'test' AND table_name = 'matches' AND column_name = 'is_deleted';
```

Expected: one row. If empty, every query below fails with `column m.is_deleted does not exist`.

- [ ] **Step 3: Run the query against known data**

```graphql
query {
  getPlayerMatches(data: { playerId: <ID>, clubId: <ID> }) {
    id
    matchStartTime
    matchType
    matchStatus
    homeTeam { ... on Club { id name } ... on Team { id name } }
    awayTeam { ... on Club { id name } ... on Team { id name } }
    venue { id name }
    organiser { id firstName }
    playersHome { id firstName }
    playersAway { id firstName }
  }
}
```

- [ ] **Step 4: Walk the verification checklist**

Confirm each, substituting real IDs from the dev database:

- Member of a club with **inter-club home** matches → returned
- Member of a club with **inter-club away** matches → returned
- Club with **intra-club** matches → returned (the `club_id` branch — most likely to regress)
- A match the player is **not enrolled in** → still listed, with empty or partial `playersHome`/`playersAway`
- **Non-member** `playerId` + `clubId` → `"Player is not a member of this club"`, not an empty array
- Club with **no matches** → empty array, no error
- Omitting `clubId` entirely → GraphQL validation error naming the required field
- Results ordered by `matchStartTime` ascending, **past matches included**
- `homeTeam`/`awayTeam` resolve for both `INTER_CLUB` (Club) and `INTRA_CLUB` (Team) via the `TeamData` union
- A row with `is_deleted = true` → excluded
- `getMatchById` returns byte-identical output to before the `mapMatchRow` extraction

**Added after the whole-change review — check these first, they are the highest-risk:**

- **Was the C1 leak live?** Any overlap here means the original predicate was leaking real
  data on dev, not just theoretically:
  ```sql
  SELECT id FROM test.temp_teams INTERSECT SELECT id FROM test.clubs;
  ```
- **Legacy rows with no `club_id`.** These now vanish silently rather than erroring:
  ```sql
  SELECT count(*) FROM test.matches WHERE club_id IS NULL;
  ```
- **Pending invite with `away_team IS NULL`** → the match appears and the rest of the
  response is unaffected.
- **A declined match** (`match_status = 'MATCH_INVITATION_DECLINED'`) → excluded, and a
  **pending** one (`MATCH_AWAITING_OPPONENT_RESPONSE`) → still returned.
- **`getMatchById` still returns players correctly** — the detail screen is the only path
  that selects `playersHome` / `playersAway`, so exercise it directly after the loader
  revert.

- [ ] **Step 5: Gate**

If anything fails, fix it and re-run this task. Only proceed to Task 5 once the full checklist passes.

---

### Task 5: Commit

**Files:**
- Commit: `functions/graphql/model/PlayModel.js`, `functions/graphql/schema/Play.js`, `functions/graphql/resolvers/Play/Queries.js`, plus the spec and this plan.

**Interfaces:**
- Consumes: a passing Task 4.
- Produces: nothing.

- [ ] **Step 1: Confirm branch and review the diff**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi && \
  git branch --show-current && git status --short && git diff
```

Expected branch: `searchClubs`. Confirm only the four source/doc files changed, and that `firebase-debug.log` is **not** staged.

- [ ] **Step 2: Commit the docs**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi && \
  git add docs/superpowers/specs/2026-08-12-club-based-player-matches-design.md \
          docs/superpowers/plans/2026-08-12-club-based-player-matches.md && \
  git commit -m "docs: spec and plan for club-based getPlayerMatches"
```

- [ ] **Step 3: Commit the implementation**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi && \
  git add functions/graphql/model/PlayModel.js \
          functions/graphql/schema/Play.js \
          functions/graphql/resolvers/Play/Queries.js && \
  git commit -m "feat: scope getPlayerMatches to a club instead of enrollment

getPlayerMatches now takes a required clubId and returns every match the
club is involved in, gated on the player being a member of that club,
instead of only the matches the player had enrolled in.

Club matching covers club_id (INTRA_CLUB, whose home_team/away_team hold
temp_teams IDs) as well as home_team/away_team (INTER_CLUB, either side).
Also extracts the duplicated match row mapper shared with getMatchById."
```

---

## Follow-up (not in this plan)

- **Frontend is a separate repo.** `clubId` is now required; any client calling `getPlayerMatches` without it breaks at validation. "My matches across all clubs" is no longer expressible in one call and must be queried per club.
- Moving `playerId` from the input to the JWT (as `getPlayerClubs` does) — deliberately out of scope; tracked in the spec's Out of Scope section.
- Backfilling `club_id` on any historical `test.matches` rows that predate the column.
