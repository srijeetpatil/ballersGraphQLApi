# Venues as a Canonical Entity — Design Spec

**Date:** 2026-11-19
**Branch:** `feat/venues-canonical-entity` (in the `functions` submodule, based on `feat/domain-schema-split`)
**Status:** **Approved 2026-11-20.** Builder check done 2026-11-19; the two questions it
raised for the user were answered 2026-11-20 and are recorded in "Two changes to existing
behaviour" near the end.
**Scope:** Backend only. No client work this round.

---

## Intent and why

`play.venues` is a four-row lookup table holding names and a locality string. Players pick
a venue when creating a match, and that is the whole of its role today.

Three features that are planned need venues to be a real entity with a real location:
matchmaking, venue-based communities, and "games near me". None of them can be built on a
name and a free-text locality. This round makes venues canonical — coordinates, status,
provenance, an identity that survives duplicates — so those features have something to
stand on.

Venues stay curated. The team owns the list. Users can add one that is missing, it is
usable immediately, and an admin reviews it afterwards. Growth comes from user
submissions, owner claims and a manual monthly sweep — never bulk scraping or syncing
from Google.

Launch is one city, Navi Mumbai. The dataset stays small for the foreseeable future, and
several decisions below trade scalability away for simplicity on purpose.

---

## Goals

- One `venues` table is the source of truth; everything references `venue_id`.
- Every venue can carry coordinates, so distance sorting and radius search work.
- Users can submit a missing venue, which is immediately usable, and is reviewed later.
- Duplicates are prevented at submission time, and merged when they slip through.
- Venues are never hard-deleted, because matches reference them.
- An admin can work a review queue: verify, edit, merge, reject, close.
- The schema is ready for owner claims, edit suggestions and multiple cities without
  restructuring.

## Non-goals (this round)

- **All client work.** The venue picker, Places Autocomplete and the pin-drop map are
  frontend, and the frontend is not yet designed. This round ships the API those flows
  will call. No frontend brief is written either — that follows once the UI is designed.
- **Any paid Google API call.** Nothing in this round contacts Places. The client sends a
  `google_place_id` it obtained itself; the backend only stores it.
- Booking integration, the owner-claim flow, a venue edit-suggestions table,
  multi-city tooling.
- Notifying admins of new submissions (see Approaches).

## Anti-goals

Things that would make this a failure even if it technically worked:

- **Breaking `getAllVenues`'s contract.** The client calls it today and it is the
  match-creation path. Its name, arguments and response shape must survive intact. (Its
  *auth* changes deliberately — see the decisions section near the end.)
- **A migration that loses or renumbers the four existing venues.** 49 matches point at
  ids 1–4 by bare integer. Those ids are permanent.
- **Letting a venue become unreachable from an old match.** A closed, merged or rejected
  venue must still resolve on a match that was played there.
- **Caching Google's venue data.** Storing `place_id` is permitted; mirroring names,
  addresses and ratings into our table is not. We store what the user submitted, not a
  copy of Google's record.
- A dedupe rule so eager that two genuinely different turfs in one complex cannot both
  exist.

---

## Constraints

- **Neon Postgres 15.20.** App role `ballers_owner`, not a superuser.
- **PostGIS 3.3.10 is available but not installed.** Verified on 2026-11-19 that
  `CREATE EXTENSION postgis` succeeds as `ballers_owner`, inside a transaction that was
  rolled back. `pg_trgm` 1.6 is **already installed**.
- **knex for migrations only.** It is a devDependency and must stay out of the Cloud
  Function bundle. All queries stay on the `pg` pool in `graphql/config/dbConfig.js`.
  `knex_migrations` lives in the `test` schema; data lives in domain schemas.
- **No DDL for `play.venues` exists in the repo.** The baseline migration is a deliberate
  no-op, so the live database is the only record of the current shape. The column
  inventory below was read off production on 2026-11-19.
- **No automated tests in this project.** Verification is manual, against the live
  database and through GraphQL. Migrations must therefore be unusually defensive, and
  every one needs a real `down`.
- **Cloud Functions hold warm pooled connections** to this same database. Any migration
  taking `ACCESS EXCLUSIVE` must bound its locks, as
  `20261110171848_split_test_schema_into_domains.js` does.

### Current state of `play.venues`, read from production 2026-11-19

| Column | Type | Null | Default |
|---|---|---|---|
| `id` | `integer` | NO | `nextval('play.venues_id_seq')` |
| `name` | `varchar(255)` | NO | — |
| `address` | `text` | YES | — |
| `pincode` | `integer` | YES | — |
| `locality` | `varchar(255)` | YES | — |

Only index is `venues_pkey`. **No foreign keys reference it.** Four rows:

| id | name | locality | matches | last match |
|---|---|---|---|---|
| 1 | Terna College Turf | Nerul | 4 | 2026-10-12 |
| 2 | NR Bhagat Turf | Nerul | 10 | 2026-09-06 |
| 3 | Presentation Convent School Turf | Seawoods | 21 | 2026-10-31 |
| 4 | Gymkhana Turf | Nerul | 14 | 2025-11-30 |

