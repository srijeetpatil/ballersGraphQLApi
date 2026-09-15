# Record Match Result (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the server a real lifecycle after team selection. Authorised players can record, edit, or mark a match not played inside a 24h window, tag goalscorers, and add or remove players only where they are allowed to.

**Architecture:**
- Result writes live in a new model file (`MatchResultModel.js`) and a new resolver file (`MatchResults.js`), rather than growing `PlayModel.js` and `Mutations.js`.
- Two small utilities hold the logic every mutation shares:
  - `matchAuth.js`: token, authorisation, result window
  - `matchMappers.js`: row-to-GraphQL mapping, which replaces two duplicated copies
- Each result write runs in one transaction that updates the match, replaces the roster, and appends an audit row.
- Race safety comes from a status-guarded `UPDATE`. This is the same pattern `acceptClubJoinRequestInDb` uses.

**Tech Stack:** Node 20, Firebase Cloud Functions, express-graphql, `graphql` v14 (`buildSchema` SDL) with `@graphql-tools/schema`, `pg` pool, DataLoader, lodash.

**Spec:**
- `/Users/srijeetpatil/Desktop/projects/ballers/docs/superpowers/specs/2026-09-10-record-match-result-design.md` (product behaviour)
- `docs/briefs/2026-09-11-record-match-result-frontend.md` (API contract; authoritative where the two differ)

## Global Constraints

- **Do not commit** until Task 6 passes. Commits happen in Task 7.
- **Do not write tests or create test files.** Verification is `node -e` load checks plus manual checking against the dev database (Task 6).
- No migration system exists. DDL is run by hand (Task 1).
- Code lives in the `functions` git **submodule** at `/Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions`, which is its own git repo. Work on branch `feat/record-match-result`, created from `release-v0.9.0` (Task 2, Step 1). Run git commands from inside the submodule.
- Schemas are SDL template literals passed to `buildSchema` in `graphql/schema/Play.js` and `graphql/schema/Auth.js`. There are no `.graphql` files.
- Style: `const` arrow functions, double-quoted strings, 2-space indent, parameterised `$1` queries, granular lodash imports (`require("lodash/get")`).
- Model functions are re-exported through the `graphql/model/index.js` barrel. New resolver and utility code imports from `"../../model"` or `"../model"`, not from a model file directly.
- **New match mutations never throw.** They return `MatchMutationResponse { status, message, match }`. `message` is user-visible copy, taken verbatim from the `MESSAGES` object in Task 4. **Never put raw `pg` error text in a message.** `getClubMembers` is a query and throws, like the other queries.
- **Result window:** a write is allowed only when `matchStartTime <= now < matchStartTime + 24h`.
- **Authorised** means the caller is the match `organiser`, or an admin (`player_club_map.is_admin`) of:
  - `matches.club_id` for `INTRA_CLUB`
  - `home_team` or `away_team` for `INTER_CLUB`
- **Intra-club roster rows store the temp-team id in `player_match_map.club_id`**, not the club id. Club membership for intra-club matches is checked against `matches.club_id`.
- After a write, read the match back with `getMatchByIdFromDb`, **never `matchLoader`**. DataLoaders here cache for the lifetime of the process.

---

### Task 1: Database changes (manual DDL, human-run)

**Files:** none. This runs against the dev database.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - every `test.*` timestamp column as `timestamptz`
  - `test.matches.club_id NOT NULL`
  - `test.matches.result_recorded_at` and `result_recorded_by`
  - the `test.match_goals` table
  - the `test.match_audit_log` table
  - intra-club matches moved out of `MATCH_AWAITING_OPPONENT_RESPONSE`

Every later task depends on these.

- [ ] **Step 1: Convert every naive timestamp to `timestamptz`**

The session timezone is `GMT`, and stored values are UTC wall-clock time. For example, match 55 was created from a UTC ISO string and reads `2026-09-06 19:55:00`. So `AT TIME ZONE 'UTC'` preserves every instant.

```sql
BEGIN;
ALTER TABLE test.alerts
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE test.clubs
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE test.login
  ALTER COLUMN "timestamp" TYPE timestamptz USING "timestamp" AT TIME ZONE 'UTC';
ALTER TABLE test.matches
  ALTER COLUMN created_at       TYPE timestamptz USING created_at       AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at       TYPE timestamptz USING updated_at       AT TIME ZONE 'UTC',
  ALTER COLUMN match_start_time TYPE timestamptz USING match_start_time AT TIME ZONE 'UTC',
  ALTER COLUMN match_end_time   TYPE timestamptz USING match_end_time   AT TIME ZONE 'UTC';
ALTER TABLE test.notifications
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
ALTER TABLE test.player_club_map
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE test.player_match_map
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
ALTER TABLE test.players
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';
COMMIT;
```

If Postgres refuses because a view depends on one of these columns, `ROLLBACK` and stop. Report the view name rather than dropping it.

- [ ] **Step 2: Make `club_id` required**

As of 2026-09-14, 17 test matches (ids 6–22) have no `club_id`: 6 inter-club and 11 intra-club. The inter-club ones can take `home_team`, because `createMatchModel` always sets `club_id` to the home club. The intra-club ones have no recoverable owner (their organiser belongs to 11 clubs), so they are deleted. The only foreign keys pointing at `test.matches` come from `player_match_map` and `alerts`.

```sql
BEGIN;
UPDATE test.matches SET club_id = home_team
WHERE club_id IS NULL AND match_type = 'INTER_CLUB';

DELETE FROM test.player_match_map
WHERE match_id IN (SELECT id FROM test.matches WHERE club_id IS NULL);

DELETE FROM test.alerts
WHERE match_id IN (SELECT id FROM test.matches WHERE club_id IS NULL);

DELETE FROM test.matches WHERE club_id IS NULL;

ALTER TABLE test.matches ALTER COLUMN club_id SET NOT NULL;
COMMIT;
```

Expected counts, in order:
- `UPDATE 6`
- `DELETE` of at most 3 roster rows
- `DELETE 0` alerts
- `DELETE 11` matches

If the counts differ, `ROLLBACK` and re-check before continuing.

- [ ] **Step 3: Unstick intra-club matches**

An intra-club match has no opponent to accept it, but `createMatchModel` creates every match as `MATCH_AWAITING_OPPONENT_RESPONSE`, and nothing moves intra-club ones on. Task 4 fixes the code. This step fixes the existing rows.

```sql
UPDATE test.matches SET match_status = 'MATCH_TEAM_SELECTION'
WHERE match_type = 'INTRA_CLUB' AND match_status = 'MATCH_AWAITING_OPPONENT_RESPONSE';
```

Expected: `UPDATE 16` or fewer, since Step 2 may have deleted some of them.

- [ ] **Step 4: Result columns, goals, audit log**

```sql
BEGIN;
ALTER TABLE test.matches
  ADD COLUMN result_recorded_at TIMESTAMPTZ,
  ADD COLUMN result_recorded_by INT REFERENCES test.players(id);

CREATE TABLE test.match_goals (
  id          SERIAL PRIMARY KEY,
  match_id    INT         NOT NULL REFERENCES test.matches(id),
  -- club id on INTER_CLUB matches, temp team id on INTRA_CLUB; no FK for that reason
  team_id     INT         NOT NULL,
  scorer_id   INT         NOT NULL REFERENCES test.players(id),
  is_own_goal BOOLEAN     NOT NULL DEFAULT false,
  created_by  INT         NOT NULL REFERENCES test.players(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_match_goals_match ON test.match_goals (match_id);

CREATE TABLE test.match_audit_log (
  id         SERIAL PRIMARY KEY,
  match_id   INT         NOT NULL REFERENCES test.matches(id),
  actor_id   INT         NOT NULL REFERENCES test.players(id),
  action     TEXT        NOT NULL,
  details    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_match_audit_log_match ON test.match_audit_log (match_id);
COMMIT;
```

- [ ] **Step 5: Confirm everything landed**

```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema = 'test' AND data_type = 'timestamp without time zone';

SELECT match_start_time FROM test.matches WHERE id = 55;

SELECT count(*) FROM test.matches WHERE club_id IS NULL;

SELECT is_nullable FROM information_schema.columns
WHERE table_schema = 'test' AND table_name = 'matches' AND column_name = 'club_id';

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'test' AND table_name = 'matches'
  AND column_name IN ('result_recorded_at', 'result_recorded_by');

SELECT to_regclass('test.match_goals'), to_regclass('test.match_audit_log');
```

Expected, in order:
1. zero rows
2. `2026-09-06 19:55:00+00`
3. `0`
4. `NO`
5. two rows
6. two non-null names

---

### Task 2: Read side: mappers, new `Match` fields, goals

**Files:**
- Create: `functions/graphql/utils/matchMappers.js`
- Create: `functions/graphql/model/MatchResultModel.js`
- Modify: `functions/graphql/model/index.js`
- Modify: `functions/graphql/schema/Play.js`
- Modify: `functions/graphql/resolvers/Play/Queries.js`
- Modify: `functions/graphql/resolvers/Play/index.js`
- Modify: `functions/graphql/dataloaders/matchLoader.js`

