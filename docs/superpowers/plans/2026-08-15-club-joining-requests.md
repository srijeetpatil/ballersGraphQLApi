# Club Joining Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player ask to join a club and let a club admin accept or reject that request.

**Architecture:** A new `test.club_join_requests` table holds the request and its status; `test.alerts` stays the notification layer and points at a request through a new `request_id` column. New DB functions live in their own model file rather than growing the 484-line `PlayModel.js`, and the two resolvers live in their own resolver file rather than growing the 433-line `Mutations.js`. The accept path is the codebase's first transaction.

**Tech Stack:** Node 20, Firebase Cloud Functions, express-graphql, `graphql` v14 (`buildSchema` SDL), `pg` connection pool, DataLoader, lodash.

**Spec:** `docs/superpowers/specs/2026-08-14-club-joining-requests-design.md`

## Global Constraints

- **Do not commit.** Tasks 2–4 leave the working tree dirty on purpose. The human partner gates commits behind manual dev verification (Task 5); commits happen in Task 6.
- **Do not write tests and do not create test files.** No test framework is installed — `package.json` declares `node --test test/` but the suite was deleted in commit `2533889`. Verification is manual.
- No migration system. DDL is run by hand (Task 1).
- Code lives in the `functions` git **submodule** at `/Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions` — its own git repo, branch `searchClubs`. Run git commands from inside it.
- Schema is one SDL template literal passed to `buildSchema` in `graphql/schema/Play.js`. There are no `.graphql` files.
- Style: `const` arrow functions, double-quoted strings, 2-space indent, parameterized `$1` queries via `pool.query`, `_get` from `lodash/get` for optional reads.
- Error strings must match the spec's Error Handling table verbatim.
- Model functions are re-exported through the `graphql/model/index.js` barrel; resolvers import from `"../../model"`, never from a model file directly.

---

### Task 1: Database schema (manual DDL — human-run)

**Files:** none — this runs against the dev database.

**Interfaces:**
- Consumes: nothing.
- Produces: `test.club_join_requests` table, its partial unique index, and `test.alerts.request_id`. Every later task depends on these existing.

- [ ] **Step 1: Create the table and index**

```sql
CREATE TABLE test.club_join_requests (
  id          SERIAL PRIMARY KEY,
  player_id   INT  NOT NULL REFERENCES test.players(id),
  club_id     INT  NOT NULL REFERENCES test.clubs(id),
  note        TEXT,
  status      TEXT NOT NULL DEFAULT 'PENDING',
  resolved_by INT  REFERENCES test.players(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_pending_club_join_request
  ON test.club_join_requests (player_id, club_id)
  WHERE status = 'PENDING';
```

- [ ] **Step 2: Add the alerts pointer column**

```sql
ALTER TABLE test.alerts ADD COLUMN IF NOT EXISTS request_id INT;
```

- [ ] **Step 2b: Add the membership unique index (added after review)**

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_player_club_membership
  ON test.player_club_map (player_id, club_id);
```

`test.player_club_map` had no uniqueness on `(player_id, club_id)` — only a primary key on
`id` and two foreign keys. The accept path inserts unconditionally, so this makes duplicate
membership structurally impossible rather than merely unreachable; `getPlayerClubsFromDb`
uses an `INNER JOIN`, so a duplicate would list the club twice in `getPlayerClubs`. Checked
against dev: no duplicates exist, so this applies cleanly.

- [ ] **Step 3: Confirm both landed**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'test' AND table_name = 'club_join_requests'
ORDER BY ordinal_position;

SELECT indexname FROM pg_indexes
WHERE schemaname = 'test' AND tablename = 'club_join_requests';

SELECT column_name FROM information_schema.columns
WHERE table_schema = 'test' AND table_name = 'alerts' AND column_name = 'request_id';
```

Expected: 8 columns; an index named `uniq_pending_club_join_request`; one row for `request_id`. Everything from Task 2 onward fails without these.

---

### Task 2: Model layer