`address` and `pincode` are null on all four rows; `locality` is set on all four.
`play.matches.venue_id` is a nullable `integer` with **no nulls and no orphans** across
all 49 matches.

### Conventions this follows, read from the existing schema

- Every `created_at` / `updated_at` in `auth`, `play` and `alerts` is `timestamptz`.
- Status-like columns are `varchar(20) NOT NULL DEFAULT '...'` with `UPPER_SNAKE_CASE`
  values — `auth.clubs.review_status` defaults to `'PENDING_REVIEW'`,
  `play.matches.match_status` holds `'MATCH_TEAM_SELECTION'`, alert types are
  `'CLUB_JOINING_REQUEST'`. **The brief writes venue statuses in lowercase
  (`unverified`, `verified`); this design uses `UNVERIFIED` / `VERIFIED` to match the
  codebase.** Builder's note: this is a deliberate deviation from the brief's spelling.
- Match formats are `NvN` strings: `1v1`, `2v2`, `3v3`, `5v5`, `6v6`, `7v7`, `9v9`,
  `11v11` live in `play.matches.format` today.
- App-admin authorisation is `is_app_admin` on `auth.players`, checked via
  `isAppAdminFromDb(playerId)` in `graphql/model/AuthModel.js`.
- Transactions use `withTransaction` / `withSavepoint` from
  `graphql/config/dbTransaction.js`.
- Row-to-GraphQL mapping happens in the resolver layer, in `graphql/utils/*Mappers.js`.

---

## Approaches

### How geography is stored — three options considered

**A. Plain `numeric(9,6)` lat/lng, haversine in SQL.** A bounding-box prefilter, then a
hand-written distance expression. No extension, portable to any Postgres. Rejected
because distance maths gets hand-rolled, the ~50 m dedupe check becomes an approximation
we have to get right ourselves, and radius search later re-treads the same ground.

**B. Full PostGIS, `geography(Point,4326)` as the storage.** Correct distances, a GiST
index, `ST_DWithin` as the dedupe primitive. Rejected because lat/lng stop being plain
readable columns: every read and write goes through `ST_X` / `ST_Y` / `ST_MakePoint`,
which touches all three existing model functions and makes the manual coordinate backfill
awkward.

**C. Hybrid — plain lat/lng columns plus a generated geography column. CHOSEN.**
`lat` and `lng` are ordinary `numeric(9,6)`: that is what the API reads and writes, what
the admin edits, what the backfill sets. Beside them sits a `GENERATED ALWAYS AS ... STORED`
geography column with a partial GiST index, used only by distance and proximity queries.
Because it is generated there is no dual-write to fall out of sync. Cost over A is one
extension; cost over B is one redundant stored column per row, which is nothing at this
size.

**Chosen by the user on 2026-11-19, after verification.** The following was proved against
production inside a rolled-back transaction: the extension installs as `ballers_owner`;
the generated column and partial GiST index are both accepted; `ST_DWithin(geog, geog, 50)`
correctly caught a pair 33.2 m apart; radius search ordered by `<->` returned ascending
distances; and a row with null coordinates yielded a null `geog` and dropped out of
results rather than erroring.

### Admin notification — dropped

The brief asked for a notification when a venue is submitted. **Removed, with the user's
agreement.** Two reasons:

1. `alerts.alerts` cannot carry it. Every alert is scoped to a player *and* a club, and
   `graphql/utils/alertScopes.js` buckets each type by `home_team` / `away_team` — a type
   in no bucket is silently dropped from query results. A venue submission has no club,
   so it would need a new player-only type plus fan-out to every `is_app_admin` player.
2. There is no precedent. Creating a club does not notify admins either; `adminReviewClub`
   only writes an alert back to the player. There is not even a query listing clubs
   pending review.

The review-queue query is the notification. If a ping is wanted later, a Slack webhook or
email off the submission mutation is a cheaper fit than bending the alerts table, and it
is purely additive.

### Reports — a table, not a status

"Report a problem" could have reused `status` on the venue itself. It gets its own
`play.venue_reports` table instead, because a report is about a venue that may be
perfectly fine (`VERIFIED` and reported as closed), several users may report the same
venue, and the admin needs to resolve the report without changing the venue. The review
queue then unions pending venues and open reports.

---

## Schema changes

### Migration 1 — `enable_postgis`

```sql
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
```

Its own migration, separate from the column changes, so that if the extension turns out
to be unavailable in some future environment the failure is isolated and obvious.

**`public`, explicitly, and every `ST_*` call in the codebase is written
`public.ST_DWithin(...)`.** Nothing in this repo sets a `search_path` — not the `pg` pool
in `graphql/config/dbConfig.js`, not `knexfile.js` (whose `schemaName: "test"` only
places `knex_migrations`) — and every app query already fully qualifies its tables. So
unqualified `ST_*` would resolve through the default `"$user", public` and work, which is
how the 2026-11-19 verification ran. Qualifying anyway costs nothing and removes the one
way a future `search_path` change could bite: migration 2's generated-column expression
is baked into the table, so fixing that case would be a table rebuild rather than a query
edit. **Builder's note: this is this design's call, not the user's.**

