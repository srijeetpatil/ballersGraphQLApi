# Frontend Brief — Club Joining Requests

**Backend status:** implemented, reviewed, verified on dev. Branch `sendJoiningRequest` in
the `functions` submodule. DDL is applied on dev.

**Scope:** two new user flows against an existing GraphQL API. This brief is the API
contract plus the constraints that will bite you; it makes no assumptions about the client
stack.

---

## 1. What you are building

**Flow A — a player asks to join a club.** The player finds a club, optionally writes a
note, and submits. Every admin of that club gets an in-app alert.

**Flow B — a club admin resolves the request.** The admin sees the request in their alert
feed and either accepts (the player becomes a member) or rejects.

---

## 2. Which endpoint

**Club operations are split across both functions.** Route by explicit operation name — an
inference based on feature area will be wrong here.

| Operation | Function |
|---|---|
| `sendClubJoiningRequest`, `updateClubJoiningRequest` | **auth** |
| `createClub`, `updateClub`, `adminReviewClub`, `getClubsPendingReview` | **auth** |
| `getClubsList`, `getPlayerClubs` | **play** |
| `getPlayerAlertsForClub` | **play** |
| `getPlayerMatches`, `getMatchById`, `getAllVenues`, match mutations | **play** |

The join flow therefore crosses functions: browse on **play**, request on **auth**; read
admin alerts on **play**, resolve on **auth**. Consolidating the club domain onto one
function is planned but deferred — see `2026-08-22-fe-migration-club-domain-move.md`.

`getClubsList` now requires an auth token; it previously did not. That is the only breaking
change in this release.

## 3. Auth

Both mutations require `Authorization: Bearer <jwt>`. The acting player is derived
**entirely from the token** — there is no `playerId` field on either input, by design. The
client cannot act on another player's behalf.

---

## 4. GraphQL contract

### Send a request

```graphql
mutation SendClubJoiningRequest($clubId: Int!, $note: String) {
  sendClubJoiningRequest(data: { clubId: $clubId, note: $note }) {
    id
    status
    note
    createdAt
    club { id name crest }
  }
}
```

`note` is optional. Returns the created request with `status: "PENDING"`.

### Resolve a request

```graphql
mutation UpdateClubJoiningRequest($requestId: Int!, $action: JoinRequestAction!) {
  updateClubJoiningRequest(data: { requestId: $requestId, action: $action }) {
    id
    status
    player { id firstName lastName profilePicture position }
    club { id name }
    updatedAt
  }
}
```

`JoinRequestAction` is an enum: `ACCEPT` or `REJECT`. Send it **unquoted** as a GraphQL
enum, not as a string. Anything else is rejected by schema validation before the server
runs. Returns the request with `status: "ACCEPTED"` or `"REJECTED"`.

### Types

```graphql
type ClubJoinRequest {
  id: ID!
  player: Player      # the requester
  club: Club
  note: String
  status: String!     # "PENDING" | "ACCEPTED" | "REJECTED"
  createdAt: Date!
  updatedAt: Date!
}

type Player {
  id: Int!
  firstName: String!
  lastName: String
  phone: String
  profilePicture: String
  position: String
  is_deleted: Boolean
}

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
  access: String
  review_status: String
  review_notes: String
  created_at: Date
  updated_at: Date
  creator: String
}
```

**Do not render `review_status`, `review_notes`, or `is_banned` in player-facing UI** —
they are club-moderation internals that happen to be on the shared type.

---

## 5. Errors

These mutations **throw GraphQL errors** rather than returning a `{status, message}`
object. This differs from the four older mutations (`createMatch`, `addPlayerToMatch`,
`removePlayerFromMatch`, `respondToMatchInvitation`), which all return `Confirmation` and
never throw. Your error handling for these two must read `errors[0].message`, not
`data.x.status`.

Map them to user-facing copy — do not surface the raw strings:

| Server message | Meaning | Suggested copy |
|---|---|---|
| `Missing token` / `Missing player ID, Invalid JWT` | Not authenticated | re-auth flow |
| `Club ID is required` | Client bug | generic failure |
| `Club not found` | Club missing, unapproved, or banned | "This club isn't accepting requests." |
| `Player is already a member of this club` | Already joined | hide the button instead |
| `A join request is already pending for this club` | Duplicate | "Your request is already pending." |
| `Join request not found` | Missing request **or** caller is not an admin | "This request is no longer available." |
| `This join request has already been resolved` | Another admin got there first | "Another admin already handled this." |
| `Failed to create join request: …` / `Failed to update join request: …` | Server/DB fault | generic failure + retry |

**`Join request not found` is deliberately ambiguous.** It is returned both when the
request does not exist and when the caller is not an admin of the owning club — this is a
security measure to stop request-ID enumeration. Do not try to distinguish the two cases
in the UI, and do not report "you are not an admin", because you cannot know that.

**`This join request has already been resolved` is a normal race**, not an error state.
Two admins opening the same alert is expected. Treat it as "refresh and move on".

---

## 6. Where the data comes from