**Files:**
- Create: `functions/graphql/model/ClubJoinRequestModel.js`
- Modify: `functions/graphql/model/index.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, all re-exported through the barrel:
  - `createClubJoinRequestInDb(playerId, clubId, note)` → `Promise<Object>` — the inserted row. **Propagates the raw `pg` error** so the resolver can read `error.code`.
  - `getClubJoinRequestByIdFromDb(requestId)` → `Promise<Object|null>`
  - `acceptClubJoinRequestInDb(requestId, playerId, clubId, adminId)` → `Promise<Object|null>` — updated row, or `null` if it was no longer `PENDING`
  - `rejectClubJoinRequestInDb(requestId, adminId)` → `Promise<Object|null>` — same contract
  - `createJoinRequestAlerts(adminIds, { requestId, clubId, description })` → `Promise<void>`
  - `createJoinRequestOutcomeAlert({ playerId, clubId, requestId, accepted, description })` → `Promise<void>`
  - `markAlertsSeenForRequest(requestId)` → `Promise<void>`

- [ ] **Step 1: Create the model file**

Create `functions/graphql/model/ClubJoinRequestModel.js`:

```js
const pool = require("../config/dbConfig.js");

const createClubJoinRequestInDb = async (playerId, clubId, note) => {
  const query = `
    INSERT INTO test.club_join_requests (player_id, club_id, note, status)
    VALUES ($1, $2, $3, 'PENDING')
    RETURNING *;
  `;

  const result = await pool.query(query, [playerId, clubId, note || null]);
  return result.rows[0];
};

const getClubJoinRequestByIdFromDb = async (requestId) => {
  const result = await pool.query(
    "SELECT * FROM test.club_join_requests WHERE id = $1",
    [requestId]
  );
  return result.rows[0] || null;
};

const acceptClubJoinRequestInDb = async (
  requestId,
  playerId,
  clubId,
  adminId
) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const updateResult = await client.query(
      `UPDATE test.club_join_requests
       SET status = 'ACCEPTED', resolved_by = $2, updated_at = now()
       WHERE id = $1 AND status = 'PENDING'
       RETURNING *;`,
      [requestId, adminId]
    );

    if (!updateResult.rows.length) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO test.player_club_map (player_id, club_id, is_creator, is_admin)
       VALUES ($1, $2, false, false);`,
      [playerId, clubId]
    );

    await client.query("COMMIT");
    return updateResult.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

const rejectClubJoinRequestInDb = async (requestId, adminId) => {
  const result = await pool.query(
    `UPDATE test.club_join_requests
     SET status = 'REJECTED', resolved_by = $2, updated_at = now()
     WHERE id = $1 AND status = 'PENDING'
     RETURNING *;`,
    [requestId, adminId]
  );
  return result.rows[0] || null;
};

const createJoinRequestAlerts = async (
  adminIds,
  { requestId, clubId, description }
) => {
  const query = `
    INSERT INTO test.alerts (player, type, description, home_team, request_id, seen)
    VALUES ($1, 'CLUB_JOINING_REQUEST', $2, $3, $4, false);
  `;

  for (const admin of adminIds) {
    await pool.query(query, [
      admin.player_id,
      description,
      clubId,
      requestId,
    ]);
  }
};

const createJoinRequestOutcomeAlert = async ({
  playerId,
  clubId,
  requestId,
  accepted,
  description,
}) => {
  const alertType = accepted
    ? "CLUB_JOINING_REQUEST_ACCEPTED"
    : "CLUB_JOINING_REQUEST_REJECTED";

  await pool.query(
    `INSERT INTO test.alerts (player, type, description, home_team, request_id, seen)
     VALUES ($1, $2, $3, $4, $5, false);`,
    [playerId, alertType, description, clubId, requestId]
  );
};

const markAlertsSeenForRequest = async (requestId) => {
  await pool.query(
    "UPDATE test.alerts SET seen = true WHERE request_id = $1",
    [requestId]
  );
};

module.exports = {
  createClubJoinRequestInDb,
  getClubJoinRequestByIdFromDb,
  acceptClubJoinRequestInDb,
  rejectClubJoinRequestInDb,
  createJoinRequestAlerts,
  createJoinRequestOutcomeAlert,
  markAlertsSeenForRequest,
};
```