`down` is **a no-op with a comment explaining why**: `DROP EXTENSION postgis` would fail
while the generated column in migration 2 depends on it, and dropping an extension other
work may later depend on is not something a rollback should do silently. Rolling the
extension back is a deliberate manual act.

### Migration 2 — `extend_venues`

Columns added to `play.venues`. Existing columns are **not touched** — `address`,
`pincode` and `locality` all stay as they are.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `lat` | `numeric(9,6)` | YES | — | ~11 cm precision; nullable until backfilled |
| `lng` | `numeric(9,6)` | YES | — | |
| `geog` | `geography(Point,4326)` | YES | generated | `GENERATED ALWAYS AS (CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN ST_SetSRID(ST_MakePoint(lng::float8, lat::float8), 4326)::geography END) STORED` |
| `city` | `varchar(100)` | YES | — | backfilled to `'Navi Mumbai'` for the four seed rows |
| `google_place_id` | `text` | YES | — | unique where not null |
| `status` | `varchar(20)` | NO | `'UNVERIFIED'` | seed rows set to `'VERIFIED'` |
| `source` | `varchar(20)` | NO | `'USER_SUBMITTED'` | seed rows set to `'SEED'` |
| `created_by_user_id` | `integer` | YES | — | FK → `auth.players(id)` `ON DELETE SET NULL`; null for seed rows |
| `created_at` | `timestamptz` | NO | `now()` | see caveat below |
| `last_verified_at` | `timestamptz` | YES | — | set to the migration timestamp for seed rows |
| `merged_into_venue_id` | `integer` | YES | — | self-FK → `play.venues(id)` `ON DELETE RESTRICT` |
| `formats` | `text[]` | YES | — | `NvN` strings, matching `play.matches.format` |
| `surface` | `varchar(20)` | YES | — | `TURF` / `GRASS` / `CONCRETE` / `OTHER` |
| `floodlights` | `boolean` | YES | — | null means unknown, not absent |

**Defaults are deliberately the safe-for-new-rows values, not the seed values.** A row
inserted without an explicit status is `UNVERIFIED` and `USER_SUBMITTED` — unreviewed and
untrusted. The four existing rows are then updated to `VERIFIED` / `SEED` in the same
migration. Doing it the other way round would mean every future submission that forgot to
set a status would silently appear as verified.

**`created_at` caveat:** the four seed rows get the migration timestamp, which is not
when they were really created. That information does not exist anywhere — the column is
being added now. The migration comment must say so, so nobody later reads those four
timestamps as fact.

#### Constraints

```sql
-- status and source are closed sets
CHECK (status IN ('UNVERIFIED','VERIFIED','CLOSED','MERGED','REJECTED'))
CHECK (source IN ('SEED','USER_SUBMITTED','OWNER_CLAIMED'))
CHECK (surface IS NULL OR surface IN ('TURF','GRASS','CONCRETE','OTHER'))

-- a venue cannot be merged into itself
CHECK (merged_into_venue_id IS NULL OR merged_into_venue_id <> id)

-- MERGED and merged_into_venue_id imply each other, in both directions
CHECK (
  (status = 'MERGED' AND merged_into_venue_id IS NOT NULL)
  OR (status <> 'MERGED' AND merged_into_venue_id IS NULL)
)

-- coordinates arrive as a pair, or not at all
CHECK ((lat IS NULL) = (lng IS NULL))

-- coordinates are on Earth. Not the supported-area check, which lives in the
-- application so it can change without a migration.
CHECK (lat IS NULL OR (lat BETWEEN -90 AND 90))
CHECK (lng IS NULL OR (lng BETWEEN -180 AND 180))
```

Checks rather than Postgres enum types: the codebase uses `varchar` for every status
column today, and a `CHECK` can be altered without the enum-migration dance.

#### Indexes

```sql
CREATE UNIQUE INDEX venues_google_place_id_uniq ON play.venues (google_place_id)
  WHERE google_place_id IS NOT NULL;
CREATE INDEX venues_geog_gix ON play.venues USING gist (geog) WHERE geog IS NOT NULL;
CREATE INDEX venues_name_trgm ON play.venues USING gin (name gin_trgm_ops);
CREATE INDEX venues_status_idx ON play.venues (status);
CREATE INDEX venues_created_by_idx ON play.venues (created_by_user_id, created_at DESC);
```

The partial unique index is what enforces "unique where not null" — a plain `UNIQUE`
constraint would permit only one null in some engines and is the wrong tool here. The trgm
index uses the already-installed `pg_trgm` and is what makes substring name search cheap
(see the clarification below — it indexes `ILIKE '%…%'`, which is not the same as
typo-tolerant matching). The
`created_by` index serves the per-user rate-limit count.

`CREATE INDEX` is **not** `CONCURRENTLY`: at four rows it is instantaneous, and
`CONCURRENTLY` cannot run inside knex's migration transaction. Revisit if the table ever
reaches a size where that matters.

### Migration 3 — `add_matches_venue_fk`

```sql
ALTER TABLE play.matches
  ADD CONSTRAINT matches_venue_id_fkey FOREIGN KEY (venue_id)
  REFERENCES play.venues (id) ON DELETE RESTRICT;
```