**Interfaces:**
- Consumes: Task 1's columns and tables.
- Produces:
  - `mapMatchRow(row)` → `Object|null`. It spreads the raw row and adds camelCase fields, including `clubId` and `resultRecordedAt`.
  - `mapPlayPlayerRow(row)` → `Object|null`, shaped as `{ id, firstName, lastName, phone, profilePicture, position, is_deleted }` for the Play schema's `Player`.
  - `getGoalsByMatchIdFromDb(matchId)` → `Promise<Array<row>>`, where each row has `id`, `match_id`, `team_id`, `scorer_id`, `is_own_goal`, `created_by`, `created_at`. It propagates `pg` errors.
  - `Match.clubId`, `Match.resultRecordedAt`, `Match.resultRecordedBy`, `Match.goals`, and the `MatchGoal` type with its `scorer` resolver.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && \
  git status --short && git checkout release-v0.9.0 && git checkout -b feat/record-match-result
```

Expected: a clean status, then `Switched to a new branch 'feat/record-match-result'`. If the status is not clean, stop and report.

- [ ] **Step 2: Create the mappers**

Create `functions/graphql/utils/matchMappers.js`:

```js
/**
 * Row mappers for the Match and Player types in graphql/schema/Play.js.
 *
 * mapMatchRow spreads the raw row so the snake_case columns stay available to
 * the Match field resolvers (home_team, venue_id, result_recorded_by, ...).
 *
 * mapPlayPlayerRow is for Play's Player only. Auth's Player is a different
 * type - see playerMappers.js.
 */
const mapMatchRow = (match) => {
  if (!match) {
    return null;
  }

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
    clubId: match.club_id,
    resultRecordedAt: match.result_recorded_at,
  };
};

const mapPlayPlayerRow = (player) => {
  if (!player) {
    return null;
  }

  return {
    id: player.id,
    firstName: player.first_name,
    lastName: player.last_name,
    phone: player.phone,
    profilePicture: player.profile_picture || null,
    position: player.position || null,
    is_deleted: player.is_deleted || false,
  };
};

module.exports = { mapMatchRow, mapPlayPlayerRow };
```

- [ ] **Step 3: Create the model file**

Create `functions/graphql/model/MatchResultModel.js`:

```js
const pool = require("../config/dbConfig.js");

const getGoalsByMatchIdFromDb = async (matchId) => {
  const result = await pool.query(
    `SELECT * FROM test.match_goals WHERE match_id = $1 ORDER BY id ASC;`,
    [matchId]
  );
  return result.rows;
};

module.exports = {
  getGoalsByMatchIdFromDb,
};
```

- [ ] **Step 4: Add it to the barrel**

Replace the whole of `functions/graphql/model/index.js` with:

```js
const AuthModel = require("./AuthModel");
const PlayModel = require("./PlayModel");
const MatchResultModel = require("./MatchResultModel");

module.exports = { ...AuthModel, ...PlayModel, ...MatchResultModel };
```

- [ ] **Step 5: Schema: new `Match` fields and `MatchGoal`**

In `functions/graphql/schema/Play.js`, the `Match` type currently ends:

```graphql
    playersHome: [Player]
    playersAway: [Player]
    is_deleted: Boolean
  }
```

Replace that with:

```graphql
    playersHome: [Player]
    playersAway: [Player]
    is_deleted: Boolean
    clubId: Int!
    resultRecordedAt: Date
    resultRecordedBy: Player
    goals: [MatchGoal!]!
  }

  type MatchGoal {
    id: ID!
    teamId: Int!
    isOwnGoal: Boolean!
    scorer: Player!
  }
```

- [ ] **Step 6: Use the mappers in `Queries.js`**

In `functions/graphql/resolvers/Play/Queries.js`:

(a) Directly below `const { matchLoader } = require("../../dataloaders/matchLoader");`, add:

```js
const { mapMatchRow, mapPlayPlayerRow } = require("../../utils/matchMappers");
const { getGoalsByMatchIdFromDb } = require("../../model");
```

(b) Delete the local `const mapMatchRow = (match) => ({ ... });` block (the 15 lines starting `const mapMatchRow`). The imported one replaces it. `getPlayerMatches` and `getMatchById` keep calling `mapMatchRow` unchanged.

(c) In the `Match` resolver object, replace both `playersHome` and `playersAway` with:

```js
  playersHome: async (parent) => {
    const playingPlayers = await fetchEnrolledPlayers(parent.id, parent.home_team);
    const players = await playerLoader.loadMany(
      playingPlayers.map((player) => player.player_id),
    );

    return players.map(mapPlayPlayerRow);
  },
  playersAway: async (parent) => {
    const playingPlayers = await fetchEnrolledPlayers(parent.id, parent.away_team);
    const players = await playerLoader.loadMany(
      playingPlayers.map((player) => player.player_id),
    );

    return players.map(mapPlayPlayerRow);
  },
  resultRecordedBy: async (parent) => {
    if (!parent.result_recorded_by) {
      return null;
    }

    return mapPlayPlayerRow(await playerLoader.load(parent.result_recorded_by));
  },
  goals: async (parent) => {
    const goals = await getGoalsByMatchIdFromDb(parent.id);

    return goals.map((goal) => ({
      id: goal.id,
      teamId: goal.team_id,
      isOwnGoal: goal.is_own_goal,
      scorer_id: goal.scorer_id,
    }));
  },
```

(d) Directly below the closing `};` of the `Alert` object, add:

```js
const MatchGoal = {
  scorer: async (parent) =>
    mapPlayPlayerRow(await playerLoader.load(parent.scorer_id)),
};
```

(e) Add `MatchGoal,` to `module.exports`, directly after `Alert,`.

- [ ] **Step 7: Wire `MatchGoal`**

In `functions/graphql/resolvers/Play/index.js`, add `MatchGoal,` to the `require("./Queries")` destructuring after `Alert,`. Then register it in the resolver map after `Alert,`:

```js
  Match,
  Alert,
  MatchGoal,
```

- [ ] **Step 8: Use the mapper in `matchLoader`**

Replace the whole of `functions/graphql/dataloaders/matchLoader.js` with:

```js
const DataLoader = require("dataloader");
const { getMatchesByIdsFromDb } = require("../model/PlayModel");
const { mapMatchRow } = require("../utils/matchMappers");

const matchLoader = new DataLoader(async (matchIds) => {
  const matches = await getMatchesByIdsFromDb(matchIds);
  return matchIds.map((id) =>
    mapMatchRow(matches.find((match) => match.id === id) || null)
  );
});

module.exports = { matchLoader };
```

This also fixes the backlog item "`matchLoader` spreads a null match". A missing id now yields `null` instead of a `TypeError`.

- [ ] **Step 9: Verify against dev (read-only)**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && node -e "
const { graphql } = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const schema = makeExecutableSchema({ typeDefs: require('./graphql/schema/Play'), resolvers: require('./graphql/resolvers/Play') });
graphql(schema, '{ getMatchById(id: 55) { id clubId matchStartTime resultRecordedAt resultRecordedBy { id } goals { id teamId isOwnGoal scorer { id } } playersHome { id firstName } } }', null, {})
  .then((r) => { console.log(JSON.stringify(r, null, 2)); return require('./graphql/config/dbConfig.js').end(); });
" && node -e "require('./play'); console.log('app loads OK')"
```

Expected:
- no `errors` key
- `clubId` is a number
- `matchStartTime` is `"2026-09-06T19:55:00.000Z"`
- `resultRecordedAt` and `resultRecordedBy` are `null`
- `goals` is `[]`
- `playersHome` is an array
- then `app loads OK`

- [ ] **Step 10: Do not commit**

Leave the changes uncommitted and go on to Task 3.

---

### Task 3: Authorisation: shared helpers, add/remove player, `auth` `Player.id`

**Files:**
- Create: `functions/graphql/utils/matchAuth.js`
- Modify: `functions/graphql/model/MatchResultModel.js`
- Modify: `functions/graphql/resolvers/Play/Mutations.js`
- Modify: `functions/graphql/schema/Auth.js`

**Interfaces:**
- Consumes: the barrel from Task 2. Pre-existing `verifyJwt(token)` → `Promise<decoded>` from `graphql/utils/common.js`, which rejects on an invalid token. `getMatchByIdFromDb(matchId)` → `Promise<row|null>`.
- Produces:
  - `isPlayerAdminOfAnyClubFromDb(playerId, clubIds)` → `Promise<boolean>`
  - `RESULT_WINDOW`, the object `{ TOO_EARLY, OPEN, CLOSED }`
  - `getResultWindowState(match, now = new Date())` → one of `RESULT_WINDOW`'s values. `match` is a raw row.
  - `getPlayerIdFromContext(context)` → `Promise<number|null>`. It never throws.
  - `isAuthorisedForMatch(match, playerId)` → `Promise<boolean>`. `match` is a raw row.

