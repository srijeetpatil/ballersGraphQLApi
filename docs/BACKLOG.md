# Backlog

Known issues and deferred work, newest first within each section. Each item records where
it came from so the reasoning can be recovered.

Most of these surfaced during code review and were deliberately deferred rather than
forgotten — the detail lived in git-ignored scratch files, so it is recorded here instead.

---

## Security

### SQL injection in the authentication path — HIGH
**Where:** `functions/graphql/model/AuthModel.js` — `getUserWithPhone` (:3),
`createUserModel` (:19), `getPasskeyFromUserModel` (:41)

All three build SQL by interpolating user input into the query string. `createUserModel` is
the worst: five interpolated values, including `passkey`, on the signup path.

```js
`SELECT * FROM test.players WHERE phone = '${phone}'`
```

A phone of `' OR '1'='1` turns the login lookup into "return every player"; an injected
`firstName` executes arbitrary SQL at account creation.

**Fix:** parameterize — `pool.query("... WHERE phone = $1", [phone])`. The lookup key must
stay the phone number (login and signup happen before any user id exists). Keep the
existing signatures, return shapes, and promise style so no caller changes.

**Also while in there:** `createUserModel` and `getPasskeyFromUserModel` assign
`data = results.rows` without declaring `data`, leaking it onto the global object. Not a
live race (no `await` between assignment and `resolve`), just worth tidying.

*Raised 2026-08-22 while reviewing the club-joining-requests work.*

### Hardcoded RSA private key in `graphql/utils/common.js` — HIGH
**Where:** `functions/graphql/utils/common.js` (a `-----BEGIN RSA PRIVATE KEY-----` block
near the top of the file, committed to the repository)

A private key lives in source control. Pre-existing and unrelated to venues; noticed in
passing. It needs to move into configuration (environment or a secret manager) and the key
needs to be **rotated**, since anything that has been committed must be treated as exposed
regardless of who has read access today. Triage before anything else in this file that is
not the SQL injection item above.

*Noticed 2026-11-24.*

---

## Correctness

### `test.matches.match_start_time` is nullable and should be `NOT NULL` — MEDIUM
*(Schema note: the table is now `play.matches`; `test.` below is the name at the time of writing.)*

**Where:** `test.matches.match_start_time` (confirmed nullable against production
2026-10-29); consumers include `utils/matchAuth.js` `getResultWindowState`,
`model/PlayModel.js` `getRatingTrendFromDb`, and `utils/ratingMath.js`.

No row is NULL today, and every creation path already supplies the value —
`createMatchInput.matchStartTime` is `Date!` in the SDL, so the API cannot
produce one. The column is simply permissive where the application is not.

**Why it matters now.** Three places would misbehave on a NULL, all silently:

- The rating **trend** orders `ORDER BY m.match_start_time DESC, pmr.match_id DESC`.
  Postgres sorts NULLs *first* under `DESC`, so a dateless match would become the
  newest point on a player's trend line.
- `ratingMath.js` derives the recency window from `new Date(matchStartTime)`. A
  NULL gives `NaN`, whose comparisons are all false, so the ×2 window would be
  assigned arbitrarily once a player has more than three rated matches.
- `getResultWindowState` already treats an unparseable start as `CLOSED`, which
  means a NULL match could never have a result recorded at all.

**Fix:** `ALTER TABLE test.matches ALTER COLUMN match_start_time SET NOT NULL;`
as a knex migration. Verify `SELECT count(*) FROM test.matches WHERE
match_start_time IS NULL` is 0 immediately before running it — the `ALTER` takes
an `ACCESS EXCLUSIVE` lock and scans the table, which is brief at current size
(43 rows) but will not stay that way.

While in there, consider the same question for `test.players.is_deleted`, which
is also nullable with **no default**. Every read in the codebase already spells
it `IS NOT TRUE` for exactly that reason; a `NOT NULL DEFAULT false` would let
those reads become plain `= false`.

*Raised 2026-10-29, during the player-rating-system migration run.*

### `playersAway` returns the home roster when a match has no away team — MEDIUM
**Where:** `functions/graphql/model/PlayModel.js:32-35`, reached from
`Match.playersAway`

`fetchEnrolledPlayers(matchId, teamId)` has a falsy-`teamId` branch that runs
`WHERE match_id = $1 AND is_waiting = false` — **no `club_id` filter and no `is_deleted`
filter**. For a match with no opponent yet, `playersAway` therefore returns every enrolled
player, i.e. the home team's roster including soft-deleted members.

