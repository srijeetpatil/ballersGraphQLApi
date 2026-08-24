# Club Joining Requests — Design

**Date:** 2026-08-14
**Branch:** `searchClubs` (functions submodule)
**Status:** Approved

## Purpose

A player has no way to ask to join a club. Membership rows in `test.player_club_map` are
only ever written by `createClubInDb` (for the creator). This adds two mutations —
`sendClubJoiningRequest` and `updateClubJoiningRequest` — giving a player a way to apply
and a club admin a way to accept or reject.

## Decisions

- **Requests live in their own table, not in `alerts`.** In `test.alerts` the `player`
  column is the *recipient*, not the actor: `createMatchInviteAlerts` writes each admin's
  id into it, and `getPlayerAlertsForClubFromDb` reads `WHERE player = $1` for the viewing
  player. A request stored only as alerts therefore has nowhere to record **who is asking
  to join**. `alerts` also has no status column (only `seen`), and fanning one request out
  to N admins would produce N rows with no single id for `updateClubJoiningRequest` to
  take. `alerts` stays the notification layer and points at the request, exactly as a
  `MATCH_INVITE` alert points at a match via `match_id`.
- **The requesting player comes from the JWT, not the input.** Taking `playerId` from
  input would let any authenticated caller create requests in another player's name.
  `getPlayerClubs` and `getPlayerAlertsForClub` already read the player from
  `context.token`; these mutations follow that.
- **Rejected players may re-apply freely.** Every request is kept as a history row. A
  partial unique index permits exactly one `PENDING` request per (player, club) while
  allowing unlimited resolved ones. No cooldown.
- **Both outcomes notify the requester.** `getPlayerAlertsForClub` authenticates by JWT
  but does **not** require club membership, so a rejected non-member still receives the
  alert.
- **The accept path runs in a transaction.** It writes to two tables; see Concurrency.
- **These mutations return the entity and throw on error**, unlike the four existing
  mutations, which return `Confirmation` and signal failure as `{status: false, message}`.
  Accepted as a deliberate divergence: the client needs the request `id` after creation
  and the new `status` after resolution. Errors surface as GraphQL errors, matching every
  *query* in this codebase.

## Schema changes (manual DDL — no migration system in this repo)

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

ALTER TABLE test.alerts ADD COLUMN IF NOT EXISTS request_id INT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_player_club_membership
  ON test.player_club_map (player_id, club_id);
```

`test.player_club_map` had **no** uniqueness on `(player_id, club_id)` — only a primary key
on `id` plus two foreign keys (verified against dev). The accept path inserts
unconditionally, so this index makes duplicate membership structurally impossible rather
than merely unreachable. It matters because `getPlayerClubsFromDb` uses an `INNER JOIN`: a
duplicate row would make the club appear **twice** in `getPlayerClubs`.

`status` is one of `PENDING`, `ACCEPTED`, `REJECTED`. It is a plain `TEXT` column rather
than a Postgres enum, matching how `match_status` is stored.

`resolved_by` records which admin decided, since any admin of the club may.

The `alerts.request_id` column mirrors the existing `match_id` column — it is what lets an
admin's alert point back at the request to act on.

## GraphQL API (`graphql/schema/Play.js`)

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

type Mutation {
  sendClubJoiningRequest(data: sendClubJoiningRequestInput!): ClubJoinRequest
  updateClubJoiningRequest(data: updateClubJoiningRequestInput!): ClubJoinRequest
}
```

`JoinRequestAction` is an enum so `buildSchema` rejects anything but `ACCEPT`/`REJECT`
before the resolver runs. This is the schema's first enum; `Date` and the other shared
types come from `./shared`.

`Alert` gains one field so a client can act on the alert it received:

```graphql
type Alert {
  # ...existing fields unchanged...
  requestId: Int
}
```

`ClubJoinRequest.player` and `.club` are field resolvers using the existing `playerLoader`
and `clubLoader`, following the `Match` type's pattern.