**Approved by the user on 2026-11-19**, as a change to how existing games reference
venues. `venue_id` stays nullable — 0 of 49 rows are null today, but making it `NOT NULL`
is a separate decision and not needed here.

`ON DELETE RESTRICT` is the point of the constraint: it makes "never hard-delete a venue"
a database guarantee rather than a convention.

Verified pre-migration: 0 null and 0 orphan `venue_id` values, so this applies cleanly.
**The migration must re-verify this immediately before adding the constraint** and fail
with a clear message if rows have appeared since, rather than surfacing a raw Postgres
FK violation.

Bound the locks as the schema-split migration does — `SET LOCAL lock_timeout = '5s'` and
`statement_timeout = '60s'`. `ADD CONSTRAINT ... FOREIGN KEY` takes `SHARE ROW EXCLUSIVE`
on both tables and scans `matches` to validate.

### Migration 4 — `create_venue_reports`

```sql
CREATE TABLE play.venue_reports (
  id            serial PRIMARY KEY,
  venue_id      integer     NOT NULL REFERENCES play.venues (id) ON DELETE RESTRICT,
  reported_by   integer         NULL REFERENCES auth.players (id) ON DELETE SET NULL,
  reason        varchar(20) NOT NULL
                  CHECK (reason IN ('CLOSED','WRONG_DETAILS','NEW_INFO','DUPLICATE','OTHER')),
  duplicate_of_venue_id integer NULL REFERENCES play.venues (id) ON DELETE RESTRICT
                  CHECK (duplicate_of_venue_id IS NULL OR duplicate_of_venue_id <> venue_id),
  note          text            NULL,
  status        varchar(20) NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','RESOLVED','DISMISSED')),
  resolution_note text          NULL,
  resolved_by   integer         NULL REFERENCES auth.players (id) ON DELETE SET NULL,
  resolved_at   timestamptz     NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX venue_reports_open_idx ON play.venue_reports (status, created_at DESC);
CREATE INDEX venue_reports_venue_idx ON play.venue_reports (venue_id);
```

`reported_by` is nullable with `ON DELETE SET NULL` so a report survives the reporter's
account being deleted — the problem it describes is still real. **It is not nullable
because reports are anonymous: `reportVenueProblem` requires a JWT** and takes the
reporter from it, like every other write in this design.

`duplicate_of_venue_id` exists because a `DUPLICATE` report is useless without it — the
admin's next action is MERGE, which needs the other venue's id, and parsing that out of
free text is not a workflow. It is near-free to add now and a second migration later.
**Builder's note: this column is this design's call, not the user's.**

Reports get a cheaper guard than submissions rather than a daily quota: **one `OPEN`
report per user per venue**, enforced by a partial unique index.

```sql
CREATE UNIQUE INDEX venue_reports_one_open_per_user_venue
  ON play.venue_reports (venue_id, reported_by)
  WHERE status = 'OPEN' AND reported_by IS NOT NULL;
```

Re-reporting the same venue returns the existing open report rather than erroring. A
quota would be wrong here — several *different* venues being closed at once is a true
report, not abuse.

### Coordinate backfill

The four seed venues need coordinates, and the brief is explicit that this is manual —
no scraping, no Places lookups. Deliver **a checked-in script**, not a migration:

`functions/scripts/backfill-venue-coordinates.js`, reading a small editable map of
`id → { lat, lng, address, city, formats, surface, floodlights }`. It runs each row as its
own `UPDATE`, is re-runnable, prints a before/after diff, and takes `--dry-run`. Coordinates
outside the supported area are refused with a message, so a transposed lat/lng is caught
rather than stored.

**Who supplies coordinates, confirmed by the user 2026-11-20.** The team gathers the four
seed turfs' coordinates themselves, and for the foreseeable future verifies every new
venue by hand too. So coordinates reach the database by two routes only: this script, and
`adminReviewVenue`. A user submission's coordinates are whatever the client sent, and
stay `UNVERIFIED` until an admin confirms or corrects them — which is why `VERIFY` accepts
field edits in the same call rather than requiring a separate `EDIT`. **The submission
flow is still built this round, unchanged** (user choice, 2026-11-20); the manual
verification is the review step, not a replacement for it.

A script rather than a migration because the values are hand-researched data, not schema,
and because getting one wrong should be a re-run rather than a rollback. The team fills in
the map, or an admin edits the venues through `adminReviewVenue` once that exists. Either
path works; the script is the faster one for four rows.

---

## Application layer

### Supported area

A module `functions/graphql/utils/venueGeo.js` holds:

- `SUPPORTED_AREA` — a Navi Mumbai bounding box, **lat 18.90 to 19.20, lng 72.95 to
  73.15**, with a comment recording that these are deliberately generous and were chosen
  by eye, not surveyed.
- `isInSupportedArea({ lat, lng })`.
- `DUPLICATE_RADIUS_METRES = 50`.
- `SUBMISSIONS_PER_USER_PER_DAY = 3` — the brief says "a few per day". **Builder's note:
  3 is this design's call, not the user's.** One constant, easy to change.
