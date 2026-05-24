# Clubs Creation & Review Flow — Design Spec

**Date:** 2026-05-24
**Branch:** createClubsAndReviewFlow
**Status:** Approved, ready for implementation

---

## Overview

A player can create a club, which places it into a review queue. An app admin reviews the club for data and copyright compliance. The admin and player can exchange notes during the review. The admin either approves or declines the club. A declined club can be edited and resubmitted by the player. No review history is tracked — only current state matters. The design is intentionally open-ended so a `club_review_requests` history table can be added later without structural change.

---

## Data Model

### Columns already added (by hand)
- `test.clubs.is_verified` — BOOLEAN, set to `true` only on `APPROVED`
- `test.player_club_map.is_creator` — BOOLEAN, set to `true` for the founding player

### New columns via migration

```sql
ALTER TABLE test.clubs
  ADD COLUMN review_status VARCHAR(20) NOT NULL DEFAULT 'PENDING_REVIEW',
  ADD COLUMN review_notes  JSONB        NOT NULL DEFAULT '[]'::jsonb;
```

### `review_status` values

| Value | Meaning |
|---|---|
| `PENDING_REVIEW` | Newly created or resubmitted after a decline — waiting for admin |
| `IN_REVIEW` | Admin has picked it up and is actively reviewing |
| `APPROVED` | Admin approved; `is_verified = true` set simultaneously |
| `DECLINED` | Admin declined; a note is appended to `review_notes` |

### `review_notes` shape

Append-only JSONB array. Each entry:

```json
{
  "message": "Name conflicts with existing club, please rename.",
  "sender_role": "ADMIN",
  "created_at": "2026-05-24T10:00:00Z"
}
```

`sender_role` is either `"ADMIN"` or `"PLAYER"`. The last entry in the array is the active message. Migration path to a dedicated `club_review_requests` table is straightforward: create the table, backfill from `review_status` + `review_notes`, drop the columns.

---

## State Machine

```
createClub
    └──► PENDING_REVIEW
              └──► [admin] IN_REVIEW
                        ├──► APPROVED  →  is_verified = true  →  alert: CLUB_APPROVED → player
                        └──► DECLINED  →  note appended       →  alert: CLUB_DECLINED → player
                                  └──► [player edits + optional note]
                                            └──► PENDING_REVIEW
```

### Transition rules

- `createClub` always starts at `PENDING_REVIEW`.
- `adminReviewClub` can move status to `IN_REVIEW`, `APPROVED`, or `DECLINED` from any admin-facing state.
- `updateClub` resets status to `PENDING_REVIEW` only if current status is `DECLINED`. No-op on status if already `PENDING_REVIEW` or `IN_REVIEW`.
- `is_verified` is set to `true` atomically with the `APPROVED` transition, and back to `false` on `DECLINED`.

---

## GraphQL Schema

### Shared types — `graphql/schema/shared.js` (new file)

Extract `Club` type and `Date` scalar out of both `Auth.js` and `Play.js` into a shared module to avoid duplication across the two separate GraphQL endpoints.

```graphql
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
```

### New inputs — added to `Auth.js`

```graphql
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
```

`action` accepts: `IN_REVIEW`, `APPROVED`, `DECLINED`.

### New mutations — added to `Auth.js`

```graphql
type Mutation {
  createClub(data: createClubInput!): Confirmation
  updateClub(data: updateClubInput!): Confirmation
  adminReviewClub(data: adminReviewClubInput!): Confirmation
}
```

All return the existing `Confirmation` type (`message: String!`, `status: Boolean`), consistent with `createMatch` and `respondToMatchInvitation`.

### New query — added to `Auth.js`

```graphql
type Query {
  getClubsPendingReview: [Club]
}
```

Returns clubs where `review_status IN ('PENDING_REVIEW', 'IN_REVIEW')`, ordered by `created_at ASC`. Admin-facing.

---

## Alerts

Two new alert types fired into the existing `test.alerts` table. Recipient is always the player (club creator).

| Alert type | Fired when | Description field |
|---|---|---|
| `CLUB_APPROVED` | `adminReviewClub` → `APPROVED` | "Your club {name} has been approved." |
| `CLUB_DECLINED` | `adminReviewClub` → `DECLINED` | "Your club {name} has been declined. Check the review notes." |

Admin does not receive alerts — uses `getClubsPendingReview` query to find work.

The existing `alerts` table schema supports these alert types without modification. `club_id` is carried in the `home_team` column for now (consistent with how `Alert.homeTeam` resolves to a `Club`).

---

## File Breakdown

| File | Change type | Summary |
|---|---|---|
| `graphql/schema/shared.js` | New | `Club` type + `Date` scalar extracted here |
| `graphql/schema/Auth.js` | Modify | Import `shared.js`; add 3 inputs, 3 mutations, 1 query |
| `graphql/schema/Play.js` | Modify | Import `shared.js`; remove `Club` type + `Date` scalar |
| `graphql/model/AuthModel.js` | Modify | Add `createClubInDb`, `updateClubInDb`, `adminReviewClubInDb`, `getClubsPendingReviewFromDb`, `appendReviewNote` |
| `graphql/resolvers/Auth/Mutations.js` | Modify | Add `createClubResolver`, `updateClubResolver`, `adminReviewClubResolver` |
| `graphql/resolvers/Auth/Queries.js` | Modify | Add `getClubsPendingReviewResolver` |

No new files beyond `shared.js`. No changes to `play/` or `auth/` entry points.

---

## Out of Scope

- Club review history (`club_review_requests` table) — intentionally deferred
- General player-admin chat system — deferred; `review_notes` JSONB handles the review thread
- Admin authentication/role enforcement — assumed handled at the application layer for now
- Club deletion or archiving