Two things that are deliberate and must not be "cleaned up":

- `createClubJoinRequestInDb` has **no try/catch**. The resolver needs `error.code === "23505"` to detect the unique-index violation; wrapping in `new Error(...)` destroys `.code` and the duplicate-request message becomes unreachable.
- `acceptClubJoinRequestInDb` uses `pool.connect()` rather than `pool.query`. The `UPDATE ... AND status = 'PENDING'` returning zero rows is how a second admin racing the first is detected — it rolls back and returns `null` rather than inserting a duplicate membership row.

- [ ] **Step 2: Add the file to the model barrel**

`functions/graphql/model/index.js` currently reads:

```js
const AuthModel = require("./AuthModel");
const PlayModel = require("./PlayModel");

module.exports = { ...AuthModel, ...PlayModel };
```

Replace it with:

```js
const AuthModel = require("./AuthModel");
const PlayModel = require("./PlayModel");
const ClubJoinRequestModel = require("./ClubJoinRequestModel");

module.exports = { ...AuthModel, ...PlayModel, ...ClubJoinRequestModel };
```

- [ ] **Step 3: Verify the module loads and every export is reachable**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && node -e "
const m = require('./graphql/model');
const names = [
  'createClubJoinRequestInDb','getClubJoinRequestByIdFromDb',
  'acceptClubJoinRequestInDb','rejectClubJoinRequestInDb',
  'createJoinRequestAlerts','createJoinRequestOutcomeAlert',
  'markAlertsSeenForRequest',
  'fetchPlayerClubMap','getTeamAdminIds','getClubByIdFromDb'
];
const missing = names.filter((n) => typeof m[n] !== 'function');
console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'all exports present');
"
```

Expected: `all exports present`. The last three are pre-existing functions Task 4 needs; this confirms the barrel still exposes them.

- [ ] **Step 4: Do not commit**

Leave changes uncommitted.

---

### Task 3: GraphQL schema

**Files:**
- Modify: `functions/graphql/schema/Play.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `JoinRequestAction` enum, `sendClubJoiningRequestInput`, `updateClubJoiningRequestInput`, `ClubJoinRequest` type, two `Mutation` fields, and `Alert.requestId`. Task 4's resolvers implement these.

- [ ] **Step 1: Add the enum, inputs, and type**

In `functions/graphql/schema/Play.js`, insert this immediately **before** `type Query {`:

```graphql
  enum JoinRequestAction {
    ACCEPT
    REJECT
  }

  input sendClubJoiningRequestInput {
    clubId: Int!
    note: String
  }

  input updateClubJoiningRequestInput {
    requestId: Int!
    action: JoinRequestAction!
  }

  type ClubJoinRequest {
    id: ID!
    player: Player
    club: Club
    note: String
    status: String!
    createdAt: Date!
    updatedAt: Date!
  }
```

`Player`, `Club`, and `Date` already exist — `Date` comes from `./shared`. This is the schema's first `enum`; `buildSchema` supports enums in SDL with no extra wiring.

- [ ] **Step 2: Add `requestId` to the Alert type**

The `Alert` type currently ends:

```graphql
    player: Int,
    homeTeam: Club,
    awayTeam: Club,
    createdAt: Date!
    updatedAt: Date!
  }
```

Add `requestId` so a client can act on the alert it received:

```graphql
    player: Int,
    homeTeam: Club,
    awayTeam: Club,
    requestId: Int
    createdAt: Date!
    updatedAt: Date!
  }
```

- [ ] **Step 3: Add the two mutations**

The `Mutation` block currently reads:

```graphql
  type Mutation {
    createMatch(data: createMatchInput!): Confirmation
    addPlayerToMatch(data: addPlayerToMatchInput): AddPlayerToMatchConfirmation
    removePlayerFromMatch(data: removePlayerFromMatchInput): Confirmation
    respondToMatchInvitation(matchId: ID!, acceptInvite: Boolean!): Confirmation
  }
```

Add two lines:

```graphql
  type Mutation {
    createMatch(data: createMatchInput!): Confirmation
    addPlayerToMatch(data: addPlayerToMatchInput): AddPlayerToMatchConfirmation
    removePlayerFromMatch(data: removePlayerFromMatchInput): Confirmation
    respondToMatchInvitation(matchId: ID!, acceptInvite: Boolean!): Confirmation
    sendClubJoiningRequest(data: sendClubJoiningRequestInput!): ClubJoinRequest
    updateClubJoiningRequest(data: updateClubJoiningRequestInput!): ClubJoinRequest
  }
```

These two return the entity rather than `Confirmation`, unlike the four above them. That divergence is deliberate and recorded in the spec — the client needs the request `id` after creation and the new `status` after resolution.

- [ ] **Step 4: Verify the schema builds**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && node -e "
const schema = require('./graphql/schema/Play');
const t = schema.getType('ClubJoinRequest');
const e = schema.getType('JoinRequestAction');
const m = schema.getMutationType().getFields();
console.log('ClubJoinRequest fields:', Object.keys(t.getFields()).join(','));
console.log('JoinRequestAction values:', e.getValues().map((v) => v.name).join(','));
console.log('sendClubJoiningRequest:', !!m.sendClubJoiningRequest);
console.log('updateClubJoiningRequest:', !!m.updateClubJoiningRequest);
console.log('Alert.requestId:', !!schema.getType('Alert').getFields().requestId);
"
```

Expected: the field list including `player,club,note,status,createdAt,updatedAt`; values `ACCEPT,REJECT`; and three `true` lines. An SDL typo fails here rather than at request time.

- [ ] **Step 5: Do not commit**

Leave changes uncommitted.

---

### Task 4: Resolvers and wiring

**Files:**
- Create: `functions/graphql/resolvers/Play/ClubJoinRequests.js`
- Modify: `functions/graphql/resolvers/Play/index.js`
- Modify: `functions/graphql/resolvers/Play/Queries.js` (alert row mapping, one line)

**Interfaces:**
- Consumes: every model function from Task 2's Produces list; the schema from Task 3; and these pre-existing functions from the `"../../model"` barrel — `fetchPlayerClubMap(playerId, clubId)` → `Promise<Array>` (empty array means not a member; each row has an `is_admin` boolean), `getTeamAdminIds(clubId)` → `Promise<Array<{player_id}>>`, `getClubByIdFromDb(clubId)` → `Promise<Object|null>` (row has a `name`).
- Produces: `sendClubJoiningRequest`, `updateClubJoiningRequest`, and the `ClubJoinRequest` field-resolver map.

- [ ] **Step 1: Create the resolver file**

Create `functions/graphql/resolvers/Play/ClubJoinRequests.js`:

```js
const _get = require("lodash/get");
const _isEqual = require("lodash/isEqual");
const _some = require("lodash/some");

const { verifyJwt } = require("../../utils/common");
const {
  getClubByIdFromDb,
  fetchPlayerClubMap,
  getTeamAdminIds,
  createClubJoinRequestInDb,
  getClubJoinRequestByIdFromDb,
  acceptClubJoinRequestInDb,
  rejectClubJoinRequestInDb,
  createJoinRequestAlerts,
  createJoinRequestOutcomeAlert,
  markAlertsSeenForRequest,
} = require("../../model");

const playerLoader = require("../../dataloaders/playerLoader");
const { clubLoader } = require("../../dataloaders/teamLoaders");

const resolvePlayerIdFromToken = async (context) => {
  let token = _get(context, "token", null);

  if (!token) {
    throw new Error("Missing token");
  }

  token = token.split("Bearer ")[1];
  const user = await verifyJwt(token);
  const playerId = _get(user, "id", null);

  if (!playerId) {
    throw new Error("Missing player ID, Invalid JWT");
  }

  return playerId;
};

const buildPlayerName = (player) =>
  [_get(player, "first_name", null), _get(player, "last_name", null)]
    .filter(Boolean)
    .join(" ");