- `buildMapsUrl({ lat, lng, googlePlaceId })`.
- `VENUE_FORMATS` — `['1v1','2v2','3v3','5v5','6v6','7v7','9v9','11v11']`, the values
  already present in `play.matches.format`. `submitVenue` and `adminReviewVenue`
  **reject** an unrecognised format or surface, naming the bad value — `submitVenue`
  via `outcome: INVALID`, `adminReviewVenue` by throwing, since it returns
  `Confirmation`. Rejecting beats dropping silently: a silently discarded format
  is a venue that quietly mis-describes itself. The constant is exported so
  `createMatch` can adopt the same list later; this design does **not** add a constraint
  to `play.matches.format`, which stays unvalidated as it is today.
  **Builder's note: rejecting rather than dropping is this design's call.**

In the application, not the database, so the launch area can change without a migration.
Multi-city is out of scope, but when it arrives this constant becomes a per-city row and
nothing else in the design has to move.

### The maps link is computed, never stored

A `mapsUrl` resolver field on `Venue`, built from Google's documented URL scheme:

```
https://www.google.com/maps/search/?api=1&query=<lat>,<lng>&query_place_id=<place_id>
```

`query_place_id` is appended only when a `google_place_id` exists; `query` alone works for
pin-drop venues. This deep-links into the Maps app on both platforms. Returns `null` when
there are no coordinates. Nothing is stored, nothing goes stale, and it is not a cache of
Google data.

### Status visibility rules

| Status | Default picker | Search | Resolves on an old match |
|---|---|---|---|
| `VERIFIED` | yes | yes | yes |
| `UNVERIFIED` | yes, tagged unverified | yes | yes |
| `CLOSED` | no | yes | yes |
| `MERGED` | no | no — redirects to the target | yes |
| `REJECTED` | no | no | yes |

The last column is the anti-goal above: a match played at a since-rejected venue must
still render. So `getVenueById` and the DataLoader **never filter by status** — only the
list and search queries do.

`MERGED` venues redirect — **but only on the by-id lookup, never through the DataLoader.**
Clarified 2026-11-23; as first written this sentence contradicted the table above it, which
says a merged venue still resolves on an old match.

- **`getVenueById` follows `merged_into_venue_id` one hop** and returns the survivor. This
  is the client-facing lookup, and the only way it sees a `MERGED` id is a stale one — a
  cached picker entry or a deep link — where landing on the surviving venue is exactly
  what the caller wants.
- **`venueLoader` / `Match.venue` does NOT redirect.** The merge mutation repoints
  `play.matches.venue_id` to the target, so after a successful merge no match points at a
  `MERGED` venue at all. If one ever does, something went wrong, and silently displaying
  a *different* venue on a historical fixture would hide the fault instead of showing it.
  The row still resolves, which is what the table's "resolves on an old match" means.

One hop only, and the merge mutation must prevent chains (see below).

### Dormancy — REMOVED 2026-11-24

Removed at the project owner's request, before it shipped: *"No need for the dormancy
algorithms, we are still building the earliest of the systems, at this point no need for
perfection."* It had been built and was taken back out, not merely switched off.

Gone: `Venue.isDormant`, `Venue.lastActivityAt`, their field resolvers, the per-request
activity loader, `includeDormant` on `venueSearchInput`, and `DORMANT_AFTER_DAYS`. Nothing
about a venue's last activity is exposed or queried. `searchVenues` orders by distance when
coordinates are supplied and by `name` otherwise, and filters only on status.

Three things learned, kept here so a later attempt does not rediscover them:

1. **The activity predicate cannot be a bare `max(match_start_time)`.** It must exclude
   soft-deleted matches, `match_status = 'MATCH_INVITATION_DECLINED'`, and future kickoffs
   (`match_start_time <= now()`). Measured against real data those three clauses exclude 6
   of 49 matches, so without them a venue reports activity on a date that has not happened.
2. **Any loader must be per request.** Dormancy changes with the clock, not only when data
   changes, and the module-level `venueLoader` caches for the whole process lifetime — a
   value cached there would be wrong in a way the existing staleness is not.
3. **Dormancy must never touch `ORDER BY`.** When it did, the alphabetically-first venue
   (Gymkhana Turf, the one dormant venue) was pushed to the bottom of the picker, which
   contradicts the plain alphabetical fallback the owner chose.

For the record, the measurement that made the rule look unattractive at this size: of four
venues only Gymkhana Turf was dormant (last played 2025-11-30, 359 days, 14 matches);
NR Bhagat Turf at 78 days sat inside the window.


### Name matching is substring, not fuzzy

Clarified 2026-11-23 after implementation. The spec originally called this "fuzzy name
match via pg_trgm", which overstated it. What is built, and what `pg_trgm`'s GIN index
accelerates here, is `name ILIKE '%' || $q || '%'`: **case-insensitive substring
matching.** So `"CONVENT"` and `"bhagat"` both find their venue, but `"convnt"` finds
nothing.

Typo tolerance would need a similarity predicate (`name % $q`, using `pg_trgm`'s
`%` operator and its similarity threshold) and would naturally want similarity ordering,
which pulls against the deliberately plain alphabetical ordering the user chose.