Pre-existing (reachable via `getMatchById`), but club-scoped match lists widened how many
rows hit it. **Fix:** `if (!awayTeamId) return [];` at the call site.

*Found in the 2026-08-12 club-based-player-matches final review.*

### `Alert.homeTeam` / `Match.awayTeam` can null-key the club DataLoader — MEDIUM
**Where:** `functions/graphql/resolvers/Play/Queries.js` — `Alert.homeTeam` (:253)

`clubLoader.load(parent.homeTeam)` is unguarded. DataLoader throws on a null key, and
`TeamData!` is non-null, so selecting the field on a match or alert with no away team can
null out the whole entry. No current write path produces a null `home_team` alert, so this
is latent.

### GraphQL field naming is inconsistent — adopt camelCase everywhere — MEDIUM
**Convention to adopt:** every field exposed in GraphQL is `camelCase`. Database columns
stay `snake_case`; the resolver layer is where the two meet.

Today the schema mixes both, sometimes within one type. `Match` already exposes
`matchStartTime` (mapped in `mapMatchRow`) alongside a raw `is_deleted`. `Club` is returned
straight from the DB row, so all eight of its multi-word fields are snake_case.

**Inventory — 29 fields across 10 types** (generated from the built schemas, excluding the
`_empty` placeholder):

| Schema | Type | snake_case fields |
|---|---|---|
| both | `Club` | `total_members`, `jersey_color_home`, `jersey_color_away`, `is_banned`, `review_status`, `review_notes`, `created_at`, `updated_at` |
| Auth | `Player` | ~~`first_name`, `last_name`, `profile_picture`~~ **(done 2026-08-25)**, `is_banned`, `saved_upi_ids`, `created_at`, `updated_at`, `is_deleted` |
| Auth | `PlayerBasicDetails` | `is_banned`, `saved_upi_ids`, `created_at`, `updated_at` |
| Auth | `ClubBasic` | `is_admin` |
| Auth | `createClubInput`, `updateClubInput` | `jersey_color_home`, `jersey_color_away` |
| Play | `Team` | `jersey_color`, `created_by` |
| Play | `Match`, `Player` | `is_deleted` |

**Why it is worth doing.** It already caused a production-shaped bug: `ClubJoinRequest.player`
was written against Play's camelCase `Player`, and moving the join-request resolvers to the
`auth` function broke it with `Cannot return null for non-nullable field Player.first_name`.
Nothing catches that at build or load time — only a real query does. The planned club-domain
consolidation will move more resolvers between functions, so this trap is live.

**The real cost is not the rename.** Types currently returned as raw DB rows — `Club` from
`clubLoader` and `getClubsListFromDb`, `Player` from `playerLoader` — would each need a
mapping function in the resolver layer, the way `mapMatchRow` already does for `Match`.
That mapping is where the work is.

**Migration strategy (breaking otherwise):** add the camelCase fields *alongside* the
snake_case ones, deprecate the old names, let the client migrate, then remove them. A
straight rename breaks every client query touching those 29 fields at once. Inputs
(`createClubInput`, `updateClubInput`) can accept both spellings during the transition.

**Do this before the club-domain consolidation**, not after — consolidation moves resolvers
between schemas, which is exactly what this inconsistency punishes.

**Progress 2026-08-25:** the three name fields on `auth.Player` were renamed to camelCase
(`fix/auth-player-field-casing`), after the frontend hit the validation error described
below during integration. That needed a mapper rather than a schema edit alone — both
producers (`userWithPhoneExists` on the login path, and `ClubJoinRequest.player`) return
raw database rows. `graphql/utils/playerMappers.js` now exists and is the pattern to follow
for the remaining types. **26 fields still to go.**

*Raised 2026-08-24.*

### Two different `Player` types share one name across schemas — MEDIUM
**Where:** `functions/graphql/schema/Auth.js:7` and `functions/graphql/schema/Play.js:66`

Both schemas declare `type Player`, and they are **not** the same shape:

| Auth.js | Play.js |
|---|---|
| `first_name`, `last_name`, `profile_picture` (snake_case, mirrors the DB) | `firstName`, `lastName`, `profilePicture` (camelCase) |
| `id: ID!`, `phone: String!` | `id: Int!`, `phone: String` |
| has `is_banned`, `saved_upi_ids`, `created_at`, `updated_at` | does not |