- [ ] **Step 1: Add the admin check to the model**

In `functions/graphql/model/MatchResultModel.js`, add above `module.exports`:

```js
const isPlayerAdminOfAnyClubFromDb = async (playerId, clubIds) => {
  const result = await pool.query(
    `SELECT 1 FROM test.player_club_map
     WHERE player_id = $1 AND club_id = ANY($2::int[]) AND is_admin = true
     LIMIT 1;`,
    [playerId, clubIds]
  );
  return result.rows.length > 0;
};
```

and replace `module.exports` with:

```js
module.exports = {
  getGoalsByMatchIdFromDb,
  isPlayerAdminOfAnyClubFromDb,
};
```

- [ ] **Step 2: Create the auth helpers**

Create `functions/graphql/utils/matchAuth.js`:

```js
const _get = require("lodash/get");
const _isEqual = require("lodash/isEqual");

const { verifyJwt } = require("./common");
const { isPlayerAdminOfAnyClubFromDb } = require("../model");

const RESULT_WINDOW_MS = 24 * 60 * 60 * 1000;

const RESULT_WINDOW = {
  TOO_EARLY: "TOO_EARLY",
  OPEN: "OPEN",
  CLOSED: "CLOSED",
};

/** Result writes are allowed in [matchStartTime, matchStartTime + 24h). The
 *  client uses the same half-open boundary to decide which actions to show. */
const getResultWindowState = (match, now = new Date()) => {
  const rawStart = _get(match, "match_start_time", null);
  const start = rawStart ? new Date(rawStart).getTime() : NaN;

  if (Number.isNaN(start)) {
    return RESULT_WINDOW.CLOSED;
  }

  const current = now.getTime();

  if (current < start) {
    return RESULT_WINDOW.TOO_EARLY;
  }

  if (current >= start + RESULT_WINDOW_MS) {
    return RESULT_WINDOW.CLOSED;
  }

  return RESULT_WINDOW.OPEN;
};

/** For mutations that report failure in their payload instead of throwing:
 *  any missing or invalid token comes back as null. */
const getPlayerIdFromContext = async (context) => {
  const header = _get(context, "token", null);

  if (!header) {
    return null;
  }

  try {
    const user = await verifyJwt(header.split("Bearer ")[1]);
    const playerId = Number(_get(user, "id", null));
    return playerId || null;
  } catch (error) {
    return null;
  }
};

/** On INTRA_CLUB matches home_team and away_team are temp teams, so the
 *  owning club is the one whose admins count. */
const getAdminClubIds = (match) => {
  const clubIds = _isEqual(match.match_type, "INTRA_CLUB")
    ? [match.club_id]
    : [match.home_team, match.away_team];

  return clubIds.filter(Boolean);
};

const isAuthorisedForMatch = async (match, playerId) => {
  if (!match || !playerId) {
    return false;
  }

  if (_isEqual(Number(match.organiser), Number(playerId))) {
    return true;
  }

  const clubIds = getAdminClubIds(match);

  if (!clubIds.length) {
    return false;
  }

  return await isPlayerAdminOfAnyClubFromDb(playerId, clubIds);
};

module.exports = {
  RESULT_WINDOW,
  getResultWindowState,
  getPlayerIdFromContext,
  isAuthorisedForMatch,
};
```

- [ ] **Step 3: Guard `addPlayerToMatch`**

In `functions/graphql/resolvers/Play/Mutations.js`, add below `const { verifyJwt } = require("../../utils/common");`:

```js
const {
  getPlayerIdFromContext,
  isAuthorisedForMatch,
} = require("../../utils/matchAuth");
```

Replace the start of `addPlayerToMatch`, from `const addPlayerToMatch = async (_obj, args) => {` through the closing `}` of the `if (!match)` block, with:

```js
const addPlayerToMatch = async (_obj, args, context) => {
  const { data } = args;
  const { matchId, playerId, teamId } = data;

  const callerId = await getPlayerIdFromContext(context);
  if (!callerId) {
    return {
      addSuccessful: false,
      message: "Please sign in again.",
      playersHome: [],
      playersAway: [],
    };
  }

  // 1. Fetch match details
  const match = await getMatchByIdFromDb(matchId);
  if (!match) {
    return {
      addSuccessful: false,
      message: "Match not found",
      playersHome: [],
      playersAway: [],
    };
  }

  // Players add themselves; only the organiser or an admin adds anyone else.
  const isAddingSelf = _isEqual(Number(callerId), Number(playerId));
  if (!isAddingSelf && !(await isAuthorisedForMatch(match, callerId))) {
    return {
      addSuccessful: false,
      message: "Only the organiser or a club admin can add other players.",
      playersHome: [],
      playersAway: [],
    };
  }
```

The rest of the function (the kickoff checks, eligibility, capacity) stays unchanged.

- [ ] **Step 4: Guard `removePlayerFromMatch`**

Replace the whole of `removePlayerFromMatch` with:

```js
const removePlayerFromMatch = async (_obj, args, context) => {
  const { data } = args;
  const { matchId, playerId } = data;

  if (!matchId || !playerId) {
    return {
      status: false,
      message: "Match ID and Player ID are required",
    };
  }

  const callerId = await getPlayerIdFromContext(context);
  if (!callerId) {
    return {
      status: false,
      message: "Please sign in again.",
    };
  }

  const match = await getMatchByIdFromDb(matchId);
  if (!match) {
    return {
      status: false,
      message: "Match not found",
    };
  }

  // Players remove themselves; only the organiser or an admin removes anyone else.
  const isRemovingSelf = _isEqual(Number(callerId), Number(playerId));
  if (!isRemovingSelf && !(await isAuthorisedForMatch(match, callerId))) {
    return {
      status: false,
      message: "Only the organiser or a club admin can remove other players.",
    };
  }

  // From kickoff the roster changes only through recording the result.
  if (new Date(match.match_start_time) <= new Date()) {
    return {
      status: false,
      message: "Match has already started",
    };
  }

  try {
    await removePlayerFromMatchInDB(matchId, playerId);
  } catch (error) {
    return {
      status: false,
      message: "Failed to remove player from match",
    };
  }

  return {
    status: true,
    message: "Player removed from match successfully",
  };
};
```

The old guard was `!matchId && !playerId`, which passed when only one of the two was missing. It is now `||`.

- [ ] **Step 5: `auth` `Player.id` becomes `Int!`**

In `functions/graphql/schema/Auth.js`, inside `type Player {`, change:

```graphql
    id: ID!
```

to:

```graphql
    id: Int!
```

Only change the one inside `type Player`. `ClubJoinRequest.id: ID!` stays as it is. Every producer of Auth `Player` already returns the integer `players.id`, so no resolver changes are needed.

- [ ] **Step 6: Verify the load and the unauthenticated paths**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && node -e "
const { graphql } = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const { getResultWindowState } = require('./graphql/utils/matchAuth');
const start = new Date('2026-09-14T10:00:00Z');
const m = { match_start_time: start };
console.log('before:', getResultWindowState(m, new Date('2026-09-14T09:59:59Z')));
console.log('at start:', getResultWindowState(m, start));
console.log('last ms:', getResultWindowState(m, new Date(start.getTime() + 86399999)));
console.log('at +24h:', getResultWindowState(m, new Date(start.getTime() + 86400000)));
console.log('no start:', getResultWindowState({ match_start_time: null }));
const schema = makeExecutableSchema({ typeDefs: require('./graphql/schema/Play'), resolvers: require('./graphql/resolvers/Play') });
Promise.all([
  graphql(schema, 'mutation { removePlayerFromMatch(data: { matchId: 55, playerId: 1 }) { status message } }', null, {}),
  graphql(schema, 'mutation { addPlayerToMatch(data: { matchId: 55, playerId: 1, teamId: 1 }) { addSuccessful message } }', null, {}),
]).then((rs) => { rs.forEach((r) => console.log(JSON.stringify(r))); return require('./graphql/config/dbConfig.js').end(); });
" && node -e "require('./auth'); require('./play'); console.log('apps load OK')"
```

Expected:
- `before: TOO_EARLY`
- `at start: OPEN`
- `last ms: OPEN`
- `at +24h: CLOSED`
- `no start: CLOSED`
- two results, both carrying `"Please sign in again."`, with `status`/`addSuccessful` `false`
- `apps load OK`

Neither mutation touches the database, because the token check runs first.

- [ ] **Step 7: Do not commit**

Leave the changes uncommitted and go on to Task 4.

---

### Task 4: Record, edit, mark not played

**Files:**
- Modify: `functions/graphql/model/MatchResultModel.js`
- Modify: `functions/graphql/model/PlayModel.js` (`createMatchModel` initial status)
- Create: `functions/graphql/resolvers/Play/MatchResults.js`
- Modify: `functions/graphql/schema/Play.js`
- Modify: `functions/graphql/resolvers/Play/index.js`

**Interfaces:**
- Consumes:
  - from Task 2: `mapMatchRow`
  - from Task 3: `RESULT_WINDOW`, `getResultWindowState`, `getPlayerIdFromContext`, `isAuthorisedForMatch`
  - pre-existing: `getMatchByIdFromDb(matchId)` → `Promise<row|null>`, and `fetchEnrolledPlayers(matchId, teamId)` → `Promise<Array<{player_id, club_id}>>` (only rows that are neither waiting nor deleted when `teamId` is truthy)
- Produces:
  - `getClubMemberIdsFromDb(clubId, playerIds)` → `Promise<number[]>`
  - `recordMatchResultInDb({ match, actorId, homeTeamGoals, awayTeamGoals, playersHome, playersAway })` → `Promise<true|null>`
  - `updateMatchResultInDb({ match, actorId, homeTeamGoals, awayTeamGoals, playersHome, playersAway })` → `Promise<true|null>`. `homeTeamGoals` and `awayTeamGoals` may be `null` to keep the current value. `playersHome` and `playersAway` may be `undefined` to leave that side untouched.
  - `markMatchNotPlayedInDb({ match, actorId })` → `Promise<true|null>`
  - `withTransaction(work)` → `Promise`. `work(client)` returning `null` rolls back.
  - `insertMatchAuditLog(client, { matchId, actorId, action, details })` → `Promise<void>`
  - In `MatchResults.js`: `MESSAGES`, `fail(message)`, `succeed(matchId, message)`, `loadWritableMatch(actorId, matchId)`, and the resolvers `recordMatchResult`, `updateMatchResult`, `markMatchNotPlayed`

`null` from any `*InDb` write means the status-guarded `UPDATE` matched no row: someone else changed the match in between.

- [ ] **Step 1: Add the write functions to the model**

In `functions/graphql/model/MatchResultModel.js`, add above `module.exports`:

```js
/** Runs work(client) in one transaction. work returning null rolls back; any
 *  other value commits and is returned. Errors roll back and rethrow. */