There is **no dedicated query for join requests**. Everything routes through existing
queries:

### Finding a club to join (Flow A)

```graphql
query { getClubsList(data: { search: "man", limit: 20, offset: 0 }) {
  clubs { id name crest locality total_members viewerJoinStatus }
  total
  hasMore
} }
```

Already returns only approved, non-banned clubs, so anything listed here is requestable.

**This query now requires `Authorization: Bearer <jwt>`** — it was previously open. A
request without a valid token whose player still exists fails with `Missing token`,
`Missing player ID, Invalid JWT`, or `Player not found`.

**`viewerJoinStatus` drives the button directly.** It is `String!`, always one of:

| Value | Button state |
|---|---|
| `"NONE"` | "Request to join", enabled |
| `"PENDING"` | "Request pending", disabled |
| `"MEMBER"` | hide the button — already a member |

It is computed for the authenticated caller, so it needs no cross-referencing against
`getPlayerClubs` and no local state. It costs nothing when you do not select it, and two
queries total when you do — the same whether the page shows 10 clubs or 50. The field is
available on `Club` everywhere it appears, not just in `getClubsList`.

### The admin's request inbox (Flow B)

```graphql
query { getPlayerAlertsForClub(clubId: $clubId) {
  id type description seen requestId createdAt
} }
```

Filter client-side for `type == "CLUB_JOINING_REQUEST"`. The `requestId` field is what you
pass to `updateClubJoiningRequest`.

**This query is per-club.** To build a combined inbox you must call `getPlayerClubs` first,
then fan out one `getPlayerAlertsForClub` call per club where the player is an admin.
There is no cross-club alert query.

### Alert types you will see

| `type` | Recipient | Carries |
|---|---|---|
| `CLUB_JOINING_REQUEST` | every admin of the club | `requestId` |
| `CLUB_JOINING_REQUEST_ACCEPTED` | the requester | `requestId` |
| `CLUB_JOINING_REQUEST_REJECTED` | the requester | `requestId` |

Existing `MATCH_INVITE` alerts have `requestId: null`. Handle it as nullable.

---

## 7. Three constraints that will cost you time if you miss them

### 7a. The requester's outcome alert is hard to reach

When a request is resolved, the requester gets an alert — but the only way to read it is
`getPlayerAlertsForClub(clubId)`, which requires knowing the club id. After a **rejection**
the player is not a member, so that club will **not** appear in `getPlayerClubs`.

**The client must persist locally which clubs the player has requested to join**, and poll
those club ids for outcome alerts. Otherwise a rejected player never learns the outcome.
(`getPlayerAlertsForClub` itself has no membership gate, so the call succeeds for a
non-member — you just need the id.)

### 7b. Resolved requests stay in the admin's feed

On resolution, all alerts for that request are flipped to `seen: true` — they are **not**
deleted. There is no way to read a request's status from an alert; `Alert` carries
`requestId` but no `request` field, and there is no query for a single request.

So `seen` is your only signal that a request was handled, and you cannot tell whether it
was accepted or rejected. Practical approach: hide or grey out `CLUB_JOINING_REQUEST`
alerts where `seen == true`, and treat a `This join request has already been resolved`
error as confirmation to refresh.

### 7c. Re-application rules are asymmetric

**Note:** `viewerJoinStatus` (see §6) now answers this per club, so you no longer need
local tracking for the *button*. Local tracking is still required for §7a, which is about
receiving the outcome alert after a rejection.

- **Pending request exists** → new request rejected (`already pending`)
- **Previously rejected** → new request allowed **immediately**, no cooldown
- **Already a member** → rejected (`already a member of this club`)

So the "Request to join" button should be hidden for members, disabled while a request is
pending, and re-enabled after a rejection — all three of which `viewerJoinStatus` gives you
directly. Refetch the club after a successful `sendClubJoiningRequest` to pick up the new
`"PENDING"`.

---

## 8. Explicitly not available

Do not design UI that depends on these — none exist server-side:

- A list/query of a club's pending join requests (the alert feed is the only route)
- Any query returning a single `ClubJoinRequest` by id, or the viewer's own requests
- Withdrawing or cancelling a pending request
- Inviting a player to a club (the inverse flow)
- Leaving or being removed from a club
- Any cooldown on re-application after rejection
- `access: PRIVATE` enforcement — private clubs currently accept join requests like any
  other

If a design needs one of these, it is a backend change; raise it rather than working
around it.

---

## 9. Suggested build order

1. **Flow A** — club search → club detail → "Request to join" with optional note. Handle
   the three rejection errors from §5.
2. **Local pending-request tracking** (§7a/§7c) — needed before outcome alerts are useful.
3. **Flow B** — admin inbox: `getPlayerClubs` → fan out `getPlayerAlertsForClub` → filter
   `CLUB_JOINING_REQUEST` → accept/reject with optimistic refresh on the "already resolved"
   error.
4. **Outcome alerts** for the requester, driven by the tracked club ids.

Steps 1 and 3 are independently shippable.