**Confirmed by the user 2026-11-24: substring matching for now, and typo tolerance will be
added across every search surface at once rather than feature by feature.** The codebase
has more than one search — venue name here, and club name/locality/description in
`getClubsListFromDb` — and they should not diverge in how forgiving they are. Backlogged
as one coordinated change.

User input is escaped through `escapeLike` (`graphql/utils/clubSearch.js`), the same helper
club search uses, so `%` and `_` match literally and a query of `%` returns nothing rather
than every venue.

### Distance sorting

When the caller supplies coordinates, `searchVenues` returns `distanceMetres` and orders
by it. Implemented with `ST_DWithin` for the radius cut and `geog <-> point` for the
ordering, which uses the GiST index.

Venues with no coordinates must not disappear from a distance-sorted search — three of the
four seed venues will have none until the backfill runs. They sort **after** all located
venues, with `distanceMetres: null`, rather than being filtered out. This matters during
the backfill window and whenever a pin-drop venue lacks coordinates.

---

## GraphQL API

All of this lives on the `play` function, beside the existing venue code.

### Types

```graphql
type Venue {
  id: ID!
  name: String!
  address: String
  pincode: String          # unchanged: integer column, exposed as String today
  locality: String
  city: String
  lat: Float
  lng: Float
  status: String!
  source: String!
  googlePlaceId: String
  mapsUrl: String          # computed
  formats: [String!]
  surface: String
  floodlights: Boolean
  lastVerifiedAt: Date
  createdAt: Date!
  mergedIntoVenueId: Int
  distanceMetres: Float    # only when the query supplied coordinates
}
```

New fields are **additive**. `pincode`, `address`, `locality`, `name` and `id` keep their
current spelling and types so no existing client query breaks.

Field naming is camelCase throughout, per the convention item in `docs/BACKLOG.md`. Note
this makes `Venue` internally inconsistent in the same way that item describes — new
camelCase fields beside the inherited `pincode` / `address` / `locality`. Those three are
single words, so no rename is actually implied.

### Queries

```graphql
getAllVenues: [Venue]                                   # EXISTING - preserved
searchVenues(data: venueSearchInput!): [Venue!]!
getVenueById(id: ID!): Venue
getVenueReviewQueue(data: venueReviewQueueInput): VenueReviewQueue!   # admin only
```

**`getAllVenues` keeps its name, arguments and return shape.** Two things change:

1. It filters to pickable statuses (`VERIFIED`, `UNVERIFIED`) instead of returning every
   row. Today all four rows are `VERIFIED`, so **the response is byte-identical on the
   day this ships** — the filter only starts mattering once a venue is closed, merged or
   rejected, which is correct.
2. It requires a JWT, which it does not today. See the decisions section near the end —
   this is the round's only client-breaking change.

`getVenuesByIdsFromDb` behind the DataLoader is **not** status-filtered, per the
visibility table.

```graphql
input venueSearchInput {
  query: String            # case-insensitive SUBSTRING match, trigram-indexed. NOT typo-tolerant
                           #   — see "Name matching is substring, not fuzzy" below
  lat: Float               # supplying both enables distance sorting
  lng: Float
  radiusMetres: Int        # ignored without coordinates
  includeClosed: Boolean   # default false
  limit: Int               # default 20, hard cap 50
}
```

### Mutations

```graphql
submitVenue(data: submitVenueInput!): VenueSubmissionResult!
reportVenueProblem(data: reportVenueProblemInput!): Confirmation
adminReviewVenue(data: adminReviewVenueInput!): Confirmation        # admin only
adminResolveVenueReport(data: adminResolveVenueReportInput!): Confirmation  # admin only
```

```graphql
input submitVenueInput {
  name: String!
  lat: Float!
  lng: Float!
  address: String
  locality: String
  city: String
  googlePlaceId: String    # present on the Places path, absent on the pin-drop path
  formats: [String!]
  surface: String
  floodlights: Boolean
  confirmNotDuplicate: Boolean   # the user answered "no, different place"
}

type VenueSubmissionResult {
  status: Boolean!
  message: String!
  venue: Venue                 # set when created, or the existing venue on a place_id hit
  outcome: String!             # CREATED | ALREADY_EXISTS | POSSIBLE_DUPLICATE
                               #   | REJECTED | INVALID | OUT_OF_AREA | RATE_LIMITED
  possibleDuplicates: [Venue!] # populated on POSSIBLE_DUPLICATE
}
```

Coordinates are **required** on submission, for both paths. A Places result always has
them and a pin drop is coordinates by definition, so there is no path that legitimately
creates a venue without a location — and a venue with no coordinates is the problem this
whole round exists to fix.

The result is a payload rather than a thrown error because `POSSIBLE_DUPLICATE` is a
conversation, not a failure: the client shows "Is this the same place?" with
`possibleDuplicates`, and the user either picks one or resubmits with
`confirmNotDuplicate: true`.

### Submission flow

In one transaction, via `withTransaction`:

1. **Authenticate.** `playerId` from the JWT, never from input — the mistake
   `getPlayerMatches` makes and that `docs/BACKLOG.md` records.