const withTransaction = async (work) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query(result === null ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const insertMatchAuditLog = async (client, { matchId, actorId, action, details }) => {
  await client.query(
    `INSERT INTO test.match_audit_log (match_id, actor_id, action, details)
     VALUES ($1, $2, $3, $4);`,
    [matchId, actorId, action, JSON.stringify(details)]
  );
};

const getClubMemberIdsFromDb = async (clubId, playerIds) => {
  const result = await pool.query(
    `SELECT DISTINCT player_id FROM test.player_club_map
     WHERE club_id = $1 AND player_id = ANY($2::int[]);`,
    [clubId, playerIds]
  );
  return result.rows.map((row) => row.player_id);
};

/** Replaces the confirmed roster for each side whose list is provided; a side
 *  passed as undefined is left alone. Players no longer listed are
 *  soft-deleted, listed players are inserted or revived, and waitlisted rows
 *  are not touched. Removals run for every side before any insert, so a player
 *  moved from one side to the other ends up on the new side. */
const replaceMatchRosterInDb = async (client, match, { playersHome, playersAway }) => {
  const sides = [
    { teamId: match.home_team, playerIds: playersHome },
    { teamId: match.away_team, playerIds: playersAway },
  ].filter((side) => Array.isArray(side.playerIds));

  for (const side of sides) {
    await client.query(
      `UPDATE test.player_match_map
       SET is_deleted = true, is_waiting = false, updated_at = now()
       WHERE match_id = $1 AND club_id = $2
         AND is_waiting = false AND is_deleted = false
         AND NOT (player_id = ANY($3::int[]));`,
      [match.id, side.teamId, side.playerIds]
    );
  }

  for (const side of sides) {
    await client.query(
      `INSERT INTO test.player_match_map
         (player_id, match_id, club_id, match_type, is_waiting, is_deleted)
       SELECT player_id, $2, $3, $4, false, false
       FROM unnest($1::int[]) AS player_id
       ON CONFLICT (player_id, match_id)
       DO UPDATE SET club_id = EXCLUDED.club_id, match_type = EXCLUDED.match_type,
                     is_waiting = false, is_deleted = false, updated_at = now();`,
      [side.playerIds, match.id, side.teamId, match.match_type]
    );
  }
};

const recordMatchResultInDb = async ({
  match,
  actorId,
  homeTeamGoals,
  awayTeamGoals,
  playersHome,
  playersAway,
}) =>
  withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE test.matches
       SET home_team_goals = $2, away_team_goals = $3,
           match_status = 'MATCH_ENDED',
           result_recorded_at = now(), result_recorded_by = $4, updated_at = now()
       WHERE id = $1
         AND match_status IN ('MATCH_TEAM_SELECTION', 'MATCH_ABANDONED')
       RETURNING id;`,
      [match.id, homeTeamGoals, awayTeamGoals, actorId]
    );

    if (!updated.rows.length) {
      return null;
    }

    await replaceMatchRosterInDb(client, match, { playersHome, playersAway });
    await insertMatchAuditLog(client, {
      matchId: match.id,
      actorId,
      action: "RESULT_RECORDED",
      details: {
        previousStatus: match.match_status,
        homeTeamGoals,
        awayTeamGoals,
        playersHome,
        playersAway,
      },
    });

    return true;
  });

/** Edits count as recording: attribution moves to whoever made the last
 *  change, so the name shown is the one behind the current score. */
const updateMatchResultInDb = async ({
  match,
  actorId,
  homeTeamGoals,
  awayTeamGoals,
  playersHome,
  playersAway,
}) =>
  withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE test.matches
       SET home_team_goals = COALESCE($2, home_team_goals),
           away_team_goals = COALESCE($3, away_team_goals),
           result_recorded_at = now(), result_recorded_by = $4, updated_at = now()
       WHERE id = $1 AND match_status = 'MATCH_ENDED'
       RETURNING id;`,
      [match.id, homeTeamGoals, awayTeamGoals, actorId]
    );

    if (!updated.rows.length) {
      return null;
    }

    await replaceMatchRosterInDb(client, match, { playersHome, playersAway });
    await insertMatchAuditLog(client, {
      matchId: match.id,
      actorId,
      action: "RESULT_UPDATED",
      details: {
        before: {
          homeTeamGoals: match.home_team_goals,
          awayTeamGoals: match.away_team_goals,
        },
        homeTeamGoals,
        awayTeamGoals,
        playersHome: playersHome || null,
        playersAway: playersAway || null,
      },
    });

    return true;
  });

const markMatchNotPlayedInDb = async ({ match, actorId }) =>
  withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE test.matches
       SET match_status = 'MATCH_ABANDONED', updated_at = now()
       WHERE id = $1 AND match_status = 'MATCH_TEAM_SELECTION'
       RETURNING id;`,
      [match.id]
    );

    if (!updated.rows.length) {
      return null;
    }

    await insertMatchAuditLog(client, {
      matchId: match.id,
      actorId,
      action: "MARKED_NOT_PLAYED",
      details: { previousStatus: match.match_status },
    });

    return true;
  });
```

Then replace `module.exports` with:

```js
module.exports = {
  getGoalsByMatchIdFromDb,
  isPlayerAdminOfAnyClubFromDb,
  withTransaction,
  insertMatchAuditLog,
  getClubMemberIdsFromDb,
  recordMatchResultInDb,
  updateMatchResultInDb,
  markMatchNotPlayedInDb,
};
```

- [ ] **Step 2: Create intra-club matches in team selection**

In `functions/graphql/model/PlayModel.js`, inside `createMatchModel`'s parameter array, replace the line:

```js
        "MATCH_AWAITING_OPPONENT_RESPONSE",
```

with:

```js
        // Intra-club matches have no opponent to accept, so they skip straight
        // to team selection.
        _isEqual(matchType, "INTRA_CLUB")
          ? "MATCH_TEAM_SELECTION"
          : "MATCH_AWAITING_OPPONENT_RESPONSE",
```

`_isEqual` is already imported at the top of the file.

- [ ] **Step 3: Create the resolver file**

Create `functions/graphql/resolvers/Play/MatchResults.js`:

```js
const _get = require("lodash/get");
const _includes = require("lodash/includes");
const _isEqual = require("lodash/isEqual");
const _isNil = require("lodash/isNil");
const _uniq = require("lodash/uniq");

const {
  RESULT_WINDOW,
  getResultWindowState,
  getPlayerIdFromContext,
  isAuthorisedForMatch,
} = require("../../utils/matchAuth");
const { mapMatchRow } = require("../../utils/matchMappers");
const {
  getMatchByIdFromDb,
  fetchEnrolledPlayers,
  getClubMemberIdsFromDb,
  recordMatchResultInDb,
  updateMatchResultInDb,
  markMatchNotPlayedInDb,
} = require("../../model");

/** Every string here is shown to users as-is. */
const MESSAGES = {
  NOT_SIGNED_IN: "Please sign in again.",
  MATCH_NOT_FOUND: "Match not found.",
  NOT_AUTHORISED: "Only the organiser or a club admin can do this.",
  TOO_EARLY: "You can record the result once the match has kicked off.",
  WINDOW_CLOSED:
    "This match can no longer be changed. Results must be recorded within 24 hours of kickoff.",
  STATUS_CHANGED:
    "Someone else just updated this match. Refresh and try again.",
  SOMETHING_WENT_WRONG: "Something went wrong. Please try again.",
  ALREADY_RECORDED: "A result has already been recorded. Edit it instead.",
  CANNOT_RECORD: "A result can't be recorded for this match.",
  NO_RESULT_TO_EDIT: "There is no result to edit yet.",
  NOTHING_TO_UPDATE: "Nothing to update.",
  HAS_RESULT: "This match already has a result. Edit it instead.",
  ALREADY_NOT_PLAYED: "This match is already marked as not played.",
  CANNOT_MARK_NOT_PLAYED: "This match can't be marked as not played.",
  INVALID_SCORE: "Scores must be whole numbers from 0 to 99.",
  ROSTER_EMPTY: "Each side needs at least one player.",
  ROSTER_TOO_LARGE: (maxPlayers) =>
    `Each side can have at most ${maxPlayers} players.`,
  PLAYER_ON_BOTH_SIDES: "A player can't be on both sides.",
  ROSTER_NOT_MEMBERS: "Every player must be a member of their club.",
  RESULT_RECORDED: "Result recorded.",
  RESULT_UPDATED: "Result updated.",
  MARKED_NOT_PLAYED: "Match marked as not played.",
};

const RECORDABLE_STATUSES = ["MATCH_TEAM_SELECTION", "MATCH_ABANDONED"];

const fail = (message) => ({ status: false, message, match: null });

/** The write has already committed, so a failed read-back must not turn into
 *  a failure: report success and let the client refetch. */
const succeed = async (matchId, message) => {
  try {
    const match = await getMatchByIdFromDb(matchId);
    return { status: true, message, match: mapMatchRow(match) };
  } catch (error) {
    console.error("Failed to read match back after write:", error);
    return { status: true, message, match: null };
  }
};

/** The checks every result write shares, in the order the user should hear
 *  about them. Returns { match } or { error }. */
const loadWritableMatch = async (actorId, matchId) => {
  const match = await getMatchByIdFromDb(matchId);

  if (!match || match.is_deleted) {
    return { error: MESSAGES.MATCH_NOT_FOUND };
  }

  if (!(await isAuthorisedForMatch(match, actorId))) {
    return { error: MESSAGES.NOT_AUTHORISED };
  }

  const windowState = getResultWindowState(match);

  if (_isEqual(windowState, RESULT_WINDOW.TOO_EARLY)) {
    return { error: MESSAGES.TOO_EARLY };
  }

  if (_isEqual(windowState, RESULT_WINDOW.CLOSED)) {
    return { error: MESSAGES.WINDOW_CLOSED };
  }

  return { match };
};

const isValidScore = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 99;

/** Same cap addPlayerToMatch uses: N from an "NvN" format. */
const getMaxPlayersPerSide = (match) =>
  parseInt(String(_get(match, "format", "")).split("v")[0], 10);

const getRosterIds = async (matchId, teamId) => {
  const rows = await fetchEnrolledPlayers(matchId, teamId);
  return rows.map((row) => row.player_id);
};

/** Returns an error message, or null when both rosters are valid. Expects
 *  de-duplicated id lists. */
const validateRosters = async (match, playersHome, playersAway) => {
  if (!playersHome.length || !playersAway.length) {
    return MESSAGES.ROSTER_EMPTY;
  }

  const maxPlayers = getMaxPlayersPerSide(match);
  if (
    maxPlayers > 0 &&
    (playersHome.length > maxPlayers || playersAway.length > maxPlayers)
  ) {
    return MESSAGES.ROSTER_TOO_LARGE(maxPlayers);
  }

  if (playersHome.some((playerId) => _includes(playersAway, playerId))) {
    return MESSAGES.PLAYER_ON_BOTH_SIDES;
  }

  const membershipChecks = _isEqual(match.match_type, "INTRA_CLUB")
    ? [{ clubId: match.club_id, playerIds: [...playersHome, ...playersAway] }]
    : [
        { clubId: match.home_team, playerIds: playersHome },
        { clubId: match.away_team, playerIds: playersAway },
      ];

  for (const check of membershipChecks) {
    const memberIds = await getClubMemberIdsFromDb(check.clubId, check.playerIds);
    if (memberIds.length < check.playerIds.length) {
      return MESSAGES.ROSTER_NOT_MEMBERS;
    }
  }

  return null;
};

const recordMatchResult = async (_obj, args, context) => {
  const { data } = args;

  try {
    const actorId = await getPlayerIdFromContext(context);
    if (!actorId) {
      return fail(MESSAGES.NOT_SIGNED_IN);
    }

    const { match, error } = await loadWritableMatch(actorId, data.matchId);
    if (error) {
      return fail(error);
    }

    if (_isEqual(match.match_status, "MATCH_ENDED")) {
      return fail(MESSAGES.ALREADY_RECORDED);
    }

    if (!_includes(RECORDABLE_STATUSES, match.match_status)) {
      return fail(MESSAGES.CANNOT_RECORD);
    }

    if (!isValidScore(data.homeTeamGoals) || !isValidScore(data.awayTeamGoals)) {
      return fail(MESSAGES.INVALID_SCORE);
    }

    const playersHome = _uniq(data.playersHome);
    const playersAway = _uniq(data.playersAway);
    const rosterError = await validateRosters(match, playersHome, playersAway);
    if (rosterError) {
      return fail(rosterError);
    }

    const recorded = await recordMatchResultInDb({
      match,
      actorId,
      homeTeamGoals: data.homeTeamGoals,
      awayTeamGoals: data.awayTeamGoals,
      playersHome,
      playersAway,
    });

    if (!recorded) {
      return fail(MESSAGES.STATUS_CHANGED);
    }

    return await succeed(match.id, MESSAGES.RESULT_RECORDED);
  } catch (error) {
    console.error("recordMatchResult failed:", error);
    return fail(MESSAGES.SOMETHING_WENT_WRONG);
  }
};

const updateMatchResult = async (_obj, args, context) => {
  const { data } = args;

  try {
    const actorId = await getPlayerIdFromContext(context);
    if (!actorId) {
      return fail(MESSAGES.NOT_SIGNED_IN);
    }

    const { match, error } = await loadWritableMatch(actorId, data.matchId);
    if (error) {
      return fail(error);
    }

    if (!_isEqual(match.match_status, "MATCH_ENDED")) {
      return fail(MESSAGES.NO_RESULT_TO_EDIT);
    }

    const hasScores = !_isNil(data.homeTeamGoals) || !_isNil(data.awayTeamGoals);
    const hasRoster = !_isNil(data.playersHome) || !_isNil(data.playersAway);
    if (!hasScores && !hasRoster) {
      return fail(MESSAGES.NOTHING_TO_UPDATE);
    }

    const scoresToCheck = [data.homeTeamGoals, data.awayTeamGoals].filter(
      (score) => !_isNil(score)
    );
    if (!scoresToCheck.every(isValidScore)) {
      return fail(MESSAGES.INVALID_SCORE);
    }

    let playersHome;
    let playersAway;

    if (hasRoster) {
      // Validate against the roster as it will be after the edit: a side not
      // sent keeps its current players.
      const effectiveHome = _isNil(data.playersHome)
        ? await getRosterIds(match.id, match.home_team)
        : _uniq(data.playersHome);
      const effectiveAway = _isNil(data.playersAway)
        ? await getRosterIds(match.id, match.away_team)
        : _uniq(data.playersAway);

      const rosterError = await validateRosters(match, effectiveHome, effectiveAway);
      if (rosterError) {
        return fail(rosterError);
      }

      playersHome = _isNil(data.playersHome) ? undefined : effectiveHome;
      playersAway = _isNil(data.playersAway) ? undefined : effectiveAway;
    }

    const updated = await updateMatchResultInDb({
      match,
      actorId,
      homeTeamGoals: _isNil(data.homeTeamGoals) ? null : data.homeTeamGoals,
      awayTeamGoals: _isNil(data.awayTeamGoals) ? null : data.awayTeamGoals,
      playersHome,
      playersAway,
    });

    if (!updated) {
      return fail(MESSAGES.STATUS_CHANGED);
    }

    return await succeed(match.id, MESSAGES.RESULT_UPDATED);
  } catch (error) {
    console.error("updateMatchResult failed:", error);
    return fail(MESSAGES.SOMETHING_WENT_WRONG);
  }
};

const markMatchNotPlayed = async (_obj, args, context) => {
  const { matchId } = args;

  try {
    const actorId = await getPlayerIdFromContext(context);
    if (!actorId) {
      return fail(MESSAGES.NOT_SIGNED_IN);
    }

    const { match, error } = await loadWritableMatch(actorId, matchId);
    if (error) {
      return fail(error);
    }

    if (_isEqual(match.match_status, "MATCH_ENDED")) {
      return fail(MESSAGES.HAS_RESULT);
    }

    if (_isEqual(match.match_status, "MATCH_ABANDONED")) {
      return fail(MESSAGES.ALREADY_NOT_PLAYED);
    }

    if (!_isEqual(match.match_status, "MATCH_TEAM_SELECTION")) {
      return fail(MESSAGES.CANNOT_MARK_NOT_PLAYED);
    }

    const marked = await markMatchNotPlayedInDb({ match, actorId });
    if (!marked) {
      return fail(MESSAGES.STATUS_CHANGED);
    }

    return await succeed(match.id, MESSAGES.MARKED_NOT_PLAYED);
  } catch (error) {
    console.error("markMatchNotPlayed failed:", error);
    return fail(MESSAGES.SOMETHING_WENT_WRONG);
  }
};

module.exports = {
  recordMatchResult,
  updateMatchResult,
  markMatchNotPlayed,
};
```

