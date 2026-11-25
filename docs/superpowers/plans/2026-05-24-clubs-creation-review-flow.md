# Clubs Creation & Review Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a player-initiated club creation flow with an admin approval state machine, back-and-forth review notes, and player alerts on status changes.

**Architecture:** Three new Auth-domain mutations (`createClub`, `updateClub`, `adminReviewClub`) and one query (`getClubsPendingReview`) follow the existing schema → model → resolver pattern. Club and Date types are extracted to a shared SDL module consumed by both the Auth and Play schemas. All DB functions live in `AuthModel.js` and are exported through the existing `model/index.js` barrel.

**Tech Stack:** Node.js 20, PostgreSQL (via `pg` pool), GraphQL 14 (`buildSchema` + `@graphql-tools/schema`), Express, Firebase Functions v2

> **Note:** No test framework is configured in this project. Each task includes manual verification steps via GraphiQL (available at the `/graphql` endpoint when running `firebase emulators:start --only functions`).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `graphql/schema/shared.js` | Create | `Club` type + `Date` scalar — shared between Auth and Play schemas |
| `graphql/schema/Auth.js` | Modify | Import shared; add `createClubInput`, `updateClubInput`, `adminReviewClubInput`; add 3 mutations + 1 query |
| `graphql/schema/Play.js` | Modify | Import shared; remove `Club` type + `Date` scalar |
| `graphql/model/AuthModel.js` | Modify | Add all club DB functions |
| `graphql/resolvers/Auth/Mutations.js` | Modify | Add `createClubResolver`, `updateClubResolver`, `adminReviewClubResolver` |
| `graphql/resolvers/Auth/Queries.js` | Modify | Add `getClubsPendingReviewResolver` |
| `graphql/resolvers/Auth/index.js` | Modify | Export new resolvers; add `Club` type resolver for `review_notes` serialisation |
| `graphql/resolvers/Play/index.js` | Modify | Add `Club` type resolver for `review_notes` serialisation |

---

## Task 1: DB Migration

**Files:** None (run directly against the database)

- [ ] **Step 1: Run the migration**

Connect to your Postgres instance and run:

```sql
ALTER TABLE test.clubs
  ADD COLUMN review_status VARCHAR(20) NOT NULL DEFAULT 'PENDING_REVIEW',
  ADD COLUMN review_notes  JSONB        NOT NULL DEFAULT '[]'::jsonb;
```

- [ ] **Step 2: Verify**

```sql
SELECT id, name, review_status, review_notes FROM test.clubs LIMIT 3;
```

Expected: all existing rows show `review_status = 'PENDING_REVIEW'` and `review_notes = []`.

---

## Task 2: Create `shared.js` and remove schema duplication

**Files:**
- Create: `graphql/schema/shared.js`
- Modify: `graphql/schema/Play.js`
- Modify: `graphql/schema/Auth.js`

- [ ] **Step 1: Create `graphql/schema/shared.js`**

```js
const sharedTypes = `
  scalar Date

  type Club {
    id: Int!
    name: String!
    description: String
    crest: String
    locality: String
    total_members: Int
    jersey_color_home: String
    jersey_color_away: String
    is_banned: Boolean
    review_status: String
    review_notes: String
    created_at: Date
    updated_at: Date
    creator: String
  }
`;

module.exports = sharedTypes;
```

- [ ] **Step 2: Update `graphql/schema/Play.js`**

Replace the top of the file so it imports `sharedTypes` and removes the `scalar Date` and `type Club` blocks (lines 16 and 52–65). The full updated file:

```js
const { buildSchema } = require("graphql");
const sharedTypes = require("./shared");

const schema = buildSchema(`
  ${sharedTypes}

  type Confirmation {
    message: String!
    status: Boolean
  }

  type AddPlayerToMatchConfirmation {
    addSuccessful: Boolean!
    message: String!
    playersHome: [Player]
    playersAway: [Player]
  }

  input createMatchInput {
    matchStartTime: Date!
    matchEndTime: Date!
    venueId: Int!
    description: String
    format: String!
    paymentUpiId: String
    paymentMode: String!
    entryAmount: Int
    homeTeamJerseyColor: String!
    awayTeamJerseyColor: String!
    homeTeam: Int!
    awayTeam: Int
    matchType: String!
    tempHomeTeamName: String
    tempAwayTeamName: String
    organiserTeam: String
  }

  input addPlayerToMatchInput {
    playerId: Int!
    matchId: ID!
    teamId: Int!
  }

  input playerMatchInput {
    playerId: Int!
  }

  input removePlayerFromMatchInput {
    matchId: ID!
    playerId: Int!
  }

  type Player {
    id: Int!
    firstName: String!
    lastName: String
    phone: String
    profilePicture: String
    position: String
  }

  type Venue {
    id: ID!
    name: String!
    address: String
    pincode: String
    locality: String
  }

  type Team {
    id: Int!
    name: String!
    jersey_color: String
    created_by: Int
  }

  union TeamData = Club | Team

  type Match {
    id: ID!
    matchStartTime: Date!
    matchEndTime: Date!
    venue: Venue
    description: String
    format: String!
    paymentUpiId: String
    paymentMode: String!
    entryAmount: Int
    matchType: String!
    matchFormat: String
    matchStatus: String
    homeTeamJerseyColor: String!
    awayTeamJerseyColor: String!
    homeTeam: TeamData!
    awayTeam: TeamData!
    organiser: Player
    homeTeamGoals: Int
    awayTeamGoals: Int
    playersHome: [Player]
    playersAway: [Player]
  }

  type Alert {
    id: ID!
    type: String!
    description: String!
    seen: Boolean!
    match: Match,
    player: Int,
    homeTeam: Club,
    awayTeam: Club,
    createdAt: Date!
    updatedAt: Date!
  }

  type Query {
    _empty: String
    getPlayerClubs: [Club]
    getClubsList: [Club]
    getAllVenues: [Venue]
    getPlayerMatches(data: playerMatchInput!): [Match]
    getMatchById(id: ID!): Match
    getPlayerAlertsForClub(clubId: Int!): [Alert]
  }

  type Mutation {
    createMatch(data: createMatchInput!): Confirmation
    addPlayerToMatch(data: addPlayerToMatchInput): AddPlayerToMatchConfirmation
    removePlayerFromMatch(data: removePlayerFromMatchInput): Confirmation
    respondToMatchInvitation(matchId: ID!, acceptInvite: Boolean!): Confirmation
  }
`);

module.exports = schema;
```

- [ ] **Step 3: Update `graphql/schema/Auth.js`**

Replace the `scalar Date` line and add the `sharedTypes` import. The full updated file (club inputs and operations will be added in Task 3 — for now just fix the duplication):

```js
const { buildSchema } = require("graphql");
const sharedTypes = require("./shared");

const schema = buildSchema(`
  ${sharedTypes}

  type User {
    id: ID!
    username: String!
    phone: String!
    position: String!
  }

  type Confirmation {
    message: String!
    status: Boolean
    jwt: String
  }

  scalar Phone

  input phoneInput {
    phone: Phone
  }

  input createUserInput {
    firstName: String!
    lastName: String!
    phone: String!
    position: String!
    passkey: String!
  }

  input VerifyPasskeyInput {
    phone: String!
    passkey: String!
  }

  type ClubBasic {
    id: Int!
    is_admin: Boolean!
    name: String
    description: String
    crest: String
    locality: String
  }

  type PlayerBasicDetails {
    id: Int!
    firstName: String!
    lastName: String
    position: String
    profilePicture: String
    is_banned: Boolean
    saved_upi_ids: [String]
    created_at: Date
    updated_at: Date
    phone: String
    allClubs: [ClubBasic]
  }

  type Query {
    verifyPasskeyForPhone(data: VerifyPasskeyInput!): Confirmation
    userWithPhoneExists(data: phoneInput!): Boolean!
    canUserCreateGame: Boolean!
    getPlayerBasicDetails: PlayerBasicDetails
  }

  type Mutation {
    createUser(data: createUserInput!): Confirmation
  }
`);

module.exports = schema;
```

- [ ] **Step 4: Verify schemas still load**

```bash
cd functions && node -e "require('./graphql/schema/Auth'); require('./graphql/schema/Play'); console.log('OK')"
```

Expected output: `OK` with no errors.

- [ ] **Step 5: Commit**