2. **Supported area.** Reject outside `SUPPORTED_AREA`. Rejected *before* the rate-limit
   count, so a user fat-fingering a pin in the ocean does not burn their daily quota.
3. **Rate limit.** `count(*)` from `play.venues` where `created_by_user_id = $me` and
   `created_at > now() - interval '1 day'`; reject at `SUBMISSIONS_PER_USER_PER_DAY`.
   A rolling 24-hour window, not a calendar day. Counts submissions, **including rejected
   ones**, so rejection is not a free retry.
4. **`google_place_id` collision.** If supplied and already present, resolve the match by
   status before answering:
   - `VERIFIED` / `UNVERIFIED` / `CLOSED` → `ALREADY_EXISTS` with that venue, not an
     error. The user wanted that venue; now they have it. (Closed included: the venue
     exists, and the client decides whether to let them pick it.)
   - `MERGED` → follow `merged_into_venue_id` one hop and return `ALREADY_EXISTS` with
     the **surviving** venue. Because merge *moves* the place_id, this should not arise
     through the API; it is here for rows merged by hand before that rule existed.
   - `REJECTED` → return `outcome: REJECTED`, **not** `ALREADY_EXISTS`. A rejected venue
     is one we decided is not a real venue; handing it back as usable would undo the
     rejection. **Builder's note: this is this design's call, not the user's.**
5. **Proximity.** `ST_DWithin(geog, point, 50)`. Any hit, and unless
   `confirmNotDuplicate` is set, return `POSSIBLE_DUPLICATE` with the neighbours.
   Applies to the Places path too: a place_id can be new while the location is not.
   Deliberately a warning and not a rejection — two turfs in one sports complex are
   genuinely 30 m apart, which the verification above measured as a real case.
6. **Insert** with `status = 'UNVERIFIED'`, `source = 'USER_SUBMITTED'`,
   `created_by_user_id = $me`. Immediately usable, per the brief.
7. Still catch `23505` on the unique index, in case of a race between steps 4 and 6, and
   return `ALREADY_EXISTS`.

### Admin review

```graphql
input adminReviewVenueInput {
  venueId: ID!
  action: String!          # VERIFY | REJECT | CLOSE | MERGE | EDIT
  mergeIntoVenueId: Int    # required for MERGE
  note: String
  # optional field edits, applied on VERIFY and EDIT
  name: String
  lat: Float
  lng: Float
  address: String
  locality: String
  city: String
  formats: [String!]
  surface: String
  floodlights: Boolean
}
```

Every action checks `isAppAdminFromDb(playerId)` first, exactly as
`adminReviewClubResolver` does.

**Admin edits are not bounded by `SUPPORTED_AREA`**, unlike submissions. The bounding box
is generous and was chosen by eye, so a real venue can fall just outside it — and the
admin is precisely the person who exists to fix that. Bounding admin edits too would make
the first such venue unfixable through the API. The box therefore hard-guards only the
two untrusted paths, submission and the backfill script.
**Builder's note: this is this design's call, not the user's.**

- **VERIFY** — `status = 'VERIFIED'`, `last_verified_at = now()`, applying any edits in
  the same statement.
