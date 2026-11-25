# Frontend Brief — Record Match Result

**Backend status:** contract agreed, **not built**. Exact error strings will be listed here
when the backend lands.

**Scope:** the decisions taken after reviewing the *Record Match Result — design* doc
against the API. **Where this brief and the design doc disagree, this brief wins.** Screen
layouts, sheet contents and client conventions in the design doc stand unless changed below.

---

## 1. Changes to the design doc at a glance

| Design doc said | Decision |
|---|---|
| `teamsLocked` field, `setTeamsLocked` mutation, Lock / Unlock teams buttons | **Dropped entirely.** No lock concept. |
| Server-created `RECORD_RESULT` alert at `matchEndTime + 30 min` | **Dropped.** No server alert, no scheduler. The client derives the prompt (§5). |
| `Wasn't played` is terminal and irreversible | **Not terminal.** An abandoned match can still have a result recorded inside the window (§3). |
| `getClubMembers` on the `auth` API | **On `play`.** |
| Player ids as `ID` on some inputs | **Player ids are `Int` everywhere**, including `auth` (§6). |
| Lifecycle uses `DECLINED`, `INVITATION_CANCELLED` "as today" | **Status strings are synced to what the server writes** (§4). |
| Authorised = organiser or admin of `homeTeam` / `awayTeam` | **Intra-club matches check admins of the new `Match.clubId`** (§10). |

Unchanged and still in force: the score is entered, not computed; there is no live flow;
score and roster are saved together; goal tagging covers either side and can happen only on
a recorded match; and authorised means organiser or club admin.

---

## 2. The result window

Every result write is allowed only in **`[matchStartTime, matchStartTime + 24h)`**. That
covers recording, editing, marking not played, recording over a not-played match, adding
goals and removing goals. The server rejects anything outside it, with distinct messages for
"too early" and "window closed".

Use exactly the same half-open boundary on the client to decide which actions to show. A
skewed device clock can still show an action the server rejects. Surface the server
`message` when that happens.

---

## 3. Lifecycle

```
AWAITING_OPPONENT_RESPONSE ──accept──▶ TEAM_SELECTION ──record result──▶ ENDED
         │                                   │                            ▲
      decline                          "wasn't played"                    │
         ▼                                   ▼                            │
  INVITATION_DECLINED                    ABANDONED ──record result────────┘
                                                      (window open only)
```

- `ABANDONED → ENDED` via `recordMatchResult` is allowed while the window is open. That is
  the undo for a mistaken "Wasn't played".
- `ENDED → ABANDONED` is **not** available. A wrong result is fixed with `Edit result`.
- `Wasn't played` stays a secondary text action. It no longer needs a `DialogSheet`
  confirmation, because it is reversible.

### Bottom action bar

Replaces the table in the design doc.

| State | Authorised sees | Everyone else sees |
|---|---|---|
| Awaiting response | nothing | nothing |
| Team selection, before kickoff | existing roster management | join & leave |
| Team selection, window open | `Record result` + `Wasn't played` | "Waiting for the organiser to record the result" |
| Team selection, window closed | "Not recorded" | "Not recorded" |
| Ended, window open | `Edit result`, `Add scorer` | the result, read-only |
| Ended, window closed | the result, read-only | the result, read-only |
| Abandoned, window open | "Not played" + `Record result` | "Not played" |
| Abandoned, window closed | "Not played" | "Not played" |

Remove the local `teamsLocked` and `matchStarted` state from `GameDetails.tsx`, along with
the Lock, Unlock, Start and End buttons. The server already rejects `addPlayerToMatch` once
kickoff has passed. Hide join and leave from kickoff onwards.

---

## 4. Status strings

The server is the source of truth. Use these exact values:

```
MATCH_AWAITING_OPPONENT_RESPONSE
MATCH_TEAM_SELECTION
MATCH_INVITATION_DECLINED     ← client currently uses MATCH_DECLINED
MATCH_ENDED
MATCH_ABANDONED               ← new
MATCH_LIVE                    ← keep in the union for exhaustiveness, never produced
```

Rename `MATCH_DECLINED` to `MATCH_INVITATION_DECLINED` in:

- `src/common/utils/matchStatusBadge.ts`
- `src/screens/Notifications/Notifications.tsx`

`src/screens/Notifications/NotificationsModules.ts` is different. Its `MATCH_DECLINED` is an
**alert type** in `getNotificationTitle`, not a match status. The server's alert type is
`MATCH_INVITE_DECLINED`, so rename it to that instead. *(Correction from the client spec.)*

Today declined matches fall through to the wrong badge because the strings don't match.

The server never writes `MATCH_INVITATION_CANCELLED`. Treat it like `MATCH_LIVE`: keep it
in the union and expect never to receive it.

---

## 5. Prompting: client-derived only

There is no server alert and no push. For an **authorised** viewer, a match needs a result
when all of these hold:

- `matchStatus == MATCH_TEAM_SELECTION`
- `now >= matchEndTime`
- `now < matchStartTime + 24h`

When it does, show:

1. **An in-app alert** at the top of Notifications, built on the client from
   `getPlayerMatches`. Nothing is persisted, and it disappears as soon as the match is
   recorded, marked not played, or the window closes. Do not add a `RECORD_RESULT` case to
   `NotificationsModules.ts`, because the server will never send that type.
2. **The "Result needed" warning badge** on the match card, replacing "Not started".
   Unauthorised viewers keep "Not started". After the window closes, everyone sees
   "Not recorded".
3. **The in-screen banner** in `GameDetails`, with `Record result` inline and the close time
   ("Record by tomorrow 8:00 PM").

`Record result` is still available in the bottom bar from kickoff. The prompts only start
once the match has ended.

---

## 6. GraphQL contract (play)

All of these require `Authorization: Bearer <jwt>`. The acting player comes from the token.

Like the older match mutations, the new ones **return** `status` / `message` rather than
throwing. `message` is user-visible copy. On success, `match` is the full updated match, so
there is no need to refetch.

```graphql
type MatchMutationResponse {
  status: Boolean!
  message: String!
  match: Match
}

recordMatchResult(data: recordMatchResultInput!): MatchMutationResponse!
updateMatchResult(data: updateMatchResultInput!): MatchMutationResponse!
markMatchNotPlayed(matchId: ID!): MatchMutationResponse!
addMatchGoal(data: addMatchGoalInput!): MatchMutationResponse!
removeMatchGoal(goalId: ID!): MatchMutationResponse!

getClubMembers(clubId: Int!): [Player!]!

input recordMatchResultInput {
  matchId: ID!
  homeTeamGoals: Int!
  awayTeamGoals: Int!
  playersHome: [Int!]!    # confirmed roster, sent whole
  playersAway: [Int!]!
}

input updateMatchResultInput {   # same fields, all optional except matchId
  matchId: ID!
  homeTeamGoals: Int
  awayTeamGoals: Int
  playersHome: [Int!]
  playersAway: [Int!]
}

input addMatchGoalInput {
  matchId: ID!
  teamId: Int!        # side credited with the goal
  playerId: Int!      # the scorer
  isOwnGoal: Boolean!
}
```

New fields on `Match`:

```graphql
clubId: Int!               # the club that owns the match (see §10)
resultRecordedAt: Date     # null until recorded
resultRecordedBy: Player   # null until recorded
goals: [MatchGoal!]!       # empty until tagged

type MatchGoal {
  id: ID!
  teamId: Int!
  isOwnGoal: Boolean!
  scorer: Player!
}
```

`recordMatchResult` accepts a match in `MATCH_TEAM_SELECTION` or `MATCH_ABANDONED`.
`updateMatchResult` accepts only `MATCH_ENDED`.

### Ids: `Int` for players

`auth`'s `Player.id` changes from `ID!` to `Int!`, matching `play`. This is **breaking**:
it comes back as a number (`12`) instead of a string (`"12"`). Remove any string
coercion or string comparison of player ids that came from `auth`, specifically
`userWithPhoneExists` and `ClubJoinRequest.player`. After this change, one `_isEqual`
between a player id from `auth` and one from `play` works without casting.

