# FE Migration Brief — Club Joining Requests

**Status:** backend implemented and verified locally, **not yet committed or deployed**.

**Severity: ONE breaking change**, and it is small. An earlier plan moved `getPlayerClubs`
and `getClubsList` to a different Cloud Function; that was **reverted** precisely because
those are live queries the app already uses. They have not moved. Only new operations went
to `auth`.

---

## 1. The one breaking change

### `getClubsList` now requires authentication

Same function (`ballersApiPlay`), same signature, same return type. The only change is that
it now requires an `Authorization: Bearer <jwt>` header. It was previously callable with no
token.

Without a valid token it throws one of:

| Message | Cause | Client action |
|---|---|---|
| `Missing token` | no `Authorization` header | attach the token |
| `Missing player ID, Invalid JWT` | token decodes but carries no player id | re-auth |
| `Player not found` | valid token, but the player is deleted or gone | **forced logout** |

`Player not found` is new. It means a still-valid token belongs to a deleted account — treat
it as a forced logout, not a retry.

**What to check in the client:** any club-browsing screen reachable *before* login must now
be gated behind auth or moved after it. If the client only attaches tokens to some calls,
`getClubsList` now needs one.

---

## 2. What did NOT move

`getPlayerClubs`, `getClubsList`, `getPlayerAlertsForClub`, and every match operation are
exactly where they were, on `ballersApiPlay`. No routing changes for existing calls.

---

## 3. New operations — on `ballersApiAuth`

Both are new, so nothing breaks; they just need adding.

| Operation | Function |
|---|---|
| `sendClubJoiningRequest(data: sendClubJoiningRequestInput!): ClubJoinRequest` | **auth** |
| `updateClubJoiningRequest(data: updateClubJoiningRequestInput!): ClubJoinRequest` | **auth** |

They live on `auth` because the club lifecycle already does — `createClub`, `updateClub`,
`adminReviewClub`, and `getClubsPendingReview` are all there.

**This means the join flow crosses functions**, and the routing mechanism must handle it:

- Browse clubs → **play** (`getClubsList`)
- Request to join → **auth** (`sendClubJoiningRequest`)
- Read admin alerts → **play** (`getPlayerAlertsForClub`)
- Resolve the request → **auth** (`updateClubJoiningRequest`)

If endpoint selection is *inferred* — by feature folder, screen, or naming convention —
that inference will be wrong here, because club operations now legitimately live on both
functions. **Route by explicit operation name.** If the client already has a per-operation
map, add the two new names to `auth` and nothing else changes.

Full contract for both mutations, including every error string and the alert types, is in
`2026-08-22-club-joining-requests-frontend.md`.

---

## 4. Additive, no client change required

- **`Club.viewerJoinStatus: String!`** — `"NONE"` | `"PENDING"` | `"MEMBER"` for the
  authenticated caller. Available on `Club` wherever it is returned, including inside
  `getClubsList`, so it drives the join button with no client-side state. Costs nothing
  unless selected. This is why `getClubsList` needed auth.
- **`Alert.requestId: Int`** — nullable; set on join-request alerts, `null` on existing
  `MATCH_INVITE` alerts.

---

## 5. Deployment ordering

Because nothing moved, the client and backend are independent in one direction:

- **Backend first is safe** for everything except the `getClubsList` auth requirement — any
  client calling it without a token starts failing the moment the backend deploys.
- **Client first is safe** — attaching a token to `getClubsList` works against the current
  backend too, since an ignored header is harmless.

**So: ship the client's token change first, then the backend.** That ordering has no
downtime window. The two new mutations can be added client-side any time after the backend
deploys.

---

## 6. Why the two queries stayed

The club domain is currently split — created and moderated on `auth`, browsed on `play`.
Consolidating it is planned but deliberately deferred, because `getPlayerClubs` and
`getClubsList` are live and moving them would break the app for no immediate benefit. When
that migration happens it will be its own coordinated change, and the safe pattern is to
serve the operations from **both** functions temporarily, migrate the client, then retire
the old copies. Tracked in `docs/BACKLOG.md`.

Design the routing layer so an operation's endpoint is a **single-line change**. That is
what will make the eventual move cheap.

---

## 7. How to verify

- `getClubsList` on **play** with a token returns a `ClubsPage`; without one returns
  `Missing token`.
- `getPlayerClubs` on **play** still works exactly as before.
- `getClubsList { clubs { id viewerJoinStatus } }` returns one of the three values — and two
  different players in quick succession get **different** answers for the same club. A
  shared answer means viewer-scoped data is leaking between users; report it immediately.
- `sendClubJoiningRequest` works on **auth** and returns `Cannot query field` on **play**.
- Every match screen is unchanged on **play**.