A resolver returning a player is therefore only correct for the schema it happens to live
on, and moving one between functions breaks it **silently at the type layer** — the failure
surfaces as `Cannot return null for non-nullable field Player.first_name` at query time,
not at build or load time.

This bit once already: `ClubJoinRequest.player` was written against Play's camelCase
`Player`, and moving the join-request resolvers to `auth` broke it. Fixed by returning the
raw row, which matches Auth's `Player` exactly.

**Related:** the camelCase convention item above. Note these are distinct problems — even with uniform casing the two `Player` types would still expose different field *sets*.

**Options:** converge both on one definition in `shared.js` (breaking for whichever clients
use the losing shape), or rename so the divergence is visible (`PlayerProfile` vs
`PlayerSummary`). Either way the current state is a trap for anyone moving code between
functions — which the club-domain consolidation will do.

*Raised 2026-08-24.*

### `matchLoader` spreads a null match — LOW
**Where:** `functions/graphql/dataloaders/matchLoader.js:7-9`

`matches.find(...) || null` followed by `...match` throws a `TypeError` for a missing id.
Only reachable through `Alert.match`.

### Module-level DataLoaders cache for the process lifetime — MEDIUM
**Where:** `functions/graphql/dataloaders/*.js` (all four)

Created at require time, never per request, so in a warm Cloud Functions instance the cache
never clears — a renamed club or player serves stale indefinitely. Tolerable for names;
would be a **security bug** for anything viewer-scoped, which is why
`viewerJoinStatus` builds its scope per request instead.

*Note: an outcome alert's description is built from `clubLoader` and then persisted
(`ClubJoinRequests.js`), so a stale name can be baked permanently into an alert row.
`createMatchInviteAlerts` deliberately reads uncached for this reason.*

**Update 2026-11-24:** sharper now. Venue rows used to never change; they now change through
admin action (verify, edit, close, reject, merge). `venueLoader` therefore serves a stale
status, name or `merged_into_venue_id` from any warm instance after an admin acts. See
"Venues" below for how this interacts with the match-creation guard.

### Raw `pg` error text reaches the client — LOW
Non-23505 failures concatenate `error.message`, exposing constraint and schema names.
Consistent with existing resolvers, so this is a codebase-wide cleanup, not a one-file fix.

### `markAlertsSeenForRequest` shares a try/catch with the outcome alert — LOW
**Where:** `functions/graphql/resolvers/Play/ClubJoinRequests.js`

If marking alerts seen fails, the requester's ACCEPTED/REJECTED notification is never
written. Two separate catches would isolate them. Triaged as defer — the mutation still
returns correct state.

---

## API gaps

### No query for join requests — MEDIUM
There is no `getClubJoiningRequests`, and `Alert` carries `requestId` but no `request`
field. Three consequences the frontend must work around:

1. A **rejected** player cannot practically receive their outcome alert — reading it needs
   `getPlayerAlertsForClub(clubId)`, but after rejection the club is not in
   `getPlayerClubs`, so the client has no way to learn the id. Requires local tracking.
2. An admin cannot tell an **accepted** request from a **rejected** one in their feed —
   resolved alerts are only flipped to `seen: true`.
3. Pending state is not queryable per club.

`viewerJoinStatus` on `Club` (implemented 2026-08-22) closes (3) everywhere `Club` is
returned. A
`getClubJoiningRequests(clubId: Int)` query — scoped to your own requests when you are not
an admin, to the club's when you are — would close (1) and (2). It reuses the existing
`ClubJoinRequest` type and field resolvers.

*Raised 2026-08-22 while writing the frontend brief.*

### `playerId` comes from input rather than the JWT on `getPlayerMatches` — LOW
**Where:** `functions/graphql/resolvers/Play/Queries.js`

Lets a caller query another player's matches for a club. Deliberate deferral: hardening it
removes the ability to query on behalf of another player, which may be wanted. `getPlayerClubs`,
`getPlayerAlertsForClub`, and both join-request mutations already read the player from the JWT.

### `access: PRIVATE` is unenforced — LOW
Nothing in the codebase enforces club access semantics. PRIVATE clubs are searchable and
accept join requests like any other. Since every request needs admin approval, PRIVATE
currently means only "no unsolicited request notifications".