**No client change is needed after all.** *(Correction from the client spec.)* The current
user's id comes from `getPlayerBasicDetails`, which already returns `id: Int!`. The client
never compares or casts ids from `userWithPhoneExists` or join requests. The backend change
ships on its own.

Match and goal ids stay `ID`, consistent with the existing match operations.

---

## 7. Roster rules: unchanged backend behaviour

- **Storage:** the confirmed roster replaces the match's existing roster. There is no
  separate "played" list. After recording, `playersHome` / `playersAway` return what you
  sent.
- **Cap:** the same per-side cap `addPlayerToMatch` uses today, N from the `NvN` format.
  Disable `+ Add player` once a side has N ticked. Save still needs at least one player
  ticked per side.
- **Waitlisted players** do not appear in `playersHome` / `playersAway`, so they are not on
  the record sheet.
- **Goals and roster edits:** no special handling. If an edit removes a player who already
  has a tagged goal, the goal stays. Don't warn about it and don't delete it on the client.
  `addMatchGoal` still requires the scorer to be on the confirmed roster when the goal is
  added.

---

## 8. Adding and removing players: who may do it

`addPlayerToMatch` and `removePlayerFromMatch` now both require a JWT. They also enforce
who may act on whom:

| Caller | May add or remove |
|---|---|
| any player | **themselves** (`playerId` equals the caller's id) |
| the organiser, or an authorised admin (§10 rule) | **anyone** |

Anyone else gets `addSuccessful: false` or `status: false` with a user-visible `message`.
Both mutations also reject once kickoff has passed. `addPlayerToMatch` already did this;
`removePlayerFromMatch` now matches it. From kickoff, the roster changes only through
`recordMatchResult` / `updateMatchResult`.

Signatures and return types are unchanged. The client already sends the token on every
request.

---

## 9. Timestamps

`matchStartTime`, `matchEndTime` and `resultRecordedAt` will be stored as `timestamptz`.
The wire format is unchanged: ISO-8601 UTC strings (`2026-09-06T19:55:00.000Z`). Keep
sending `Date.toISOString()` and render in device-local time. No client change is expected.
If a time displays 5½h off after the migration, report it as a backend bug.

---

## 10. Authorization: who counts as authorised

**Why this changes.** `isUserAdmin` in `GameDetails.tsx` checks whether the user admins
`homeTeamId` or `awayTeamId`. On an `INTRA_CLUB` match those are temporary team ids, not
club ids, so:

- a real admin of the club gets `false`
- if a temp team's id happens to equal the id of some club the user admins, a non-admin gets
  `true`

**The rule.** `Match` gains `clubId: Int!`, the club that owns the match. New matches
already record it. Some older test matches don't; the backend backfills or removes those
before the field goes live, so the client can treat it as always present.

| Match type | Authorised if the user is… |
|---|---|
| `INTRA_CLUB` | the organiser, **or** an admin of `clubId` |
| `INTER_CLUB` | the organiser, **or** an admin of `homeTeam.id` or `awayTeam.id` |

On `INTER_CLUB` matches `clubId` is the home club, so it is not enough on its own. Keep
checking both sides there.

The server enforces the same rule on every mutation in §6. The client check only decides
what to show.

Put the check in one shared helper rather than inline in `GameDetails.tsx`. The match card
badge (§5) needs it too.

---

## 11. Not available

- Lock or unlock teams
- Any server-sent alert or push about recording a result
- Recording or editing anything outside the 24h window
- Marking an `ENDED` match as not played
- Rescheduling, or editing time, venue or format
- Live match state, goal timestamps, assists, cards

---

## 12. Suggested build order

1. **Status sync** (§4). Independent of the new feature, and fixes a live badge bug.
2. **Authorization helper** (§10), once `Match.clubId` is live.
3. **Clean up `GameDetails`**: remove the local lock and start state, apply the file
   restructure from the design doc, and build the new bottom bar (§3).
4. **Record result sheet**, including `getClubMembers` for `+ Add player`.
5. **Recorded-match view**: edit result, add and remove scorers.
6. **Prompts** (§5): badge, banner, client-derived in-app alert.
7. **`auth` `Player.id` to `Int`** (§6), released together with the backend change, not
   before it.