- **EDIT** — field changes with no status transition.
- **REJECT** — `status = 'REJECTED'`. Hidden everywhere except old matches.
- **CLOSE** — `status = 'CLOSED'`. Out of the picker, still searchable, still resolves.
- **MERGE** — in one transaction:
  1. Reject if `mergeIntoVenueId` equals `venueId`, or if the target is itself `MERGED`
     or `REJECTED`. **No chains**: merging into an already-merged venue is refused, so
     the redirect is always one hop.
  2. `UPDATE play.matches SET venue_id = $target WHERE venue_id = $source`.
  3. Repoint the reports — **but not with a bare `UPDATE`.** Corrected 2026-11-23,
     after both failures below were reproduced against the live schema. Resolve the
     reports this merge answers (`venue_id = $source AND duplicate_of_venue_id = $target`,
     which would otherwise become self-referential and trip
     `venue_reports_no_self_duplicate_check`), redirect or resolve pointers at the
     disappearing venue (`duplicate_of_venue_id = $source`), resolve the source-side
     report where one user holds an `OPEN` report on **both** venues (which would
     otherwise collide on `venue_reports_one_open_per_user_venue`), and only then
     `UPDATE play.venue_reports SET venue_id = $target WHERE venue_id = $source`.
     The plan's Task 12 step 3 carries the exact ordering.

     The first case is not an edge case: a report saying "source is a duplicate of
     target" is precisely what `duplicate_of_venue_id` exists for and precisely what
     an admin clicking MERGE is acting on. The original bare `UPDATE` would have
     aborted the entire merge transaction with `23514` the first time it was used as
     designed.
  4. Set `merged_into_venue_id = $target`, `status = 'MERGED'` on the source.
  5. **Move** `google_place_id` from source to target if the target has none: set it on
     the target and `NULL` it on the source, in that order, in the same statement pair.
     Carry over coordinates and details the target is missing by **copying** — a merge
     should not lose the better record.

     The place_id must *move* rather than copy, because `venues_google_place_id_uniq`
     forbids two non-null rows sharing one, and the source row lives forever. Copying it
     would raise `23505` and fail every merge of a Places-sourced venue. Moving it is
     also the semantically right answer: a `place_id` identifies a real-world place, the
     surviving venue *is* that place, and step 4 of the submission flow then resolves
     future submissions for it to the target automatically. The source row keeps a
     working `mapsUrl` from its coordinates.

  **Repointing `play.matches` is the one place this design rewrites how existing games
  reference venues.** It is explicitly specified by the brief ("merge into an existing
  venue (repoint games...)"), so it is taken as authorised, but it is called out here
  because it is the single most consequential write in the whole feature. The source
  venue is never deleted, so the operation is reversible by hand from
  `merged_into_venue_id`.

A venue that has been merged keeps its row forever. That is what makes the FK and the
"never hard-delete" rule hold.

### Review queue

```graphql
type VenueReviewQueue {
  pendingVenues: [Venue!]!       # status = UNVERIFIED, oldest first
  openReports: [VenueReport!]!   # status = OPEN, oldest first
}
```

One query returning both, because they are one human workflow — "what needs my attention"
— and at this volume pagination is noise. `limit` is available and capped.

---

## What is left to the builder

- Exact migration filenames and knex timestamps.
- Whether the four migrations ship as one knex batch or several. They are ordered and
  interdependent (3 needs 2, 2 needs 1), so one batch run in order is the expectation.
- SQL formatting, error message wording, and where each new model function sits in
  `graphql/model/PlayModel.js`.
- Whether `searchVenues` reuses `mapMatchRow`-style mapping or gets a new
  `graphql/utils/venueMappers.js`. A new mapper file is the better fit — `Venue` now has
  enough mapped fields to deserve one, and it follows the `playerMappers.js` precedent.
- Whether the backfill script takes its data from an inline map or a JSON file beside it.
- The real coordinates for the four seed venues. **These are the team's to supply** — the
  design deliberately does not guess them, and no Places lookup is permitted.

## Two changes to existing behaviour, decided by the user 2026-11-20

Both came out of the builder check. Both are **user decisions**, not the builder's.

### 1. `createMatch` rejects an unpickable venue

`createMatch` gains a venue-status check: a `venueId` resolving to `CLOSED`, `REJECTED`
or `MERGED` is **rejected with an error**, not silently redirected. A stale client gets a
clear message rather than a game quietly moving venue.

Without this, the new FK only guarantees the venue *exists* — merged venues would keep
accruing matches needing repointing all over again, and closed venues would keep taking
games. `UNVERIFIED` is accepted, per the brief's "usable immediately".

The check belongs in `createMatchModel` in `graphql/model/PlayModel.js`, inside the
existing insert path, so it cannot be bypassed by a second caller. It is a `SELECT status
FROM play.venues WHERE id = $1` ahead of the `INSERT` — and must run in the **same
transaction** as the insert, or a merge landing between the two reintroduces exactly the
race it exists to prevent.

### 2. `getAllVenues` requires a JWT

All three read paths — `getAllVenues`, `searchVenues`, `getVenueById` — require a valid
token, via `verifyJwt(context.token)` as every other authenticated `play` resolver does.

`getAllVenues` is currently **unauthenticated**: its resolver is `async () => {...}` and
takes no `context` at all. The context object built in `play/index.js` already carries
`token: req.headers.authorization` on every request, so no wiring changes — only the
resolver signature and the check.

`getVenueById` is the reason it matters: it deliberately bypasses the status filter so
old matches still render, which means an open version of it lets anyone page through
rejected submissions by id.

**This is the one client-breaking change in the round, and the only one.** If the app does
not attach the `Authorization` header on the `getAllVenues` call, match creation breaks on
deploy. The context wiring suggests the header is attached globally, but the frontend is
not in this repository and this **could not be verified**. The plan must therefore:

- verify `getAllVenues` manually **with and without** the header before deploying;
- treat it as a one-line revert if the client turns out not to send it;
- and not bundle it with an unrelated urgent deploy, so it can be rolled back alone.

This supersedes the anti-goal below to the extent that `getAllVenues`'s **auth** changes.
Its name, arguments and response shape still must not.

## Risks and open items

- **The extension install is the one irreversible-ish step.** Verified to work, but
  `DROP EXTENSION` is not part of the rollback path. Accepted.
- **`pincode` is an `integer`.** Fine for Indian six-digit pincodes with no leading zero,
  wrong in principle. Left alone deliberately — changing it is unrelated to this work.
  Worth a `docs/BACKLOG.md` entry.
- **No tests.** Every migration needs a hand-run verification step recorded in the plan,
  against production, since there is no second environment.
- **The 50 m radius is a guess.** 50 m caught a 33 m pair in verification. If it proves
  noisy, it is one constant.
- **Module-level DataLoaders cache for the process lifetime** (`docs/BACKLOG.md`). A
  venue verified or merged by an admin will serve stale from warm Cloud Function
  instances until they recycle. Pre-existing, and worse now that venue data changes
  through admin action rather than never. Not fixed here; flagged.