```bash
git add functions/graphql/schema/shared.js functions/graphql/schema/Auth.js functions/graphql/schema/Play.js
git commit -m "refactor: extract Club type and Date scalar to shared schema module"
```

---

## Task 3: Add club inputs and operations to `Auth.js` schema

**Files:**
- Modify: `graphql/schema/Auth.js`

- [ ] **Step 1: Add inputs, mutations, and query**

Replace the `type Query` and `type Mutation` blocks in `Auth.js` with the following (add the three inputs above `type Query`):

```js
// Inside the buildSchema template literal — replace from the inputs down

  input createClubInput {
    name: String!
    description: String
    crest: String
    locality: String
    jersey_color_home: String
    jersey_color_away: String
  }

  input updateClubInput {
    clubId: Int!
    name: String
    description: String
    crest: String
    locality: String
    jersey_color_home: String
    jersey_color_away: String
    note: String
  }

  input adminReviewClubInput {
    clubId: Int!
    action: String!
    note: String
  }

  type Query {
    verifyPasskeyForPhone(data: VerifyPasskeyInput!): Confirmation
    userWithPhoneExists(data: phoneInput!): Boolean!
    canUserCreateGame: Boolean!
    getPlayerBasicDetails: PlayerBasicDetails
    getClubsPendingReview: [Club]
  }

  type Mutation {
    createUser(data: createUserInput!): Confirmation
    createClub(data: createClubInput!): Confirmation
    updateClub(data: updateClubInput!): Confirmation
    adminReviewClub(data: adminReviewClubInput!): Confirmation
  }
```

- [ ] **Step 2: Verify schema loads**

```bash
cd functions && node -e "require('./graphql/schema/Auth'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add functions/graphql/schema/Auth.js
git commit -m "feat: add club creation and review schema to Auth"
```

---

## Task 4: Add club DB functions to `AuthModel.js`

**Files:**
- Modify: `graphql/model/AuthModel.js`

- [ ] **Step 1: Add all club functions**

Append the following to `graphql/model/AuthModel.js` before the `module.exports`:

```js
const appendReviewNote = async (clubId, message, senderRole) => {
  const note = JSON.stringify([{
    message,
    sender_role: senderRole,
    created_at: new Date().toISOString(),
  }]);
  await pool.query(
    `UPDATE test.clubs SET review_notes = review_notes || $1::jsonb WHERE id = $2`,
    [note, clubId]
  );
};

const createClubInDb = async ({
  name, description, crest, locality,
  jersey_color_home, jersey_color_away, creatorId,
}) => {
  const result = await pool.query(
    `INSERT INTO test.clubs
       (name, description, crest, locality, jersey_color_home, jersey_color_away,
        review_status, is_verified, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_REVIEW', false, NOW(), NOW())
     RETURNING id`,
    [name, description, crest, locality, jersey_color_home, jersey_color_away]
  );
  const clubId = result.rows[0].id;
  await pool.query(
    `INSERT INTO test.player_club_map (player_id, club_id, is_creator, is_admin)
     VALUES ($1, $2, true, true)`,
    [creatorId, clubId]
  );
  return clubId;
};

const getClubByIdFromDb = async (clubId) => {
  const result = await pool.query(
    `SELECT * FROM test.clubs WHERE id = $1`,
    [clubId]
  );
  return result.rows[0] || null;
};

const getClubCreatorFromDb = async (clubId) => {
  const result = await pool.query(
    `SELECT player_id FROM test.player_club_map
     WHERE club_id = $1 AND is_creator = true LIMIT 1`,
    [clubId]
  );
  return result.rows[0] || null;
};

const updateClubInDb = async ({
  clubId, name, description, crest, locality,
  jersey_color_home, jersey_color_away, note, currentStatus,
}) => {
  const shouldResetStatus = currentStatus === 'DECLINED';
  await pool.query(
    `UPDATE test.clubs
     SET name              = COALESCE($1, name),
         description       = COALESCE($2, description),
         crest             = COALESCE($3, crest),
         locality          = COALESCE($4, locality),
         jersey_color_home = COALESCE($5, jersey_color_home),
         jersey_color_away = COALESCE($6, jersey_color_away),
         review_status     = CASE WHEN $7 THEN 'PENDING_REVIEW' ELSE review_status END,
         updated_at        = NOW()
     WHERE id = $8`,
    [name, description, crest, locality, jersey_color_home, jersey_color_away, shouldResetStatus, clubId]
  );
  if (note) {
    await appendReviewNote(clubId, note, 'PLAYER');
  }
};

const adminReviewClubInDb = async ({ clubId, action, note }) => {
  const isVerified = action === 'APPROVED';
  await pool.query(
    `UPDATE test.clubs
     SET review_status = $1, is_verified = $2, updated_at = NOW()
     WHERE id = $3`,
    [action, isVerified, clubId]
  );
  if (note) {
    await appendReviewNote(clubId, note, 'ADMIN');
  }
};

const getClubsPendingReviewFromDb = async () => {
  const result = await pool.query(
    `SELECT * FROM test.clubs
     WHERE review_status IN ('PENDING_REVIEW', 'IN_REVIEW')
     ORDER BY created_at ASC`
  );
  return result.rows;
};

const createClubReviewAlertInDb = async (playerId, clubId, alertType, clubName) => {
  const descriptions = {
    CLUB_APPROVED: `Your club ${clubName} has been approved.`,
    CLUB_DECLINED: `Your club ${clubName} has been declined. Check the review notes.`,
  };
  await pool.query(
    `INSERT INTO test.alerts (player, type, description, home_team, seen)
     VALUES ($1, $2, $3, $4, false)`,
    [playerId, alertType, descriptions[alertType], clubId]
  );
};
```

- [ ] **Step 2: Add new functions to `module.exports`**

Replace the existing `module.exports` in `AuthModel.js`:

```js
module.exports = {
  getUserWithPhone,
  createUserModel,
  getPasskeyFromUserModel,
  canUserCreateGameModel,
  createClubInDb,
  getClubByIdFromDb,
  getClubCreatorFromDb,
  updateClubInDb,
  adminReviewClubInDb,
  getClubsPendingReviewFromDb,
  createClubReviewAlertInDb,
};
```

- [ ] **Step 3: Verify the module loads**

```bash
cd functions && node -e "const m = require('./graphql/model/AuthModel'); console.log(Object.keys(m))"
```

Expected output includes: `createClubInDb`, `getClubByIdFromDb`, `getClubCreatorFromDb`, `updateClubInDb`, `adminReviewClubInDb`, `getClubsPendingReviewFromDb`, `createClubReviewAlertInDb`

- [ ] **Step 4: Commit**

```bash
git add functions/graphql/model/AuthModel.js
git commit -m "feat: add club DB functions to AuthModel"
```

---

## Task 5: Add club mutation resolvers to `Auth/Mutations.js`

**Files:**
- Modify: `graphql/resolvers/Auth/Mutations.js`

- [ ] **Step 1: Update imports at the top of `Auth/Mutations.js`**

```js
const _get = require("lodash/get");

const {
  createUserModel,
  createClubInDb,
  getClubByIdFromDb,
  getClubCreatorFromDb,
  updateClubInDb,
  adminReviewClubInDb,
  createClubReviewAlertInDb,
} = require("../../model");
const { generateJWT, verifyJwt } = require("../../utils/common");
```

- [ ] **Step 2: Add the three resolvers after `createUserResolver`**

```js
const createClubResolver = async (obj, args, context) => {
  const { data } = args;
  let token = _get(context, "token", null);
  if (!token) return { message: "Unauthorized", status: false };

  token = token.split("Bearer ")[1];
  const user = await verifyJwt(token);
  const playerId = _get(user, "id", null);
  if (!playerId) return { message: "Unauthorized", status: false };

  try {
    await createClubInDb({ ...data, creatorId: playerId });
    return { message: "Club created and submitted for review.", status: true };
  } catch (err) {
    throw new Error(err.message);
  }
};

const updateClubResolver = async (obj, args, context) => {
  const { data } = args;
  let token = _get(context, "token", null);
  if (!token) return { message: "Unauthorized", status: false };

  token = token.split("Bearer ")[1];
  const user = await verifyJwt(token);
  const playerId = _get(user, "id", null);
  if (!playerId) return { message: "Unauthorized", status: false };

  try {
    const club = await getClubByIdFromDb(data.clubId);
    if (!club) return { message: "Club not found", status: false };

    const creator = await getClubCreatorFromDb(data.clubId);
    if (!creator || creator.player_id !== playerId) {
      return { message: "Forbidden", status: false };
    }

    await updateClubInDb({ ...data, currentStatus: club.review_status });
    return { message: "Club updated.", status: true };
  } catch (err) {
    throw new Error(err.message);
  }
};

const adminReviewClubResolver = async (obj, args) => {
  const { data } = args;
  const validActions = ["IN_REVIEW", "APPROVED", "DECLINED"];
  if (!validActions.includes(data.action)) {
    return { message: "Invalid action. Must be IN_REVIEW, APPROVED, or DECLINED.", status: false };
  }

  try {
    const club = await getClubByIdFromDb(data.clubId);
    if (!club) return { message: "Club not found", status: false };

    await adminReviewClubInDb(data);

    if (data.action === "APPROVED" || data.action === "DECLINED") {
      const creator = await getClubCreatorFromDb(data.clubId);
      if (creator) {
        await createClubReviewAlertInDb(
          creator.player_id,
          data.clubId,
          `CLUB_${data.action}`,
          club.name
        );
      }
    }

    return { message: `Club status updated to ${data.action}.`, status: true };
  } catch (err) {
    throw new Error(err.message);
  }
};
```

- [ ] **Step 3: Update `module.exports`**

```js
module.exports = {
  createUserResolver,
  createClubResolver,
  updateClubResolver,
  adminReviewClubResolver,
};
```

- [ ] **Step 4: Commit**

```bash
git add functions/graphql/resolvers/Auth/Mutations.js
git commit -m "feat: add createClub, updateClub, adminReviewClub resolvers"
```

---

## Task 6: Add club query resolver to `Auth/Queries.js`

**Files:**
- Modify: `graphql/resolvers/Auth/Queries.js`

- [ ] **Step 1: Add import**

Add to the existing imports at the top of `Auth/Queries.js`:

```js
const { getClubsPendingReviewFromDb } = require("../../model");
```

- [ ] **Step 2: Add resolver function** (before `module.exports`)

```js
const getClubsPendingReviewResolver = async () => {
  try {
    return await getClubsPendingReviewFromDb();
  } catch (err) {
    throw new Error(err.message);
  }
};
```

- [ ] **Step 3: Add to `module.exports`**

```js
module.exports = {
  verifyPasskeyResolver,
  userWithPhoneExistsResolver,
  canUserCreateGameResolver,
  getPlayerBasicDetails,
  getClubsPendingReviewResolver,
};
```

- [ ] **Step 4: Commit**

```bash
git add functions/graphql/resolvers/Auth/Queries.js
git commit -m "feat: add getClubsPendingReview query resolver"
```

---

## Task 7: Wire up in `Auth/index.js` and `Play/index.js`

**Files:**
- Modify: `graphql/resolvers/Auth/index.js`
- Modify: `graphql/resolvers/Play/index.js`

- [ ] **Step 1: Update `Auth/index.js`**

Replace the full file:

```js
const {
  verifyPasskeyResolver,
  userWithPhoneExistsResolver,
  canUserCreateGameResolver,
  getPlayerBasicDetails,
  getClubsPendingReviewResolver,
} = require("./Queries");
const {
  createUserResolver,
  createClubResolver,
  updateClubResolver,
  adminReviewClubResolver,
} = require("./Mutations");

const resolvers = {
  Club: {
    review_notes: (parent) => {
      if (!parent.review_notes) return "[]";
      return typeof parent.review_notes === "string"
        ? parent.review_notes
        : JSON.stringify(parent.review_notes);
    },
  },
  Query: {
    verifyPasskeyForPhone: verifyPasskeyResolver,
    userWithPhoneExists: userWithPhoneExistsResolver,
    canUserCreateGame: canUserCreateGameResolver,
    getPlayerBasicDetails,
    getClubsPendingReview: getClubsPendingReviewResolver,
  },
  Mutation: {
    createUser: createUserResolver,
    createClub: createClubResolver,
    updateClub: updateClubResolver,
    adminReviewClub: adminReviewClubResolver,
  },
};

module.exports = resolvers;
```

- [ ] **Step 2: Add Club type resolver to `Play/index.js`**

In `Play/index.js`, add a `Club` key to the existing `resolvers` object alongside the existing `Match`, `Alert`, and `TeamData` keys:

```js
Club: {
  review_notes: (parent) => {
    if (!parent.review_notes) return "[]";
    return typeof parent.review_notes === "string"
      ? parent.review_notes
      : JSON.stringify(parent.review_notes);
  },
},
```

Do not replace the existing `Match`, `Alert`, `TeamData`, `Query`, or `Mutation` keys — just insert this block above `Match`.

- [ ] **Step 3: Verify both endpoints load**

```bash
cd functions && node -e "require('./auth'); require('./play'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add functions/graphql/resolvers/Auth/index.js functions/graphql/resolvers/Play/index.js
git commit -m "feat: wire up club resolvers and add Club type resolver for review_notes"
```

---

## Task 8: Manual verification via GraphiQL

Start the emulator:

```bash
cd functions && npm run serve
```

Auth endpoint is available at `http://localhost:5001/<project-id>/us-central1/ballersApiAuth/graphql`

- [ ] **Step 1: Create a club (as a player)**

```graphql
mutation {
  createClub(data: {
    name: "Northside FC"
    description: "A local 5-aside club"
    locality: "Andheri"
    jersey_color_home: "blue"
    jersey_color_away: "white"
  }) {
    message
    status
  }
}
```

Expected: `{ "message": "Club created and submitted for review.", "status": true }`

Verify in DB: `SELECT id, name, review_status, is_verified FROM test.clubs ORDER BY id DESC LIMIT 1;`
Expected: `review_status = 'PENDING_REVIEW'`, `is_verified = false`

Also verify: `SELECT * FROM test.player_club_map WHERE club_id = <new_club_id>;`
Expected: `is_creator = true`, `is_admin = true`

- [ ] **Step 2: Admin marks club as IN_REVIEW**

```graphql
mutation {
  adminReviewClub(data: {
    clubId: <new_club_id>
    action: "IN_REVIEW"
  }) {
    message
    status
  }
}
```

Expected: `{ "message": "Club status updated to IN_REVIEW.", "status": true }`

- [ ] **Step 3: Admin declines with a note**

```graphql
mutation {
  adminReviewClub(data: {
    clubId: <new_club_id>
    action: "DECLINED"
    note: "Name too similar to an existing club. Please rename."
  }) {
    message
    status
  }
}
```

Expected: `status: true`

Verify in DB: `SELECT review_status, review_notes, is_verified FROM test.clubs WHERE id = <new_club_id>;`
Expected: `review_status = 'DECLINED'`, `review_notes = [{"message": "Name too similar...", "sender_role": "ADMIN", ...}]`, `is_verified = false`

Verify alert: `SELECT * FROM test.alerts WHERE type = 'CLUB_DECLINED' ORDER BY id DESC LIMIT 1;`
Expected: row exists with correct `player`, `description`, and `home_team = <club_id>`

- [ ] **Step 4: Player updates club and resubmits**

```graphql
mutation {
  updateClub(data: {
    clubId: <new_club_id>
    name: "North Side FC"
    note: "Renamed to avoid conflict."
  }) {
    message
    status
  }
}
```

Expected: `status: true`

Verify in DB: `SELECT name, review_status, review_notes FROM test.clubs WHERE id = <new_club_id>;`
Expected: `name = 'North Side FC'`, `review_status = 'PENDING_REVIEW'`, `review_notes` now has two entries (admin decline note + player response note)

- [ ] **Step 5: Admin approves**

```graphql
mutation {
  adminReviewClub(data: {
    clubId: <new_club_id>
    action: "APPROVED"
  }) {
    message
    status
  }
}
```

Expected: `status: true`

Verify: `SELECT review_status, is_verified FROM test.clubs WHERE id = <new_club_id>;`
Expected: `review_status = 'APPROVED'`, `is_verified = true`

Verify alert: `SELECT * FROM test.alerts WHERE type = 'CLUB_APPROVED' ORDER BY id DESC LIMIT 1;`

- [ ] **Step 6: Admin queries pending clubs**

```graphql
query {
  getClubsPendingReview {
    id
    name
    review_status
    review_notes
  }
}
```

Expected: the newly approved club does NOT appear (it's `APPROVED`). Create another club to verify it shows up.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete clubs creation and review flow"
```