---

## Architecture

### No migration system — adopt knex migrations for schema changes — MEDIUM
**Where:** `functions/package.json` (no `knex` dependency); schema history lives only in plan
docs, e.g. `docs/superpowers/plans/2026-08-15-club-joining-requests.md` Task 1 and
`docs/superpowers/plans/2026-09-14-record-match-result-backend.md` Task 1

Every schema change so far has been SQL pasted into a plan and run by hand against the dev
database. Nothing records which changes have run where, a new environment cannot be rebuilt
from the repo, and there is no down path. The record-match-result work alone converted 16
timestamp columns, deleted test matches, and added two tables this way.

**Decision (2026-09-14):** from the next schema change onward, changes ship as knex
migrations.

**Setup to do:**
- Add `knex` to `functions` and a `knexfile.js` reading the same `DB_HOST` / `DB_USER` /
  `DB_PASSWORD` / `DB_NAME` env vars as `graphql/config/dbConfig.js`, with `ssl: true` and the
  `test` schema.
- Use knex **only for migrations**. Queries stay on the existing `pg` pool; no query-builder
  rewrite.
- Keep the migrations table in the `test` schema too (`migrations.schemaName`), so it sits
  beside the tables it tracks.
- Write a **baseline migration** that marks the current schema as applied, so the first
  real migration does not try to recreate existing tables. Do not replay the old plan SQL.
- Add `migrate:latest`, `migrate:rollback` and `migrate:make` npm scripts, and decide where
  migrations run: by hand before `npm run deploy`, or as a deploy step. Not from inside the
  Cloud Function at cold start, where concurrent instances would race on the lock.
- Every migration gets a real `down`. A data-destroying `up` (like the test-match deletes)
  says so in the file.

*Raised 2026-09-14, after hand-running the record-match-result DDL.*

**DONE 2026-10-29.** knex is installed as a **devDependency** (migration tool
only — it must stay out of the Cloud Function bundle, and queries remain on the
`pg` pool), configured in `functions/knexfile.js` with
`migrations.schemaName: "test"`, and driven by `migrate:latest` /
`migrate:rollback` / `migrate:make`. The baseline migration is an empty no-op
that marks the pre-knex schema as applied — there was no DDL in the repo to
replay, since the live database was the only record of it.

Batch 1 ran against production on 2026-10-29: the baseline, the `played` column
on `player_match_map` with its backfill, and the two rating tables.
`knex_migrations` and `knex_migrations_lock` were confirmed to land in `test`
rather than `public`.

Two things learned that the plan above did not anticipate:

- **Adding knex moved production `lodash` from 4.17.21 to 4.18.1**, because knex
  requires `^4.18.1` and npm deduped the tree onto one version satisfying both.
  Holding it needs an `overrides` entry, and the entry must be written
  `"lodash": "$lodash"` — a literal version is rejected with `EOVERRIDE` when it
  contradicts a direct dependency spec.
- **Checking a `pg_dump` of `test` into the repo is still worth doing.** Without
  it the baseline is a promise rather than a record, and a new environment still
  cannot be rebuilt from the repo — which was half of this item's original point.

*Still open from this item: the `pg_dump` baseline, and deciding whether
migrations run by hand before `npm run deploy` or as a deploy step.*

### `play` carries most traffic — consider splitting the function — MEDIUM
**Where:** `functions/index.js` — only two functions are exported, `ballersApiAuth` and
`ballersApiPlay`

`play` exposes 10 operations to `auth`'s 6, and the imbalance is worse than the count
suggests: `play` holds everything high-frequency (club list, matches, alerts, enrollment,
join requests) while `auth` holds login and signup, which fire about once per session.
Effectively all sustained traffic lands on one function.

**Why it matters:** per-function concurrency and invocation limits apply per deployed
function, so `play` hits ceilings first while `auth` sits idle. A cold start or a bad
deploy on `play` also takes down every feature at once — there is no blast-radius
separation between, say, browsing clubs and enrolling in a match.

**Rough split to consider:** clubs/membership/join-requests vs. matches/enrollment, since
those two clusters have different traffic shapes and share little beyond `player_club_map`.
Model files are already organised per function, so the code boundary largely exists.

**Watch for:** each function is a separate deployment and gets its own `pg` pool, so
splitting multiplies total connections against the database — size pools deliberately
(`dbConfig.js` currently sets no `max`, defaulting to 10 per instance).