## `sendClubJoiningRequest`

Resolver (`graphql/resolvers/Play/Mutations.js`):

1. Read the player from `context.token` — split on `"Bearer "`, `verifyJwt`, take `id`.
   Throw `"Missing token"` / `"Missing player ID, Invalid JWT"`, matching
   `getPlayerAlertsForClub`.
2. Throw `"Club ID is required"` if absent.
3. Load the club and check it is **eligible to receive requests**: it must exist, have
   `review_status = 'APPROVED'`, and not be banned (`is_banned IS NOT TRUE`) — the same
   filter `getClubsListFromDb` already applies. Throw `"Club not found"` for all three
   cases, so the error does not confirm the existence of a club the caller cannot
   otherwise see.

   `getClubByIdFromDb` is a bare `SELECT * FROM test.clubs WHERE id = $1` with no filter,
   so it is **not** sufficient alone — apply the eligibility check after loading.

   `access = 'PRIVATE'` is deliberately **not** enforced. Nothing in the codebase enforces
   access semantics yet, and every request already needs admin approval, so PRIVATE
   currently means only "no unsolicited request notifications".
4. `fetchPlayerClubMap(playerId, clubId)` — if non-empty, throw
   `"Player is already a member of this club"`.
5. Insert the request. A `23505` unique violation means a `PENDING` request already
   exists; translate it to `"A join request is already pending for this club"`.
6. `getTeamAdminIds(clubId)` and write one `CLUB_JOINING_REQUEST` alert per admin.
7. Return the created request row.

Each alert row sets `player` = the admin's id, `type` = `"CLUB_JOINING_REQUEST"`,
`home_team` = `clubId`, `request_id` = the new request id, `seen` = false. **`home_team`
is required**: `getPlayerAlertsForClubFromDb` filters
`WHERE player = $1 AND (home_team = $2 OR away_team = $2)`, so an alert without it never
surfaces.

The description follows the `MATCH_INVITE` wording style:
`"<firstName> <lastName> has requested to join <clubName>. Click to respond."`

**Zero-admin clubs.** A club with no admin produces a request nobody can approve.
`createClubInDb` always writes the creator with `is_admin = true`, so this should not
occur. If it does, the request is still created and no alerts are written — the player is
not failed for a data-integrity problem on the club's side.

## `updateClubJoiningRequest`

1. Read the acting admin from `context.token` as above.
2. Load the request by id; throw `"Join request not found"` if missing.
3. **Authorize before disclosing anything about the request.**
   `fetchPlayerClubMap(adminId, request.club_id)` — unless a row exists **and** its
   `is_admin` is true, throw `"Join request not found"`, the *same* message as a missing
   request. Membership alone is not enough.

   The ordering and the shared message are both deliberate. With the status check first, or
   with a distinct `"Only a club admin can respond"` message, any authenticated player could
   iterate `requestId` values and tell three states apart — absent, resolved, and
   pending-in-a-club-I-do-not-admin — yielding a map of every join request in the system and
   its lifecycle. Nothing can be *mutated* cross-club either way, since authorization is
   scoped to `request.club_id`; this closes the disclosure.
4. If `status <> 'PENDING'`, throw `"This join request has already been resolved"`. This
   also covers two admins acting at once. Safe to disclose here — the caller is by now a
   verified admin of the owning club.
5. **ACCEPT:** in one transaction, insert `(player_id, club_id, is_creator: false,
   is_admin: false)` into `player_club_map` and set `status = 'ACCEPTED'`,
   `resolved_by = adminId`, `updated_at = now()`.
   **REJECT:** set `status = 'REJECTED'`, `resolved_by`, `updated_at`. No transaction
   needed — one statement.
6. Mark every existing alert for this request `seen = true`
   (`UPDATE test.alerts SET seen = true WHERE request_id = $1`), so a resolved request
   stops sitting in the admins' feeds. At this point the only alerts carrying this
   `request_id` are the admin notifications from step 6 of `sendClubJoiningRequest`; the
   requester's outcome alert is written afterwards and so is left unseen, which is what
   we want.