const mapJoinRequestRow = (row) => ({
  ...row,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const sendClubJoiningRequest = async (_obj, args, context) => {
  const { data } = args;
  const clubId = _get(data, "clubId", null);
  const note = _get(data, "note", null);

  const playerId = await resolvePlayerIdFromToken(context);

  if (!clubId) {
    throw new Error("Club ID is required");
  }

  const club = await getClubByIdFromDb(clubId);
  if (!club) {
    throw new Error("Club not found");
  }

  const membership = await fetchPlayerClubMap(playerId, clubId);
  if (membership.length) {
    throw new Error("Player is already a member of this club");
  }

  let request;
  try {
    request = await createClubJoinRequestInDb(playerId, clubId, note);
  } catch (error) {
    if (_isEqual(_get(error, "code", null), "23505")) {
      throw new Error("A join request is already pending for this club");
    }
    throw new Error("Failed to create join request: " + error.message);
  }

  try {
    const admins = await getTeamAdminIds(clubId);

    if (admins.length) {
      const player = await playerLoader.load(playerId);
      const description = `${buildPlayerName(player)} has requested to join ${
        club.name
      }. Click to respond.`;

      await createJoinRequestAlerts(admins, {
        requestId: request.id,
        clubId,
        description,
      });
    }
  } catch (error) {
    console.error("Failed to create join request alerts:", error);
  }

  return mapJoinRequestRow(request);
};

const updateClubJoiningRequest = async (_obj, args, context) => {
  const { data } = args;
  const requestId = _get(data, "requestId", null);
  const action = _get(data, "action", null);

  const adminId = await resolvePlayerIdFromToken(context);

  if (!requestId) {
    throw new Error("Request ID is required");
  }

  const request = await getClubJoinRequestByIdFromDb(requestId);
  if (!request) {
    throw new Error("Join request not found");
  }

  if (!_isEqual(request.status, "PENDING")) {
    throw new Error("This join request has already been resolved");
  }

  const adminMembership = await fetchPlayerClubMap(adminId, request.club_id);
  const isAdmin = _some(adminMembership, (row) =>
    _isEqual(_get(row, "is_admin", false), true)
  );

  if (!isAdmin) {
    throw new Error("Only a club admin can respond to join requests");
  }

  const accepted = _isEqual(action, "ACCEPT");
  let updated;

  try {
    updated = accepted
      ? await acceptClubJoinRequestInDb(
          requestId,
          request.player_id,
          request.club_id,
          adminId
        )
      : await rejectClubJoinRequestInDb(requestId, adminId);
  } catch (error) {
    throw new Error("Failed to update join request: " + error.message);
  }

  if (!updated) {
    throw new Error("This join request has already been resolved");
  }

  try {
    await markAlertsSeenForRequest(requestId);

    const club = await clubLoader.load(request.club_id);
    const clubName = _get(club, "name", "the club");
    const description = accepted
      ? `Your request to join ${clubName} has been accepted.`
      : `Your request to join ${clubName} was not accepted.`;

    await createJoinRequestOutcomeAlert({
      playerId: request.player_id,
      clubId: request.club_id,
      requestId,
      accepted,
      description,
    });
  } catch (error) {
    console.error("Failed to finalise join request alerts:", error);
  }

  return mapJoinRequestRow(updated);
};

const ClubJoinRequest = {
  player: async (parent) => {
    const player = await playerLoader.load(parent.player_id);
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
  },
  club: async (parent) => await clubLoader.load(parent.club_id),
};

module.exports = {
  sendClubJoiningRequest,
  updateClubJoiningRequest,
  ClubJoinRequest,
};
```

Three deliberate choices:

- **Alert failures do not fail the mutation.** Both alert blocks are wrapped in a `try/catch` that logs. The request row is already committed; losing a notification must not surface as a failed request to the user, and must not leave the caller thinking their accept did not apply.
- **The `!updated` check** catches the race where another admin resolved the request between the `PENDING` read and the `UPDATE`. The model returns `null` in exactly that case.
- **`mapJoinRequestRow` spreads the raw row**, so `player_id` and `club_id` survive for the `ClubJoinRequest.player` / `.club` field resolvers while `createdAt` / `updatedAt` get their camelCase names.

- [ ] **Step 2: Wire the resolvers into the resolver map**

In `functions/graphql/resolvers/Play/index.js`, add a third require beneath the existing two:

```js
const {
  sendClubJoiningRequest,
  updateClubJoiningRequest,
  ClubJoinRequest,
} = require("./ClubJoinRequests");
```

Then register the type resolver alongside `Match` and `Alert`:

```js
  Match,
  Alert,
  ClubJoinRequest,
```

and add both mutations to the `Mutation` block:

```js
  Mutation: {
    createMatch: createMatchResolver,
    addPlayerToMatch: addPlayerToMatch,
    removePlayerFromMatch: removePlayerFromMatch,
    respondToMatchInvitation: respondToMatchInvitationResolver,
    sendClubJoiningRequest,
    updateClubJoiningRequest,
  },
```

- [ ] **Step 3: Expose `requestId` on fetched alerts**

`getPlayerAlertsForClub` in `functions/graphql/resolvers/Play/Queries.js` maps alert rows to camelCase. It currently reads:

```js
      matchId: alert.match_id,
      homeTeam: alert.home_team,
      awayTeam: alert.away_team,
```

Add one line so the new schema field is populated:

```js
      matchId: alert.match_id,
      requestId: alert.request_id,
      homeTeam: alert.home_team,
      awayTeam: alert.away_team,
```

Without this the field exists in the schema but always resolves `null`, and an admin's alert cannot be acted on.

- [ ] **Step 4: Verify everything loads and is wired**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && node -e "
require('./graphql/schema/Play');
const r = require('./graphql/resolvers/Play');
console.log('sendClubJoiningRequest:', typeof r.Mutation.sendClubJoiningRequest);
console.log('updateClubJoiningRequest:', typeof r.Mutation.updateClubJoiningRequest);
console.log('ClubJoinRequest.player:', typeof r.ClubJoinRequest.player);
console.log('ClubJoinRequest.club:', typeof r.ClubJoinRequest.club);
" && node -e "require('./play'); console.log('app loads OK')"
```

Expected: four `function` lines and `app loads OK`. This proves the modules parse, the schema builds, and the resolver map is wired — it does **not** hit the database.

- [ ] **Step 5: Do not commit**

Leave changes uncommitted. Proceed to Task 5.

---

### Task 5: Manual dev verification (human-run)

**Files:** none — this is the verification gate.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: go/no-go for Task 6.

- [ ] **Step 1: Start the emulator**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && npm run serve
```

Open the GraphiQL endpoint printed for `ballersApiPlay` at `/graphql`. Both mutations require an `Authorization: Bearer <jwt>` header — set it in the header editor, which is already enabled.

- [ ] **Step 2: Send a request**

```graphql
mutation {
  sendClubJoiningRequest(data: { clubId: <CLUB_ID>, note: "Keen to play" }) {
    id
    status
    note
    player { id firstName }
    club { id name }
    createdAt
  }
}
```

Use a JWT for a player who is **not** a member of `<CLUB_ID>`. Expect `status: "PENDING"` and a real `id`.

- [ ] **Step 3: Walk the checklist**

- Same player sends again → `"A join request is already pending for this club"`
- A player who **is** already a member sends → `"Player is already a member of this club"`
- Non-existent `clubId` → `"Club not found"`
- **Club eligibility (added after review):** requesting to join a club with
  `review_status <> 'APPROVED'`, and one with `is_banned = true`, must BOTH return exactly
  `"Club not found"` — indistinguishable from a club that does not exist. Then confirm the
  positive case still works: a club with `is_banned` set to NULL (not false) must still
  accept requests, since the gate mirrors SQL's `IS NOT TRUE`.
- No `Authorization` header → `"Missing token"`
- Every admin of the club sees a `CLUB_JOINING_REQUEST` alert via `getPlayerAlertsForClub(clubId: <CLUB_ID>)`, each with a non-null `requestId` — **this is the field most likely to silently be null**
- A club **member who is not an admin** calls `updateClubJoiningRequest` → `"Join request not found"`
- A player in a **different club** calls it → `"Join request not found"`, byte-identical
- **Enumeration check (added after review):** as a player who admins nothing, call
  `updateClubJoiningRequest` against a non-existent id, a real PENDING id, and a real
  RESOLVED id. All three must return **exactly** `"Join request not found"`. Any difference
  between them re-opens the disclosure this fix closed.
- Admin rejects → `status: "REJECTED"`, **no** new `player_club_map` row, requester gets `CLUB_JOINING_REQUEST_REJECTED`, admins' alerts now `seen: true`
- The rejected player requests again → allowed; a new `PENDING` row sits alongside the `REJECTED` one
- Admin accepts → `status: "ACCEPTED"`, a `player_club_map` row appears with `is_creator` and `is_admin` both false, requester gets `CLUB_JOINING_REQUEST_ACCEPTED`
- Either mutation called twice on the same request → `"This join request has already been resolved"`
- `action: MAYBE` → rejected by schema validation before the resolver runs
- The accepted player now appears in `getPlayerClubs`, and `getPlayerMatches(data: { playerId, clubId })` works for that club

- [ ] **Step 4: Verify the accept transaction**

```sql
SELECT r.id, r.status, r.resolved_by,
       (SELECT count(*) FROM test.player_club_map m
        WHERE m.player_id = r.player_id AND m.club_id = r.club_id) AS membership_rows
FROM test.club_join_requests r
ORDER BY r.id DESC LIMIT 10;
```

Every `ACCEPTED` row must show exactly `1` membership row — never `0` (transaction half-applied) and never `2` (double accept). `REJECTED` and `PENDING` rows must show `0`.

- [ ] **Step 5: Gate**

If anything fails, fix it and re-run this task. Only proceed once the checklist passes.

---

### Task 6: Commit

**Files:**
- Commit in the `functions` submodule: `graphql/model/ClubJoinRequestModel.js`, `graphql/model/index.js`, `graphql/schema/Play.js`, `graphql/resolvers/Play/ClubJoinRequests.js`, `graphql/resolvers/Play/index.js`, `graphql/resolvers/Play/Queries.js`
- Commit in the outer repo: this plan, and the submodule pointer

**Interfaces:**
- Consumes: a passing Task 5.
- Produces: nothing.

- [ ] **Step 1: Review the diff**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && \
  git branch --show-current && git status --short && git diff
```

Expected branch `searchClubs`; exactly the six files above, one of them new and untracked.

- [ ] **Step 2: Commit the submodule**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions && \
  git add graphql/model/ClubJoinRequestModel.js graphql/model/index.js \
          graphql/schema/Play.js graphql/resolvers/Play/ClubJoinRequests.js \
          graphql/resolvers/Play/index.js graphql/resolvers/Play/Queries.js && \
  git commit -m "feat: add club joining requests

Adds sendClubJoiningRequest and updateClubJoiningRequest. Requests live in
test.club_join_requests rather than in alerts, because alerts.player is the
recipient and has nowhere to record who is asking to join; alerts remain the
notification layer and point at a request through a new request_id column.

The requesting player comes from the JWT so a caller cannot create requests
in another player's name. A partial unique index on (player_id, club_id)
WHERE status = 'PENDING' allows one open request per club while keeping
rejected ones as history, so a rejected player may re-apply.

The accept path runs in a transaction - the first in this codebase - because
it writes both the membership row and the status update. Its UPDATE is
guarded on status = 'PENDING' so two admins racing cannot both accept."
```

- [ ] **Step 3: Commit the plan and bump the submodule pointer**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi && \
  git add docs/superpowers/plans/2026-08-15-club-joining-requests.md && \
  git commit -m "docs: implementation plan for club joining requests" && \
  git add functions && \
  git commit -m "chore: bump functions submodule to club joining requests"
```

Do **not** stage `.DS_Store`, which is modified and unrelated.

---

## Follow-up (not in this plan)

- An admin-facing `getClubJoiningRequests(clubId)` query — admins currently act through the alert feed only.
- Withdrawing a pending request, and the inverse "invite a player" flow.
- Alert fan-out is a loop of `await pool.query`, following `createMatchInviteAlerts`; a mid-loop failure notifies some admins and not others. Accepted, and now additionally guarded by the log-and-continue `catch`.