**Update 2026-08-22:** partially addressed, then mostly reverted. The two new join-request
mutations went to `auth` (where the club lifecycle already lives). `getPlayerClubs` and
`getClubsList` were moved too, then **moved back** — they are live queries and relocating
them would break the client for no immediate gain.

**Net result:** the club domain is split — created/moderated/joined on `auth`, browsed on
`play`. Consolidating it is still worth doing, but as its own coordinated change. The safe
pattern is to serve the operations from **both** functions temporarily, migrate the client,
then retire the old copies — the client can then move independently with no downtime
window.

Original assessment follows. The whole club domain (browse, join, plus the
create/update/review that were already there) moved to `auth`, leaving `play` with matches,
venues, and alerts. `play` is down from 10 operations to 4 queries + 4 mutations. This
rebalanced the split but did not add a function, so the "one function per deploy blast
radius" concern stands. `getPlayerAlertsForClub` deliberately stayed on `play` because
alerts serve match invites as well as join requests — so the admin inbox flow crosses
functions.

*Raised 2026-08-22.*

### Per-request player-existence check — revisit before scale, not now
**Where:** `functions/graphql/context/viewerScope.js:34` — the only place it happens today

`loadScope` does `SELECT id FROM test.players WHERE id = $1 AND is_deleted IS NOT TRUE` on
every authenticated request that touches a viewer-scoped field. Six other files verify JWTs
without any DB lookup, so this is currently one check, memoized once per request — not per
resolver and not per club.

**The reframe:** the signed JWT already proves identity. This lookup answers "has this
account been deleted or banned since the token was issued?" So the design question is
revocation latency, not caching.

**Options, roughly in order of what to reach for:**

1. **Short-lived access tokens + refresh tokens** — verify by signature alone (zero DB
   hits); enforce revocation at refresh, where you hit the DB anyway. A banned user keeps
   access for at most one token lifetime. Cheapest real fix, and it lets the check be
   dropped entirely.
2. **Revocation denylist in Redis** — cache only revoked ids, so the set stays small; O(1)
   negative lookup. Use when revocation must be instant.
3. **Token versioning** — a `token_version` column embedded in the JWT; bump to invalidate
   all of a user's tokens. Gives "log out everywhere" cheaply.
4. **Positive cache with short TTL** — bounds staleness explicitly, but a banned user
   retains access for the TTL.

**In microservices the usual answer is none of these per-service:** the gateway validates
once at the edge and passes verified identity downstream. Re-validating in every service is
the anti-pattern this item is trying to avoid.

**Stack-specific cautions:** Cloud Functions instances are ephemeral, so an in-process
cache has an unpredictable hit rate — and carries the same staleness trap as the
module-level DataLoaders noted above. Redis via Memorystore needs a Serverless VPC
Connector: real cost and ops overhead for one indexed lookup.

**Recommendation:** leave as-is until measured. Revisit when either the check spreads
beyond `viewerScope` or request volume makes it visible in latency.

*Raised 2026-08-22.*

---

## Venues

Deferred from the work that made venues a canonical entity (statuses, coordinates/PostGIS,
user submissions, problem reports, the admin review queue, and the guard that stops matches
being created on unpickable venues). Grouped by theme; each item says why it was left and
what would make it worth doing.

### Admin and moderation gaps

#### No admin path out of `REJECTED` — MEDIUM
`adminReviewVenue` refuses `VERIFY` on a `REJECTED` venue, deliberately, so a single stray
action cannot resurrect a venue already judged not real. `EDIT` cannot change status. So a
**mistaken rejection cannot be undone through the API**; it takes hand-run SQL.

**Fix:** an explicit, auditable `REOPEN` (or `UNREJECT`) action that sets status back to
`UNVERIFIED`, as its own change. **Do not** fix it by loosening the `VERIFY` gate — the gate
is correct, the missing piece is a deliberate way out. **Trigger:** the first time an admin
rejects the wrong venue.

#### `isAppAdminFromDb` does not check `is_deleted` — MEDIUM
**Where:** `functions/graphql/model/AuthModel.js:181`

A soft-deleted admin still passes the admin check. Identical across every existing admin
resolver, so it was left out of the venues work to avoid a one-off fix that would make the
resolvers inconsistent. It should not stay unexamined: fix it once, in the shared helper
(`AND is_deleted IS NOT TRUE`, the spelling the rest of the codebase uses), and confirm
every admin resolver goes through it. **Trigger:** before the admin set grows beyond people
you know personally, or whenever an admin account is deleted.