- [ ] **Step 4: Schema: response type, inputs, mutations**

In `functions/graphql/schema/Play.js`, add directly above `type Query {`:

```graphql
  type MatchMutationResponse {
    status: Boolean!
    message: String!
    match: Match
  }

  input recordMatchResultInput {
    matchId: ID!
    homeTeamGoals: Int!
    awayTeamGoals: Int!
    playersHome: [Int!]!
    playersAway: [Int!]!
  }

  input updateMatchResultInput {
    matchId: ID!
    homeTeamGoals: Int
    awayTeamGoals: Int
    playersHome: [Int!]
    playersAway: [Int!]
  }

```

Then, in `type Mutation {`, add below `respondToMatchInvitation(...)`:

```graphql
    recordMatchResult(data: recordMatchResultInput!): MatchMutationResponse!
    updateMatchResult(data: updateMatchResultInput!): MatchMutationResponse!
    markMatchNotPlayed(matchId: ID!): MatchMutationResponse!
```

- [ ] **Step 5: Wire the resolvers**

In `functions/graphql/resolvers/Play/index.js`, add beneath the `require("./Queries")` block:

```js
const {
  recordMatchResult,
  updateMatchResult,
  markMatchNotPlayed,
} = require("./MatchResults");
```

and add to the `Mutation` block, after `respondToMatchInvitation: respondToMatchInvitationResolver,`:

```js
    recordMatchResult,
    updateMatchResult,
    markMatchNotPlayed,
```

- [ ] **Step 6: Verify the load and the unauthenticated path**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && node -e "
const { graphql } = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const r = require('./graphql/resolvers/Play');
['recordMatchResult', 'updateMatchResult', 'markMatchNotPlayed'].forEach((n) => console.log(n + ':', typeof r.Mutation[n]));
const schema = makeExecutableSchema({ typeDefs: require('./graphql/schema/Play'), resolvers: r });
graphql(schema, 'mutation { recordMatchResult(data: { matchId: 55, homeTeamGoals: 1, awayTeamGoals: 0, playersHome: [1], playersAway: [2] }) { status message match { id } } markMatchNotPlayed(matchId: 55) { status message } }', null, {})
  .then((res) => { console.log(JSON.stringify(res)); return require('./graphql/config/dbConfig.js').end(); });