7. Write one alert to the requester: `CLUB_JOINING_REQUEST_ACCEPTED` or
   `CLUB_JOINING_REQUEST_REJECTED`, with `player` = requester, `home_team` = `club_id`,
   `request_id` = the request id.
8. Return the updated request row.

## Concurrency

- **One player requesting twice.** The partial unique index makes the database the
  arbiter, and the `23505` catch in step 5 is the only guard. There is deliberately **no**
  read-then-insert pre-check for an existing pending request: it would race, and it would
  add a query without improving the error message.
- **Two admins resolving at once.** The `status = 'PENDING'` check narrows the window but
  does not close it. The accept path's `UPDATE` is therefore written as
  `UPDATE ... SET status = 'ACCEPTED' WHERE id = $1 AND status = 'PENDING'` and treats a
  zero-row result as "already resolved", rolling the transaction back.
- **Accept is transactional.** It writes to `player_club_map` and `club_join_requests`.
  Without a transaction, a failure between them leaves a request marked `ACCEPTED` with no
  membership row: the player believes they joined, has no access, and the partial index
  now blocks them from re-applying. Use `pool.connect()` with explicit
  `BEGIN`/`COMMIT`/`ROLLBACK` and release the client in a `finally`.

  **This is the first transaction in this codebase** — every existing write is a
  standalone `pool.query`. It is contained to this one model function.

## Known non-atomicity (accepted)

Alert fan-out loops `await pool.query` per admin, following `createMatchInviteAlerts`. A
mid-loop failure leaves some admins notified and others not. Matching the existing pattern
is preferred over diverging here; the request row itself is already committed, so the
request is not lost — only some notifications.

## Error handling

| Condition | Error |
|---|---|
| No token / bad JWT | `"Missing token"` / `"Missing player ID, Invalid JWT"` |
| `clubId` missing | `"Club ID is required"` |
| Club missing, unapproved, or banned | `"Club not found"` — one message for all three |
| Already a member | `"Player is already a member of this club"` |
| Pending request exists (23505) | `"A join request is already pending for this club"` |
| Request id not found | `"Join request not found"` |
| Request already resolved | `"This join request has already been resolved"` |
| Caller is not an admin | `"Join request not found"` — deliberately identical to the missing-request message, see step 3 |
| Database failure | `"Failed to create join request: …"` / `"Failed to update join request: …"` |

## Verification

No test harness exists in this repo (the suite was removed in `2533889`); verification is
manual against the dev environment. Run the DDL above first, then check:

- Player requests to join a club they are not in → request created, every admin of that
  club receives a `CLUB_JOINING_REQUEST` alert via `getPlayerAlertsForClub`
- Same player requests the same club again → `"A join request is already pending"`
- Existing member requests to join → `"Player is already a member of this club"`
- Non-admin member calls `updateClubJoiningRequest` → rejected
- Admin accepts → `player_club_map` row appears with `is_creator`/`is_admin` false, status
  becomes `ACCEPTED`, requester receives the accepted alert, other admins' alerts flip to
  `seen`
- Admin rejects → status `REJECTED`, **no** `player_club_map` row, requester receives the
  rejected alert
- Rejected player requests again → allowed, a new `PENDING` row alongside the old
  `REJECTED` one
- Either mutation called twice on the same request → second gets
  `"already been resolved"`
- Accepted player now appears in `getPlayerClubs` and can call `getPlayerMatches` for that
  club
- Bad `action` value (e.g. `MAYBE`) → rejected by schema validation before the resolver

## Out of scope

- An admin-facing `getClubJoiningRequests` query — admins act via the alert feed for now
- Withdrawing or cancelling a pending request
- Inviting a player to a club (the inverse flow)
- Leaving or being removed from a club — no such path exists anywhere in the codebase
- Rate limiting beyond the one-pending-request rule
- Converting the four existing mutations to throw rather than return `Confirmation`