### Rejecting a venue leaves inbound duplicate pointers aimed at it — LOW
**Where:** `graphql/resolvers/Play/Venues.js` (the `REJECT` branch), alongside
`resolveOpenVenueReportsFromDb` in `graphql/model/PlayModel.js`.

Rejecting venue X resolves the open reports filed *on* X, but an open report elsewhere whose
`duplicate_of_venue_id` is X keeps pointing at a now-REJECTED venue — and the obvious
follow-up, merging into X, is refused because X is rejected. So that report cannot be
actioned either way without the admin editing it by hand.

The merge already handles the same shape in its own direction: its step 2b redirects or
resolves pointers aimed at the venue disappearing. `REJECT` has no equivalent. It is
harmless today (`play.venue_reports` holds 0 rows) and it is arguably a product question
rather than a defect — whether rejecting a venue should answer the reports that merely
*mention* it is a judgement call, not an invariant.

**Trigger:** the first time an admin rejects a venue that other open reports name as a
duplicate target. Worth deciding alongside the REOPEN action above, since both are about
what an admin can undo.

### Merge concurrency

Both items below are narrow races in the venue merge. Neither can corrupt data: the worst
outcome is an error to the admin and a clean rollback. They were parked for that reason.

#### `reportVenueProblem` does not lock the venue row it reads — LOW
A user filing a report on the merge **source** in the gap between merge steps (c) (clear
colliding open reports) and (d) (repoint open reports) makes the repoint hit
`venue_reports_one_open_per_user_venue` and the whole merge aborts with a raw `23505`.
`SELECT ... FOR UPDATE` on the merge side cannot block an `INSERT`, so closing the window
needs the lock on the **report mutation's side** (lock the venue row it reads, so it
serialises against the merge). **Trigger:** merges become frequent enough, or reports
concurrent enough, that an admin actually sees the opaque error.

#### The merge's inbound repoint locks rows outside the id-ordered discipline — LOW
**Where:** `functions/graphql/model/PlayModel.js`, around the step-4 repoint
(`UPDATE play.venues SET merged_into_venue_id = $target WHERE merged_into_venue_id = $source`)

The rest of the merge takes its row locks in id order. This statement locks the inbound rows
(venues already merged into the source) in whatever order the scan finds them, so two admins
merging concurrently can deadlock with `40P01` — specifically when one is re-merging an
already-merged venue and an inbound id is lower than the target id. That needs two
simultaneous merges, one of which was already invalid. Result is a full rollback.

**Cheapest fix:** fold the inbound ids into the initial id-ordered lock. **Trigger:** a
second admin, or any `40P01` in the logs.

### Input limits

#### `submitVenue`'s text fields are uncapped — LOW
`address`, `locality` and `city` have no length limit. `reportVenueProblem`'s `note` is
capped at 1000 trimmed characters; these are the same unbounded-`text` exposure. They were
left out of the report work deliberately so that diff stayed about one thing. **Fix:** trim
and cap them the way `note` is, and decide the limits once for all three (and `name`, if it
is not already bounded). **Trigger:** do it with the next change that touches `submitVenue`,
or sooner if submissions are opened to a wider audience.

### Search and ranking

#### Typo tolerance across every search surface — one coordinated change
*Decided 2026-11-24.* All search in this codebase is case-insensitive **substring**
matching (`ILIKE '%…%'`), which is not typo-tolerant: `"CONVENT"` finds Presentation Convent
but `"convnt"` finds nothing. The surfaces today are `searchVenuesFromDb` (`PlayModel.js`,
venue name) and `getClubsListFromDb` (`PlayModel.js:246`, club name/locality/description).
Both already escape LIKE metacharacters through `escapeLike` in
`graphql/utils/clubSearch.js`, and `pg_trgm` is installed with `similarity()` already used as
an ordering tiebreak in venue search.

Moving to typo tolerance means adding a `%` similarity predicate alongside the substring
match, choosing a similarity threshold, and deciding how similarity ranking interacts with
each surface's current ordering — venue search is deliberately alphabetical, club search has
its own name/locality/description precedence. Do it for all surfaces at once so the
behaviour is consistent; piecemeal would leave searches that behave differently from each
other. **Trigger:** lists long enough that typing is the only practical way to find
something.