" && node -e "require('./play'); console.log('app loads OK')"
```

Expected:
- three `function` lines
- both mutations return `status: false` and `message: "Please sign in again."`, with `match: null` and no `errors` key
- `app loads OK`

- [ ] **Step 7: Do not commit**

Leave the changes uncommitted and go on to Task 5.

---

### Task 5: Goal tagging and club members

**Files:**
- Modify: `functions/graphql/model/MatchResultModel.js`
- Modify: `functions/graphql/resolvers/Play/MatchResults.js`
- Modify: `functions/graphql/schema/Play.js`
- Modify: `functions/graphql/resolvers/Play/index.js`

**Interfaces:**
- Consumes:
  - from Task 4: `withTransaction`, `insertMatchAuditLog`, `MESSAGES`, `fail`, `succeed`, `loadWritableMatch`, `getRosterIds`, and the existing `MatchResults.js` imports
  - from Task 3: `getPlayerIdFromContext`
  - from Task 2: `mapPlayPlayerRow`
- Produces:
  - `addMatchGoalInDb({ match, actorId, teamId, playerId, isOwnGoal })` → `Promise<row>`
  - `getMatchGoalByIdFromDb(goalId)` → `Promise<row|null>`
  - `removeMatchGoalInDb({ goal, actorId })` → `Promise<true|null>`
  - `getClubMembersFromDb(clubId)` → `Promise<Array<players row>>`
  - resolvers `addMatchGoal`, `removeMatchGoal`, `getClubMembers`

- [ ] **Step 1: Add the goal and member functions to the model**

In `functions/graphql/model/MatchResultModel.js`, add above `module.exports`:

```js
const addMatchGoalInDb = async ({ match, actorId, teamId, playerId, isOwnGoal }) =>
  withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO test.match_goals (match_id, team_id, scorer_id, is_own_goal, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *;`,
      [match.id, teamId, playerId, isOwnGoal, actorId]
    );

    const goal = inserted.rows[0];
    await insertMatchAuditLog(client, {
      matchId: match.id,
      actorId,
      action: "GOAL_ADDED",
      details: { goalId: goal.id, teamId, scorerId: playerId, isOwnGoal },
    });

    return goal;
  });

const getMatchGoalByIdFromDb = async (goalId) => {
  const result = await pool.query(
    `SELECT * FROM test.match_goals WHERE id = $1;`,
    [goalId]
  );
  return result.rows[0] || null;
};

const removeMatchGoalInDb = async ({ goal, actorId }) =>
  withTransaction(async (client) => {
    const deleted = await client.query(
      `DELETE FROM test.match_goals WHERE id = $1 RETURNING id;`,
      [goal.id]
    );

    if (!deleted.rows.length) {
      return null;
    }

    await insertMatchAuditLog(client, {
      matchId: goal.match_id,
      actorId,
      action: "GOAL_REMOVED",
      details: {
        goalId: goal.id,
        teamId: goal.team_id,
        scorerId: goal.scorer_id,
        isOwnGoal: goal.is_own_goal,
      },
    });

    return true;
  });

const getClubMembersFromDb = async (clubId) => {
  const result = await pool.query(
    `SELECT p.*
     FROM test.player_club_map pcm
     INNER JOIN test.players p ON p.id = pcm.player_id
     WHERE pcm.club_id = $1 AND p.is_deleted IS NOT TRUE
     ORDER BY p.first_name ASC, p.last_name ASC;`,
    [clubId]
  );
  return result.rows;
};
```

Then replace `module.exports` with:

```js
module.exports = {
  getGoalsByMatchIdFromDb,
  isPlayerAdminOfAnyClubFromDb,
  withTransaction,
  insertMatchAuditLog,
  getClubMemberIdsFromDb,
  recordMatchResultInDb,
  updateMatchResultInDb,
  markMatchNotPlayedInDb,
  addMatchGoalInDb,
  getMatchGoalByIdFromDb,
  removeMatchGoalInDb,
  getClubMembersFromDb,
};
```

- [ ] **Step 2: Extend the resolver imports and messages**

In `functions/graphql/resolvers/Play/MatchResults.js`, replace:

```js
const { mapMatchRow } = require("../../utils/matchMappers");
const {
  getMatchByIdFromDb,
  fetchEnrolledPlayers,
  getClubMemberIdsFromDb,
  recordMatchResultInDb,
  updateMatchResultInDb,
  markMatchNotPlayedInDb,
} = require("../../model");
```

with:

```js
const { mapMatchRow, mapPlayPlayerRow } = require("../../utils/matchMappers");
const {
  getMatchByIdFromDb,
  fetchEnrolledPlayers,
  getClubMemberIdsFromDb,
  recordMatchResultInDb,
  updateMatchResultInDb,
  markMatchNotPlayedInDb,
  addMatchGoalInDb,
  getMatchGoalByIdFromDb,
  removeMatchGoalInDb,
  getClubMembersFromDb,
} = require("../../model");
```

In the `MESSAGES` object, replace the last line:

```js
  MARKED_NOT_PLAYED: "Match marked as not played.",
};
```

with:

```js
  MARKED_NOT_PLAYED: "Match marked as not played.",
  GOALS_NEED_RESULT: "Scorers can only be tagged once a result is recorded.",
  TEAM_NOT_IN_MATCH: "That team isn't playing in this match.",
  SCORER_NOT_ON_ROSTER: "The scorer must be on the match roster.",
  OWN_GOAL_MISMATCH: "The own goal setting doesn't match the scorer's side.",
  GOAL_NOT_FOUND: "Goal not found.",
  GOAL_ADDED: "Scorer added.",
  GOAL_REMOVED: "Scorer removed.",
};
```

- [ ] **Step 3: Add the goal resolvers and `getClubMembers`**

In `functions/graphql/resolvers/Play/MatchResults.js`, add directly above `module.exports`:

```js
const addMatchGoal = async (_obj, args, context) => {
  const { data } = args;

  try {
    const actorId = await getPlayerIdFromContext(context);
    if (!actorId) {
      return fail(MESSAGES.NOT_SIGNED_IN);
    }

    const { match, error } = await loadWritableMatch(actorId, data.matchId);
    if (error) {
      return fail(error);
    }

    if (!_isEqual(match.match_status, "MATCH_ENDED")) {
      return fail(MESSAGES.GOALS_NEED_RESULT);
    }

    if (!_includes([match.home_team, match.away_team], data.teamId)) {
      return fail(MESSAGES.TEAM_NOT_IN_MATCH);
    }

    const homeIds = await getRosterIds(match.id, match.home_team);
    const awayIds = await getRosterIds(match.id, match.away_team);

    let scorerTeamId = null;
    if (_includes(homeIds, data.playerId)) {
      scorerTeamId = match.home_team;
    } else if (_includes(awayIds, data.playerId)) {
      scorerTeamId = match.away_team;
    }

    if (_isNil(scorerTeamId)) {
      return fail(MESSAGES.SCORER_NOT_ON_ROSTER);
    }

    // The client states isOwnGoal explicitly so a disagreement is an error,
    // not a silent reinterpretation.
    const isOwnGoal = !_isEqual(scorerTeamId, data.teamId);
    if (!_isEqual(isOwnGoal, data.isOwnGoal)) {
      return fail(MESSAGES.OWN_GOAL_MISMATCH);
    }

    await addMatchGoalInDb({
      match,
      actorId,
      teamId: data.teamId,
      playerId: data.playerId,
      isOwnGoal,
    });

    return await succeed(match.id, MESSAGES.GOAL_ADDED);
  } catch (error) {
    console.error("addMatchGoal failed:", error);
    return fail(MESSAGES.SOMETHING_WENT_WRONG);
  }
};

const removeMatchGoal = async (_obj, args, context) => {
  const { goalId } = args;

  try {
    const actorId = await getPlayerIdFromContext(context);
    if (!actorId) {
      return fail(MESSAGES.NOT_SIGNED_IN);
    }

    const goal = await getMatchGoalByIdFromDb(goalId);
    if (!goal) {
      return fail(MESSAGES.GOAL_NOT_FOUND);
    }

    const { match, error } = await loadWritableMatch(actorId, goal.match_id);
    if (error) {
      return fail(error);
    }

    if (!_isEqual(match.match_status, "MATCH_ENDED")) {
      return fail(MESSAGES.GOALS_NEED_RESULT);
    }

    const removed = await removeMatchGoalInDb({ goal, actorId });
    if (!removed) {
      return fail(MESSAGES.GOAL_NOT_FOUND);
    }

    return await succeed(match.id, MESSAGES.GOAL_REMOVED);
  } catch (error) {
    console.error("removeMatchGoal failed:", error);
    return fail(MESSAGES.SOMETHING_WENT_WRONG);
  }
};

/** A query, so it throws like the other queries. Phone numbers are withheld:
 *  any signed-in player can list any club's members for the record sheet. */
const getClubMembers = async (_obj, args, context) => {
  const actorId = await getPlayerIdFromContext(context);
  if (!actorId) {
    throw new Error("Missing token");
  }

  try {
    const members = await getClubMembersFromDb(args.clubId);
    return members.map((member) => ({ ...mapPlayPlayerRow(member), phone: null }));
  } catch (error) {
    console.error("getClubMembers failed:", error);
    throw new Error("Failed to fetch club members");
  }
};
```

Then replace `module.exports` with:

```js
module.exports = {
  recordMatchResult,
  updateMatchResult,
  markMatchNotPlayed,
  addMatchGoal,
  removeMatchGoal,
  getClubMembers,
};
```

- [ ] **Step 4: Schema: goal input, mutations, query**

In `functions/graphql/schema/Play.js`, directly below the `updateMatchResultInput` block added in Task 4, add:

```graphql
  input addMatchGoalInput {
    matchId: ID!
    teamId: Int!
    playerId: Int!
    isOwnGoal: Boolean!
  }

```

In `type Query {`, add below `getPlayerAlertsForClub(clubId: Int!): [Alert]`:

```graphql
    getClubMembers(clubId: Int!): [Player!]!
```

In `type Mutation {`, add below `markMatchNotPlayed(matchId: ID!): MatchMutationResponse!`:

```graphql
    addMatchGoal(data: addMatchGoalInput!): MatchMutationResponse!
    removeMatchGoal(goalId: ID!): MatchMutationResponse!
```

- [ ] **Step 5: Wire the resolvers**

In `functions/graphql/resolvers/Play/index.js`, replace the `require("./MatchResults")` block with:

```js
const {
  recordMatchResult,
  updateMatchResult,
  markMatchNotPlayed,
  addMatchGoal,
  removeMatchGoal,
  getClubMembers,
} = require("./MatchResults");
```

Add `getClubMembers,` to the `Query` block after `getPlayerAlertsForClub,`. Add to the `Mutation` block after `markMatchNotPlayed,`:

```js
    addMatchGoal,
    removeMatchGoal,
```

- [ ] **Step 6: Verify the load and the unauthenticated paths**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && node -e "
const { graphql } = require('graphql');
const { makeExecutableSchema } = require('@graphql-tools/schema');
const r = require('./graphql/resolvers/Play');
['addMatchGoal', 'removeMatchGoal'].forEach((n) => console.log(n + ':', typeof r.Mutation[n]));
console.log('getClubMembers:', typeof r.Query.getClubMembers);
const schema = makeExecutableSchema({ typeDefs: require('./graphql/schema/Play'), resolvers: r });
Promise.all([
  graphql(schema, 'mutation { addMatchGoal(data: { matchId: 55, teamId: 1, playerId: 1, isOwnGoal: false }) { status message } removeMatchGoal(goalId: 1) { status message } }', null, {}),
  graphql(schema, '{ getClubMembers(clubId: 1) { id } }', null, {}),
]).then((rs) => { rs.forEach((x) => console.log(JSON.stringify(x))); return require('./graphql/config/dbConfig.js').end(); });
" && node -e "require('./play'); console.log('app loads OK')"
```

Expected:
- three `function` lines
- both mutations return `"Please sign in again."` with `status: false`
- `getClubMembers` returns an `errors` entry with message `"Missing token"`
- `app loads OK`

- [ ] **Step 7: Do not commit**

Leave the changes uncommitted and go on to Task 6.

---

### Task 6: Manual dev verification (human-run)

**Files:** none. This is the verification gate.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: go or no-go for Task 7.

- [ ] **Step 1: Start the emulator and mint dev tokens**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && npm run serve
```

Open the `ballersApiPlay` GraphiQL at `/graphql` and set `Authorization: Bearer <jwt>` in the header editor. Mint a token for any player id:

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && \
  node -e "console.log(require('./graphql/utils/common').generateJWT({ id: <PLAYER_ID> }))"
```

Mint tokens for these roles on the match chosen in Step 2:
- **ORGANISER**
- **HOME_ADMIN** (admin of the home club, not the organiser)
- **AWAY_ADMIN** (admin of the away club)
- **MEMBER** (a home club member who is not an admin)
- **OUTSIDER** (in neither club)

- [ ] **Step 2: Put a match inside its window**

Pick an `INTER_CLUB` match `<M>` in `MATCH_TEAM_SELECTION` with at least one player per side:

```sql
UPDATE test.matches
SET match_start_time = now() - interval '2 hours',
    match_end_time   = now() - interval '30 minutes'
WHERE id = <M>;
```

- [ ] **Step 3: Walk the recording checklist**

Select `status message match { id matchStatus homeTeamGoals awayTeamGoals clubId resultRecordedAt resultRecordedBy { id } playersHome { id } playersAway { id } goals { id teamId isOwnGoal scorer { id } } }` on every mutation.

- No `Authorization` header → `"Please sign in again."`
- OUTSIDER or MEMBER records → `"Only the organiser or a club admin can do this."`
- AWAY_ADMIN records `3-2` with the current rosters → `status: true`, `"Result recorded."`, `matchStatus: "MATCH_ENDED"`, `resultRecordedBy.id` = AWAY_ADMIN, `goals: []`
- Record again → `"A result has already been recorded. Edit it instead."`
- `markMatchNotPlayed` on it → `"This match already has a result. Edit it instead."`
- HOME_ADMIN `updateMatchResult` with only `homeTeamGoals: 4` → `"Result updated."`; away score and both rosters unchanged; `resultRecordedBy.id` = HOME_ADMIN
- `updateMatchResult` with only `matchId` → `"Nothing to update."`
- Using `updateMatchResult` on `<M>`, a score of `100` or `-1` → `"Scores must be whole numbers from 0 to 99."`
- Using `updateMatchResult` on `<M>`, `playersAway: []` → `"Each side needs at least one player."`
- Using `updateMatchResult` on `<M>`, a side with more ids than the `NvN` format allows → `"Each side can have at most N players."`
- Using `updateMatchResult` on `<M>`, the same id in both lists → `"A player can't be on both sides."`
- Using `updateMatchResult` on `<M>`, an OUTSIDER's id in `playersHome` → `"Every player must be a member of their club."`
- Update with one home player removed and one other home-club member added → `playersHome` reflects exactly the new list

- [ ] **Step 4: Walk the goals checklist**

- `addMatchGoal` for a home player credited to home, `isOwnGoal: false` → `"Scorer added."`, and the goal appears in `goals`
- An away player credited to home with `isOwnGoal: true` → added as an own goal
- The same, but `isOwnGoal: false` → `"The own goal setting doesn't match the scorer's side."`
- A scorer not on either roster → `"The scorer must be on the match roster."`
- A `teamId` that is neither side → `"That team isn't playing in this match."`
- `removeMatchGoal` → `"Scorer removed."`; removing the same id again → `"Goal not found."`
- Remove a player who has a tagged goal via `updateMatchResult` → succeeds, and the goal stays in `goals`
- `getClubMembers(clubId: <AWAY_CLUB>)` with a token → members, every `phone` is `null`, no soft-deleted players

- [ ] **Step 5: Walk the window and not-played checklist**

Use a second `INTER_CLUB` team-selection match `<N>`:

- Set `match_start_time = now() + interval '1 hour'`, then record → `"You can record the result once the match has kicked off."`
- Set `match_start_time = now() - interval '25 hours'`, then record → `"This match can no longer be changed. Results must be recorded within 24 hours of kickoff."`
- Set `match_start_time = now() - interval '2 hours'`, then `markMatchNotPlayed` → `"Match marked as not played."`, `matchStatus: "MATCH_ABANDONED"`
- `markMatchNotPlayed` again → `"This match is already marked as not played."`
- `recordMatchResult` on the abandoned match → `"Result recorded."`, `matchStatus: "MATCH_ENDED"` (the undo)
- Set `<M>`'s start to `now() - interval '25 hours'`, then `addMatchGoal` or `updateMatchResult` → the window-closed message

- [ ] **Step 6: Walk the intra-club and roster-permission checklist**

- `createMatch` with `matchType: "INTRA_CLUB"` → the new row has `match_status = 'MATCH_TEAM_SELECTION'` and a non-null `club_id`
- Put it in its window (Step 2's SQL). An admin of `club_id` who is **not** the organiser records it → succeeds
- An admin of a different club whose id equals one of the match's temp-team ids records it → `"Only the organiser or a club admin can do this."`

On a team-selection match whose start is in the future:

- MEMBER adds themselves → allowed (or the usual capacity or eligibility message)
- MEMBER adds a different player → `"Only the organiser or a club admin can add other players."`
- HOME_ADMIN adds a different eligible player → allowed
- MEMBER removes a different player → `"Only the organiser or a club admin can remove other players."`
- MEMBER removes themselves → `"Player removed from match successfully"`
- No header on either mutation → `"Please sign in again."`
- Move the start into the past, then HOME_ADMIN removes any player, or MEMBER removes themselves → `"Match has already started"`

- [ ] **Step 7: Check the audit trail, timestamps and `auth` ids**

```sql
SELECT match_id, actor_id, action, details, created_at
FROM test.match_audit_log ORDER BY id DESC LIMIT 20;
```

Expect one row per successful write above:
- `RESULT_RECORDED`
- `RESULT_UPDATED`
- `MARKED_NOT_PLAYED`
- `GOAL_ADDED`
- `GOAL_REMOVED`

There must be no rows for rejected calls.

Also check:
- `getMatchById` for any match returns `matchStartTime` as an ISO string ending in `Z` that matches the time the app has been showing
- On the `ballersApiAuth` endpoint, `userWithPhoneExists(data: { phone: "<PHONE>" }) { id }` returns `id` as a number, not a quoted string
- After recording a result on `<M>` in Step 3, call `getPlayerAlertsForClub(clubId: <HOME_CLUB>) { id match { id matchStatus } }` for an alert on `<M>` if one exists, then `getMatchById(id: <M>) { matchStatus }`. Both must show `MATCH_ENDED`. This checks Fix 1.

- [ ] **Step 8: Gate**

If anything fails, fix it and re-run this task. Only go on once every item passes.

---

### Task 7: Commit

**Files:**
- Commit in the `functions` submodule:
  - `graphql/utils/matchMappers.js` (new)
  - `graphql/utils/matchAuth.js` (new)
  - `graphql/config/dbTransaction.js` (new)
  - `graphql/resolvers/Play/MatchResults.js` (new)
  - `graphql/model/PlayModel.js`
  - `graphql/schema/Play.js`
  - `graphql/schema/Auth.js`
  - `graphql/resolvers/Play/Queries.js`
  - `graphql/resolvers/Play/Mutations.js`
  - `graphql/resolvers/Play/index.js`
  - `graphql/dataloaders/matchLoader.js`
  - `play/index.js`

  *Changed after Tasks 2–5 ran (2026-09-15):* the model functions those tasks put in
  `graphql/model/MatchResultModel.js` were moved into `PlayModel.js`, to keep one model file per
  Cloud Function. `withTransaction` moved to `graphql/config/dbTransaction.js`. So
  `MatchResultModel.js` no longer exists, and `graphql/model/index.js` is back to its original
  content. `play/index.js` joined the list when the final review made `matchLoader` per request.
- Commit in the outer repo: this plan, the frontend brief, and the submodule pointer

**Interfaces:**
- Consumes: a passing Task 6.
- Produces: nothing.

- [ ] **Step 0: Gate — the target database has Task 1 applied**

This code cannot run against a database without Task 1's changes. `Match.goals` needs
`test.match_goals`, `Match.clubId` is non-null, every result write inserts into
`test.match_audit_log`, and the result window assumes `timestamptz`. Without them,
`getMatchById` and every `getPlayerMatches` item fail.

Before `npm run deploy` to **any** environment, run Task 1 Steps 1–5 against that environment's
database (the one its `DB_HOST` / `DB_NAME` point at) and confirm every Step 5 check passes.
Deploy `auth` and `play` in the same release, so `auth`'s `Player.id: Int!` ships with the rest.

Dev was migrated on 2026-09-14. No other environment has been.

- [ ] **Step 1: Review the diff**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && \
  git branch --show-current && git status --short && git diff --stat
```

Expected: branch `feat/record-match-result`, and exactly the 12 files above (4 of them untracked).

- [ ] **Step 2: Commit the submodule**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && \
  git add graphql/utils/matchMappers.js graphql/utils/matchAuth.js \
          graphql/config/dbTransaction.js graphql/resolvers/Play/MatchResults.js \
          graphql/model/PlayModel.js play/index.js \
          graphql/schema/Play.js graphql/schema/Auth.js \
          graphql/resolvers/Play/Queries.js graphql/resolvers/Play/Mutations.js \
          graphql/resolvers/Play/index.js graphql/dataloaders/matchLoader.js && \
  git commit -m "feat: record match results

Adds recordMatchResult, updateMatchResult, markMatchNotPlayed, addMatchGoal,
removeMatchGoal and getClubMembers. Until now nothing moved a match past team
selection, so no match could ever end up with a result.

Every result write is limited to [matchStartTime, matchStartTime + 24h) and to
the organiser or a club admin - of matches.club_id on intra-club matches, whose
home and away teams are temp teams, and of either side on inter-club ones. Each
write is one transaction: a status-guarded UPDATE, the roster replacement, and
a row in match_audit_log, so two admins racing cannot both record.

addPlayerToMatch and removePlayerFromMatch now require a token and let players
act only on themselves unless they are the organiser or an admin; removal is
also blocked from kickoff. Intra-club matches are created in team selection,
since they have no opponent to accept. auth's Player.id is now Int, matching
play.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Commit the docs and bump the submodule pointer**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi && \
  git add docs/superpowers/plans/2026-09-14-record-match-result-backend.md \
          docs/briefs/2026-09-11-record-match-result-frontend.md && \
  git commit -m "docs: record match result plan and frontend brief

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" && \
  git add functions && \
  git commit -m "chore: bump functions submodule to record match results

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Do **not** stage `.DS_Store` or `docs/BACKLOG.md`. Both had uncommitted changes before this work began.

---

## Follow-up (not in this plan)

- **Atomic capacity in `addPlayerToMatch`.** The count-then-insert is not transactional, so two players can both take the last slot. This bug existed before this work.
- **The RSA private key is hard-coded in `graphql/utils/common.js`.** Anyone with repo access can mint a valid token for any player. Move it to a secret and rotate it.
- **`fetchEnrolledPlayers` with a falsy `teamId`** still returns every player (BACKLOG, MEDIUM). This plan always passes a team id, so it is not reached here.
- **Rescheduling a fixture, push notifications, and an ageing sweep** are out of scope per the spec.