#### Venue ranking for the no-location case — deferred 2026-11-23
`searchVenues` falls back to alphabetical when it has no coordinates. Popularity ordering
(match count, recent-weighted) was designed and deliberately dropped: with no users, a
ranking built on 49 historical matches would encode noise rather than preference.

When there is real usage, the ordering hook is one `ORDER BY` in `searchVenuesFromDb`, and
the activity aggregate in `getVenueActivityByIdsFromDb` is where the counts would come from.
Open questions for then: whether to weight recent activity over all-time and over what
window; whether to expose the count as a `Venue` field for a "most played here" label; and
whether personal history ("venues you've played at") beats global popularity as a picker
default. **Trigger:** the app has users.

#### Dormancy / "stale venue" handling — removed 2026-11-24
Removed at the owner's request (*"no need for the dormancy algorithms, we are still building
the earliest of the systems"*), not merely disabled. `Venue.isDormant`,
`Venue.lastActivityAt`, the per-request activity loader, `includeDormant` on
`venueSearchInput` and `DORMANT_AFTER_DAYS` were all taken back out, so nothing about a
venue's last activity is exposed or queried today.

If it returns, the design is already settled and these findings are worth not
rediscovering:

1. The activity predicate must exclude soft-deleted matches,
   `match_status = 'MATCH_INVITATION_DECLINED'`, and future kickoffs
   (`match_start_time <= now()`). Measured on real data those three clauses exclude 6 of 49
   matches, so an unqualified `max(match_start_time)` reports a date that has not happened
   yet.
2. Any loader must be built **per request**, because dormancy changes with the clock while
   the module-level `venueLoader` caches for the whole process lifetime.
3. Dormancy must not touch `ORDER BY` — when it did, the alphabetically-first venue was
   pushed to the bottom of the picker.

**Trigger:** enough venues that genuinely dead ones clutter the picker.

### Performance and index hygiene

#### `searchVenuesFromDb` cannot use `venues_geog_gix` — deferred
`ORDER BY (geog IS NULL), geog <-> point` — the leading null-check term defeats the KNN
operator, so `EXPLAIN` shows Seq Scan + Sort even with `enable_seqscan = off`. Deliberate:
keeping uncoordinated venues in the result matters more than index usage, and at four rows a
scan is free. The fix at scale is a `UNION ALL` of a KNN query over located rows plus the
null-geog rows. **Trigger:** a few thousand venues in one city.

#### `venues_name_trgm` was created with an unqualified `gin_trgm_ops` — LOW
The rest of `20261123100100_extend_venues.js` schema-qualifies everything for `search_path`
robustness; this index does not. It cannot break the existing index (an operator class
resolves once, at creation), so it is a reproducibility wrinkle only. The migration was
deliberately not edited after it had run. **Fix:** qualify it if the index is ever rebuilt.

### Schema constraints and loose ends

- **`play.venues.pincode` is an `integer`.** Fine for Indian six-digit pincodes (no leading
  zeros), wrong in principle. Deliberately untouched.
- **`VENUE_FORMATS` exists in `venueGeo.js`, but `play.matches.format` is still
  unconstrained.** Converging them (validate or constrain the column against the list) is a
  follow-up.
- **Should `play.matches.venue_id` become `NOT NULL`?** 0 of 49 rows are null today, so it
  would apply cleanly, but nothing has been decided about whether matches without a venue
  are a legitimate state.

### Deferred features
Booking integration, the owner-claim flow, a venue edit-suggestions table, multi-city
tooling, and admin notification of new submissions were scoped out of the first version.

Admin notification was dropped on 2026-11-24 at the owner's request. The app has a single
admin who reviews and verifies every submission by hand, and the review queue already
surfaces new submissions; a notification channel would add a delivery mechanism, a template
and a failure mode for something the admin is already looking at directly. **Trigger:** more
than one admin, or enough submission volume that an admin stops checking the queue daily.

---

## Product

### No cooldown on re-applying after rejection
A rejected player can re-apply immediately. Deliberate — the one-pending-request rule
covers the realistic case. Revisit if rejected players spam admin alert feeds.

*Deferred 2026-08-22.*

### Not built, by design
No withdraw/cancel of a pending request; no invite-a-player flow; no leave-or-remove-from-club
path anywhere in the codebase.
