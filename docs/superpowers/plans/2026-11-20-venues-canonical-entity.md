# Venues as a Canonical Entity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `play.venues` from a four-row name lookup into the canonical venue entity — coordinates, status, provenance, user submissions with dedupe, and an admin review/merge/report queue.

**Architecture:** Four knex migrations add PostGIS, extend `play.venues` with plain `numeric` lat/lng plus a generated `geography` column, add the missing `matches.venue_id` foreign key, and create `play.venue_reports`. The application layer stays on the existing `pg` pool: new model functions in `graphql/model/PlayModel.js`, a new `graphql/utils/venueGeo.js` for the launch-area and dedupe constants, a new `graphql/utils/venueMappers.js` for row mapping, and a per-request activity DataLoader so dormancy never enters a process-lifetime cache.

**Tech Stack:** Node 22, Cloud Functions (Firebase), express-graphql + `@graphql-tools/schema`, graphql 14, `pg` pool for all queries, knex **for migrations only** (devDependency), Neon Postgres 15.20, PostGIS 3.3.10, `pg_trgm` 1.6.

**Spec:** [docs/superpowers/specs/2026-11-19-venues-canonical-entity-design.md](../specs/2026-11-19-venues-canonical-entity-design.md)

**Branch:** `feat/venues-canonical-entity` — exists in both the `functions` submodule (off `feat/domain-schema-split`) and the parent repo.

## Global Constraints

- **No automated tests in this project.** Verification is manual, by hand, against the live database and through GraphQL. Every task below ends with a verification step whose command and expected output are written out. **Do not scaffold test files.**
- **One database, no staging.** Every migration runs against production. Verify the pre-condition query before each `ALTER`, and never run `migrate:latest` without reading the migration's `down` first.
- **knex is migrations-only and a devDependency.** It must stay out of the Cloud Function bundle. All queries stay on the `pg` pool in `graphql/config/dbConfig.js`. Do not import knex from anything under `graphql/`.
- **Migrations bound their locks:** `SET LOCAL lock_timeout = '5s'` and `SET LOCAL statement_timeout = '60s'` as the first statements of any migration taking a table lock, following `migrations/20261110171848_split_test_schema_into_domains.js`.
- **Every migration gets a real `down`.** The one exception is migration 1, whose `down` is a documented no-op.
- **Status values are `UPPER_SNAKE_CASE`**, matching `auth.clubs.review_status` and `play.matches.match_status`. The spec's brief wrote them lowercase; the codebase wins.
- **`ST_*` calls are schema-qualified `public.ST_*`**, everywhere, including inside the generated-column expression.
- **GraphQL fields are camelCase**; database columns stay `snake_case`; the resolver layer is where they meet.
- **`playerId` always comes from the JWT**, never from input.
- **Timestamps are `timestamptz`.**
- **Existing venue ids 1–4 are permanent.** 49 matches reference them by bare integer.
- **Never hard-delete a venue.**
- Exact values: `DUPLICATE_RADIUS_METRES = 50`, `SUBMISSIONS_PER_USER_PER_DAY = 3`, `DORMANT_AFTER_DAYS = 90`, `SUPPORTED_AREA` = lat 18.90–19.20, lng 72.95–73.15, `searchVenues` limit default 20 / hard cap 50.

## Review Focus

Five things the spec implies, that no single task's happy path exercises, most likely to bite first. Each has a verification step added to the task that owns it.

1. **A venue with no coordinates in a distance-sorted search** — three of four seed venues have none until Task 5 runs, and a pin-drop venue may never get them. They must sort last with `distanceMetres: null`, not vanish. (Task 7)
2. **`getAllVenues` called without an `Authorization` header** — this is the round's only client-breaking change. It must fail with a clear auth error, and the response shape must be otherwise byte-identical to today's for a valid token. (Task 6)
3. **Merging a venue that owns a `google_place_id`** — the place_id must *move*, not copy, or the partial unique index raises `23505` and the merge fails. This is the bug the builder check caught. (Task 12)
4. **A second submission racing the first on the same `google_place_id`** — the pre-check in step 4 and the insert in step 6 are not atomic against a concurrent request, so the `23505` catch must return `ALREADY_EXISTS` rather than a raw Postgres error. (Task 9)
5. **`createMatch` posting a venue that was merged after the client loaded its picker** — the status check and the insert must share one transaction, or the race the check exists to prevent survives it. (Task 13)

---

## File Structure

**Created:**
- `migrations/<ts>_enable_postgis.js` — the extension, alone.
- `migrations/<ts>_extend_venues.js` — columns, constraints, indexes, seed-row backfill.
- `migrations/<ts>_add_matches_venue_fk.js` — the FK, with its pre-condition check.
- `migrations/<ts>_create_venue_reports.js` — the reports table.
- `graphql/utils/venueGeo.js` — launch-area and dedupe constants, `isInSupportedArea`, `buildMapsUrl`, `VENUE_FORMATS`, `VENUE_SURFACES`.
- `graphql/utils/venueMappers.js` — `mapVenueRow`.
- `graphql/dataloaders/venueActivityLoader.js` — per-request loader factory.
- `scripts/backfill-venue-coordinates.js` — one-off, re-runnable, `--dry-run`.

**Modified:**
- `graphql/model/PlayModel.js` — all new venue SQL. Already ~1000 lines; venue functions go together in one block beside the three existing ones (`getAllVenuesFromDb` :268, `getVenueByIdFromDb` :279, `getVenuesByIdsFromDb` :311) rather than scattered.
- `graphql/schema/Play.js` — `Venue` fields, new queries and mutations, new inputs and payload types.
- `graphql/resolvers/Play/Queries.js` — read resolvers and the `Venue` field resolvers.
- `graphql/resolvers/Play/Venues.js` — **new file** for the write resolvers (`submitVenue`, `reportVenueProblem`, `adminReviewVenue`, `adminResolveVenueReport`), following the `ClubJoinRequests.js` precedent of a per-feature resolver file rather than growing `Mutations.js`.
- `graphql/resolvers/Play/index.js` — wire the new resolvers.
- `play/index.js` — add the activity loader to the per-request context.
- `docs/BACKLOG.md` (parent repo) — the deferred items this work surfaces.

---

## Task 1: Migrations — PostGIS and the venue columns

**Files:**
- Create: `migrations/<ts>_enable_postgis.js`
- Create: `migrations/<ts>_extend_venues.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `play.venues` with `lat`, `lng`, `geog`, `city`, `google_place_id`, `status`, `source`, `created_by_user_id`, `created_at`, `last_verified_at`, `merged_into_venue_id`, `formats`, `surface`, `floodlights`; indexes `venues_google_place_id_uniq`, `venues_geog_gix`, `venues_name_trgm`, `venues_status_idx`, `venues_created_by_idx`.

- [ ] **Step 1: Record the pre-state**

```bash
cd functions && node -e "require('dotenv').config();const{Pool}=require('pg');const p=new Pool({user:process.env.DB_USER,host:process.env.DB_HOST,database:process.env.DB_NAME,port:5432,password:process.env.DB_PASSWORD,ssl:true});p.query('SELECT id,name,locality FROM play.venues ORDER BY id').then(r=>{console.log(r.rows);return p.end()})"
```

Expected: exactly 4 rows, ids 1–4, names `Terna College Turf`, `NR Bhagat Turf`, `Presentation Convent School Turf`, `Gymkhana Turf`. **If this is not what comes back, stop** — the plan's assumptions about seed rows no longer hold.

- [ ] **Step 2: Create `<ts>_enable_postgis.js`**

`up`: `CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;`

`down`: a no-op returning `Promise.resolve()`, with a comment saying why — `DROP EXTENSION` would fail while Task 1's generated column depends on it, and silently dropping an extension other work may depend on is not a rollback's job. Rolling it back is a deliberate manual act.

- [ ] **Step 3: Create `<ts>_extend_venues.js`**

`up`, in order: lock timeouts; `ALTER TABLE play.venues` adding the fourteen columns per the spec's table; the seven `CHECK` constraints; the five indexes; then the seed-row backfill:

```sql
UPDATE play.venues
   SET status = 'VERIFIED', source = 'SEED', city = 'Navi Mumbai',
       last_verified_at = now()
 WHERE id IN (1, 2, 3, 4);
```

Defaults are the **new-row** values (`status` `'UNVERIFIED'`, `source` `'USER_SUBMITTED'`), not the seed values — a future insert that forgets to set a status must not appear verified. The generated column is exactly:

```sql
geog geography(Point, 4326) GENERATED ALWAYS AS (
  CASE WHEN lat IS NOT NULL AND lng IS NOT NULL
    THEN public.ST_SetSRID(public.ST_MakePoint(lng::float8, lat::float8), 4326)::geography
  END
) STORED
```

Backfill by `id IN (1,2,3,4)` rather than a bare `UPDATE` with no `WHERE`, so re-running after real submissions exist cannot mark them `SEED`/`VERIFIED`.

`down`: drop the five indexes, then the constraints, then the columns. Do **not** drop the extension.

- [ ] **Step 4: Read both `down` paths once more, then run the migrations**

```bash
cd functions && npm run migrate:latest
```

Expected: both migration names listed as run, no error.

- [ ] **Step 5: Verify the shape and the seed rows**

Query `information_schema.columns` for `play.venues` and the four rows. Expected: 19 columns; all four rows `status = 'VERIFIED'`, `source = 'SEED'`, `city = 'Navi Mumbai'`, `last_verified_at` non-null, `lat`/`lng`/`geog` all null.

- [ ] **Step 6: Verify the constraints actually bite**

Each of these must be rejected:

```sql
INSERT INTO play.venues (name, status) VALUES ('x', 'BOGUS');              -- CHECK status
INSERT INTO play.venues (name, lat) VALUES ('x', 19.0);                     -- CHECK (lat IS NULL) = (lng IS NULL)
INSERT INTO play.venues (name, status, merged_into_venue_id) VALUES ('x','MERGED',NULL);  -- CHECK merge pair
UPDATE play.venues SET merged_into_venue_id = id WHERE id = 1;              -- CHECK self-merge
```

Run them inside a transaction and `ROLLBACK`. Expected: four `23514` check violations, no rows inserted.

- [ ] **Step 7: Verify the generated column and the GiST index**

In a rolled-back transaction, set `lat`/`lng` on venue 1, then confirm `geog IS NOT NULL` and that `public.ST_Distance` between two points returns metres. Expected: non-null `geog`, a plausible distance.

- [ ] **Step 8: Commit**

```bash
git add migrations/
git commit -m "feat(db): add postgis and extend venues with location, status and provenance"
```

---

## Task 2: Migration — the `matches.venue_id` foreign key

**Files:**
- Create: `migrations/<ts>_add_matches_venue_fk.js`

**Interfaces:**
- Consumes: Task 1's `play.venues`.
- Produces: constraint `matches_venue_id_fkey`, `ON DELETE RESTRICT`.

- [ ] **Step 1: Create the migration**

`up`: lock timeouts, then a **pre-condition guard before the `ALTER`** — count orphans and throw a named error if any exist, so the failure says what is wrong rather than surfacing a raw FK violation:

```sql
SELECT count(*) FROM play.matches
 WHERE venue_id IS NOT NULL
   AND venue_id NOT IN (SELECT id FROM play.venues);
```

Non-zero must `throw new Error(...)` naming the count. Then:

```sql
ALTER TABLE play.matches
  ADD CONSTRAINT matches_venue_id_fkey FOREIGN KEY (venue_id)
  REFERENCES play.venues (id) ON DELETE RESTRICT;
```

`venue_id` stays **nullable** — making it `NOT NULL` is a separate decision.

`down`: `ALTER TABLE play.matches DROP CONSTRAINT matches_venue_id_fkey;`

- [ ] **Step 2: Run it**

```bash
cd functions && npm run migrate:latest
```

Expected: runs clean. 0 orphans and 0 nulls were confirmed across all 49 matches on 2026-11-19.

- [ ] **Step 3: Verify the constraint is what stops a hard delete**

In a rolled-back transaction: `DELETE FROM play.venues WHERE id = 3;` (21 matches reference it).
Expected: error `23503`, foreign key violation. **This is the "never hard-delete" rule becoming a database guarantee** — the whole point of the task.

- [ ] **Step 4: Commit**

```bash
git add migrations/
git commit -m "feat(db): add matches.venue_id foreign key with ON DELETE RESTRICT"
```

---

## Task 3: Migration — `play.venue_reports`

**Files:**
- Create: `migrations/<ts>_create_venue_reports.js`

**Interfaces:**
- Produces: table `play.venue_reports`; index `venue_reports_one_open_per_user_venue`.

- [ ] **Step 1: Create the migration**

`up`: the `CREATE TABLE` exactly as the spec gives it, including `duplicate_of_venue_id` and its `CHECK`, then the three indexes — `venue_reports_open_idx`, `venue_reports_venue_idx`, and the partial unique:

```sql
CREATE UNIQUE INDEX venue_reports_one_open_per_user_venue
  ON play.venue_reports (venue_id, reported_by)
  WHERE status = 'OPEN' AND reported_by IS NOT NULL;
```

`down`: `DROP TABLE play.venue_reports;` (indexes go with it).

- [ ] **Step 2: Run it, then verify the one-open-per-user rule**

In a rolled-back transaction, insert two `OPEN` reports for the same `(venue_id, reported_by)`.
Expected: the second raises `23505`. Then insert one `OPEN` and one `RESOLVED` for the same pair — expected: both succeed, because the index is partial.

- [ ] **Step 3: Commit**

```bash
git add migrations/
git commit -m "feat(db): add venue_reports table for the admin review queue"
```

---

## Task 4: `venueGeo.js` — constants and the maps link

**Files:**
- Create: `graphql/utils/venueGeo.js`

**Interfaces:**
- Produces:
  - `SUPPORTED_AREA = { minLat: 18.90, maxLat: 19.20, minLng: 72.95, maxLng: 73.15 }`
  - `isInSupportedArea({ lat, lng }) -> boolean`
  - `DUPLICATE_RADIUS_METRES = 50`
  - `SUBMISSIONS_PER_USER_PER_DAY = 3`
  - `DORMANT_AFTER_DAYS = 90`
  - `VENUE_FORMATS = ['1v1','2v2','3v3','5v5','6v6','7v7','9v9','11v11']`
  - `VENUE_SURFACES = ['TURF','GRASS','CONCRETE','OTHER']`
  - `buildMapsUrl({ lat, lng, googlePlaceId }) -> string | null`

- [ ] **Step 1: Write the module**

`buildMapsUrl` returns `null` when either coordinate is null, otherwise
`https://www.google.com/maps/search/?api=1&query=<lat>,<lng>`, appending
`&query_place_id=<id>` only when `googlePlaceId` is present. URL-encode the place id.

`isInSupportedArea` returns `false` for a null or non-finite coordinate, not `true`.

Comment `SUPPORTED_AREA` as deliberately generous and chosen by eye, not surveyed, and note that multi-city turns this constant into a per-city row.

- [ ] **Step 2: Verify by hand**

```bash
cd functions && node -e "
const g=require('./graphql/utils/venueGeo');
console.log(g.buildMapsUrl({lat:19.033,lng:73.0297,googlePlaceId:'ChIJabc'}));
console.log(g.buildMapsUrl({lat:19.033,lng:73.0297}));
console.log(g.buildMapsUrl({lat:null,lng:null}));
console.log(g.isInSupportedArea({lat:19.033,lng:73.0297}), g.isInSupportedArea({lat:28.6,lng:77.2}), g.isInSupportedArea({lat:null,lng:null}));
"
```

Expected, in order: the URL with `&query_place_id=ChIJabc`; the same URL without it; `null`; then `true false false`.

- [ ] **Step 3: Commit**

```bash
git add graphql/utils/venueGeo.js
git commit -m "feat(venues): add launch-area constants and maps link builder"
```

---

## Task 5: Coordinate backfill script

**Files:**
- Create: `scripts/backfill-venue-coordinates.js`

**Interfaces:**
- Consumes: `graphql/utils/venueGeo.js` (`isInSupportedArea`, `VENUE_FORMATS`, `VENUE_SURFACES`).
- Produces: nothing other tasks import. **Blocked on the user supplying coordinates** — leave the map's values as `null` placeholders if they are not yet available, and the script must refuse to run on a null rather than writing one.

- [ ] **Step 1: Write the script**

An editable `VENUE_DATA` map keyed by venue id, each value `{ lat, lng, address, city, locality, formats, surface, floodlights }`. For each entry: refuse with a message naming the id if `lat`/`lng` are null or `isInSupportedArea` is false (**this is what catches a transposed lat/lng**), validate `formats` against `VENUE_FORMATS` and `surface` against `VENUE_SURFACES`, then one `UPDATE ... WHERE id = $n` per row. Print each row before and after. Support `--dry-run`, which does everything but the `UPDATE`.

Re-runnable: it sets absolute values, never increments. It does **not** touch `status` or `source`.

- [ ] **Step 2: Dry run**

```bash
cd functions && node scripts/backfill-venue-coordinates.js --dry-run
```

Expected: the before/after diff for every filled-in venue, "dry run, nothing written", and a refusal naming any venue still missing coordinates.

- [ ] **Step 3: Verify the out-of-area guard**

Temporarily transpose one venue's lat and lng (to ~73.0, ~19.0) and dry-run again.
Expected: refused, naming that venue and its coordinates. Restore the values.

- [ ] **Step 4: Run for real, once the user has supplied coordinates**

```bash
cd functions && node scripts/backfill-venue-coordinates.js
```

Then confirm `geog IS NOT NULL` for every backfilled row — this proves the generated column fires on update, not just insert.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-venue-coordinates.js
git commit -m "feat(venues): add re-runnable coordinate backfill script"
```

---

## Task 6: Read path — `Venue` type, mapper, JWT on all three reads

**Files:**
- Create: `graphql/utils/venueMappers.js`
- Modify: `graphql/schema/Play.js` (the `Venue` type at :78, `Query` at :219)
- Modify: `graphql/model/PlayModel.js` (`getAllVenuesFromDb` :268, `getVenueByIdFromDb` :279, `getVenuesByIdsFromDb` :311)
- Modify: `graphql/resolvers/Play/Queries.js` (`getAllVenues` :26)
- Modify: `graphql/resolvers/Play/index.js`
- Modify: `graphql/dataloaders/venueLoader.js`

**Interfaces:**
- Consumes: `buildMapsUrl` from Task 4.
- Produces:
  - `mapVenueRow(row) -> Venue | null`
  - `getAllVenuesFromDb() -> Promise<Row[]>` — now status-filtered
  - `getVenueByIdFromDb(venueId) -> Promise<Row | undefined>` — **not** status-filtered
  - `getVenuesByIdsFromDb(venueIds) -> Promise<Row[]>` — **not** status-filtered
  - `getVenueById(_, { id }, context) -> Promise<Venue | null>` resolver

- [ ] **Step 1: Add the `Venue` fields to the SDL**

Add `city`, `lat: Float`, `lng: Float`, `status: String!`, `source: String!`, `googlePlaceId`, `mapsUrl`, `formats: [String!]`, `surface`, `floodlights`, `lastVerifiedAt: Date`, `createdAt: Date!`, `mergedIntoVenueId: Int`, `distanceMetres: Float`. Keep `id`, `name`, `address`, `pincode`, `locality` **exactly as they are**. Add `getVenueById(id: ID!): Venue` to `Query`.

(`lastActivityAt` and `isDormant` arrive in Task 8, not here.)

- [ ] **Step 2: Write `mapVenueRow`**

Maps `google_place_id` → `googlePlaceId`, `merged_into_venue_id` → `mergedIntoVenueId`, `last_verified_at` → `lastVerifiedAt`, `created_at` → `createdAt`, and computes `mapsUrl` via `buildMapsUrl`. Spreads the row first, as `mapMatchRow` does, so snake_case columns stay available to field resolvers. Passes `distance_metres` through as `distanceMetres` when present. Returns `null` for a falsy row.

- [ ] **Step 3: Update the three model functions**

`getAllVenuesFromDb` selects the new columns and adds `WHERE status IN ('VERIFIED','UNVERIFIED')`. The other two select the new columns and stay unfiltered, per the spec's visibility table — an old match must resolve its venue whatever its status.

- [ ] **Step 4: Add the JWT check to all three read resolvers**

`getAllVenues` becomes `async (_obj, _args, context)` and calls `verifyJwt` on the token from `context.token`, following `getPlayerAlertsForClub`. Add `getVenueById` with the same check. Map results through `mapVenueRow`. Wire `getVenueById` into `resolvers/Play/index.js`.

Update `venueLoader.js` to map through `mapVenueRow`.

- [ ] **Step 5: Verify `getAllVenues` is byte-identical for the fields the client already asks for**

With a valid token:

```graphql
query { getAllVenues { id name address pincode locality } }
```

Expected: the same 4 venues, same ids, same values as before this task. **Diff this against the pre-change response** — this is the anti-goal the whole task is written around.

- [ ] **Step 6: Verify the new auth requirement, both ways** *(Review Focus 2)*

Run the same query **with no `Authorization` header**.
Expected: a clear auth error, no venue data. Then repeat with a valid token and confirm the full new field set, including a working `mapsUrl` for any backfilled venue and `null` for one without coordinates.

- [ ] **Step 7: Verify an old match still resolves a hidden venue**

Set venue 4 to `status = 'CLOSED'` in a transaction, query `getMatchById` for one of its 14 matches, confirm `venue` still resolves, confirm `getAllVenues` no longer lists it, then `ROLLBACK`.

- [ ] **Step 8: Commit**

```bash
git add graphql/utils/venueMappers.js graphql/schema/Play.js graphql/model/PlayModel.js graphql/resolvers/Play/Queries.js graphql/resolvers/Play/index.js graphql/dataloaders/venueLoader.js
git commit -m "feat(venues): expose location and status fields, require a JWT on venue reads"
```

---

## Task 7: `searchVenues`

**Files:**
- Modify: `graphql/schema/Play.js`, `graphql/model/PlayModel.js`, `graphql/resolvers/Play/Queries.js`, `graphql/resolvers/Play/index.js`

**Interfaces:**
- Consumes: `mapVenueRow` (Task 6), `DUPLICATE_RADIUS_METRES` not needed here.
- Produces:
  - `input venueSearchInput { query, lat, lng, radiusMetres, includeClosed, includeDormant, limit }`
  - `searchVenuesFromDb({ query, lat, lng, radiusMetres, includeClosed, limit }) -> Promise<Row[]>`
  - `searchVenues(_obj, { data }, context) -> Promise<Venue[]>`

- [ ] **Step 1: Add the input and query to the SDL**

`searchVenues(data: venueSearchInput!): [Venue!]!`. Defaults: `includeClosed` false, `includeDormant` **true**, `limit` 20 with a hard cap of 50 enforced in the resolver.

`includeDormant` is **accepted and ignored in this task** — honouring `false` needs the activity SQL, which lands in Task 8. Note that in the SDL description so it is not mistaken for working.

- [ ] **Step 2: Write `searchVenuesFromDb`**

Always excludes `REJECTED` and `MERGED`; excludes `CLOSED` unless `includeClosed`. Name matching uses the `pg_trgm` index via `name ILIKE '%' || $n || '%'` with a similarity ordering tiebreak. When `lat`/`lng` are both present, select

```sql
public.ST_Distance(geog, public.ST_MakePoint($lng, $lat)::geography) AS distance_metres
```

and order by `geog <-> public.ST_MakePoint($lng, $lat)::geography`, applying `public.ST_DWithin(...)` only when `radiusMetres` is given.

**Rows with a null `geog` must still be returned**, sorted after all located rows — use `ORDER BY (geog IS NULL), <distance>, name`. A `WHERE geog IS NOT NULL` here would be the bug in Review Focus 1.

`radiusMetres` is ignored without coordinates.

- [ ] **Step 3: Write the resolver**

JWT check, cap `limit` at 50, require `lat` and `lng` together (reject one without the other), map through `mapVenueRow`.

- [ ] **Step 4: Verify name search**

```graphql
query { searchVenues(data: { query: "turf" }) { id name distanceMetres } }
```

Expected: the matching venues, `distanceMetres: null` on every one, since no coordinates were supplied.

- [ ] **Step 5: Verify distance sorting — and that uncoordinated venues survive it** *(Review Focus 1)*

```graphql
query { searchVenues(data: { lat: 19.033, lng: 73.0297 }) { id name distanceMetres } }
```

Expected: backfilled venues first in ascending `distanceMetres`, then **every** venue without coordinates, each with `distanceMetres: null`. The row count must equal the unfiltered count. Run this before Task 5's real backfill as well as after — before it, nearly every venue is uncoordinated, which is the case most likely to be got wrong.

- [ ] **Step 6: Verify the radius cut and the index**

Repeat with `radiusMetres: 500`, then run the same SQL under `EXPLAIN`.
Expected: only venues inside 500 m plus the null-geog rows; the plan shows `venues_geog_gix` used (or a seq scan with a note that at 4 rows the planner will reasonably prefer one — confirm the index is at least *considered* by re-running with `SET enable_seqscan = off`).

- [ ] **Step 7: Commit**

```bash
git add graphql/schema/Play.js graphql/model/PlayModel.js graphql/resolvers/Play/Queries.js graphql/resolvers/Play/index.js
git commit -m "feat(venues): add searchVenues with trigram name match and distance sorting"
```

---

## Task 8: Activity — `lastActivityAt` and `isDormant`

**Files:**
- Create: `graphql/dataloaders/venueActivityLoader.js`
- Modify: `graphql/model/PlayModel.js`, `graphql/schema/Play.js`, `graphql/resolvers/Play/Queries.js`, `play/index.js`

**Interfaces:**
- Consumes: `DORMANT_AFTER_DAYS` (Task 4).
- Produces:
  - `getVenueActivityByIdsFromDb(venueIds) -> Promise<{ venue_id, last_activity_at }[]>`
  - `createVenueActivityLoader() -> DataLoader<number, Date | null>`
  - `context.venueActivityLoader`
  - `Venue.lastActivityAt`, `Venue.isDormant` field resolvers

- [ ] **Step 1: Write `getVenueActivityByIdsFromDb`**

```sql
SELECT venue_id, max(match_start_time) AS last_activity_at
  FROM play.matches
 WHERE venue_id = ANY($1::int[])
   AND is_deleted IS NOT TRUE
   AND match_status IS DISTINCT FROM 'MATCH_INVITATION_DECLINED'
   AND match_start_time <= now()
 GROUP BY venue_id
```

All three predicates are load-bearing: a soft-deleted match is not activity, a declined invitation never happened, and a future kickoff is not *past* activity. Without the `now()` cap, `lastActivityAt` can be a future date.

- [ ] **Step 2: Write the loader factory**

`createVenueActivityLoader` — a `DataLoader` built **per request**, following `createMatchLoader` in `graphql/dataloaders/matchLoader.js`, with a comment saying why: dormancy changes with the clock, so a module-level cache would freeze it at instance start. Unmatched ids resolve to `null`, not an error.

- [ ] **Step 3: Add it to the context**

In `play/index.js`, add `venueActivityLoader: createVenueActivityLoader()` beside `matchLoader`.

- [ ] **Step 4: Add the SDL fields and the field resolvers**

`lastActivityAt: Date` and `isDormant: Boolean!` on `Venue`. A `Venue` resolver object in `Queries.js` (exported and wired in `index.js` alongside `Match`) resolves both from `context.venueActivityLoader`. `isDormant` is `true` when there is no activity at all or it is older than `DORMANT_AFTER_DAYS` — non-null because the loader can always answer.

**Do not add these columns to any of the three `SELECT` lists from Task 6.** That is what keeps `getAllVenues` untouched and dormancy out of the module-level `venueLoader` cache.

- [ ] **Step 5: Verify against the known data**

```graphql
query { getAllVenues { id name lastActivityAt isDormant } }
```

Expected, given match history as of 2026-11-19: venue 3 `2026-10-31` not dormant; venue 1 `2026-10-12` not dormant; venue 2 `2026-09-06` **dormant**; venue 4 `2025-11-30` **dormant**. Confirm all four are still **present** — the filter is off by default, by design.

- [ ] **Step 6: Verify the predicate excludes what it should**

In a rolled-back transaction, insert a match at venue 4 with `match_start_time` a year in the future, and another with `is_deleted = true` and a recent start. Re-query.
Expected: venue 4's `lastActivityAt` is **unchanged** by both. Then insert a recent match with `match_status = 'MATCH_INVITATION_DECLINED'` — also no change. `ROLLBACK`.

- [ ] **Step 7: Make `searchVenues`' `includeDormant` real**

Task 7 accepts the flag and ignores it. Now honour it: when `includeDormant` is `false`, `searchVenuesFromDb` joins the same activity aggregate as a subquery and excludes venues whose `last_activity_at` is null or older than `DORMANT_AFTER_DAYS`. The ordering gains a dormant-last term in all cases, per the spec — dormancy affects sort order by default and membership only when asked.

Verify: `searchVenues(data: { includeDormant: false })`.
Expected, given the 2026-11-19 history: venues 2 and 4 absent, 1 and 3 present. Then with the default (omit the flag): all four present, with 2 and 4 ordered last.

- [ ] **Step 8: Commit**

```bash
git add graphql/dataloaders/venueActivityLoader.js graphql/model/PlayModel.js graphql/schema/Play.js graphql/resolvers/Play/Queries.js play/index.js
git commit -m "feat(venues): resolve venue activity and dormancy per request"
```

---

## Task 9: `submitVenue`

**Files:**
- Create: `graphql/resolvers/Play/Venues.js`
- Modify: `graphql/schema/Play.js`, `graphql/model/PlayModel.js`, `graphql/resolvers/Play/index.js`

**Interfaces:**
- Consumes: `venueGeo.js` constants, `mapVenueRow`, `withTransaction` from `graphql/config/dbTransaction.js`.
- Produces:
  - `input submitVenueInput`, `type VenueSubmissionResult`
  - `findVenueByPlaceIdFromDb(client, placeId) -> Promise<Row | undefined>`
  - `findVenuesNearFromDb(client, { lat, lng, radiusMetres }) -> Promise<Row[]>`
  - `countRecentSubmissionsFromDb(client, playerId) -> Promise<number>`
  - `insertVenueFromDb(client, { ...fields, createdByUserId }) -> Promise<Row>`
  - `submitVenue(_obj, { data }, context) -> Promise<VenueSubmissionResult>`

- [ ] **Step 1: Add the SDL**

`submitVenueInput` and `VenueSubmissionResult` exactly as the spec gives them, with `outcome` documented as one of `CREATED | ALREADY_EXISTS | POSSIBLE_DUPLICATE | REJECTED | INVALID | OUT_OF_AREA | RATE_LIMITED`. `lat` and `lng` are `Float!` — required on both the Places and pin-drop paths.

- [ ] **Step 2: Write the four model functions**

Each takes a `client` so they run inside the caller's transaction. `findVenuesNearFromDb` uses `public.ST_DWithin(geog, public.ST_MakePoint($lng,$lat)::geography, $radius)` and excludes `REJECTED` and `MERGED`. `countRecentSubmissionsFromDb` counts `created_by_user_id = $1 AND created_at > now() - interval '1 day'` — a rolling window, counting rejected submissions too, so rejection is not a free retry.

- [ ] **Step 3: Write the resolver, in the spec's order**

Inside one `withTransaction`: JWT → `playerId`; validate `formats`/`surface` against `VENUE_FORMATS`/`VENUE_SURFACES` (`INVALID`); `isInSupportedArea` (`OUT_OF_AREA`) — **before** the rate-limit count, so a mis-dropped pin does not burn the user's quota; rate limit (`RATE_LIMITED`); place_id lookup, branching on the found row's status per the spec (`VERIFIED`/`UNVERIFIED`/`CLOSED` → `ALREADY_EXISTS`; `MERGED` → follow `merged_into_venue_id` one hop; `REJECTED` → `outcome: REJECTED`); proximity check within `DUPLICATE_RADIUS_METRES` returning `POSSIBLE_DUPLICATE` with neighbours unless `confirmNotDuplicate`; then insert with `status = 'UNVERIFIED'`, `source = 'USER_SUBMITTED'`, `created_by_user_id = playerId`.

Wrap the insert in a `23505` catch returning `ALREADY_EXISTS`.

- [ ] **Step 4: Verify the happy path**

Submit a new venue inside the area with no `googlePlaceId`.
Expected: `outcome: CREATED`, `status: "UNVERIFIED"`, `source: "USER_SUBMITTED"`, a non-null `mapsUrl`, and the venue appearing in `getAllVenues` immediately — "usable immediately" is the brief's requirement.

- [ ] **Step 5: Verify each rejection path**

One submission each: outside the area (`OUT_OF_AREA`); with `formats: ["8v8"]` (`INVALID`, naming `8v8`); a duplicate `googlePlaceId` (`ALREADY_EXISTS`, returning the existing venue); within 50 m of an existing venue (`POSSIBLE_DUPLICATE`, with `possibleDuplicates` populated); the same again with `confirmNotDuplicate: true` (`CREATED`); and a fourth submission in one day (`RATE_LIMITED`).

- [ ] **Step 6: Verify the race catch** *(Review Focus 4)*

The pre-check and insert are not atomic. Simulate the race directly: inside a transaction, insert a venue with a given `google_place_id`, then from a **second connection** call `submitVenue` with the same place_id, committing the first mid-flight.
Expected: `ALREADY_EXISTS`, **not** a raw `23505` or an unhandled error reaching the client. If a true concurrent run is awkward, verify equivalently by calling `insertVenueFromDb` twice with the same place_id in one transaction and confirming the catch converts the error.

- [ ] **Step 7: Clean up and commit**

Delete the test venues created above with a direct `DELETE` (they have no matches, so the FK permits it; this is the one legitimate hard delete, and only because they are test rows).

```bash
git add graphql/resolvers/Play/Venues.js graphql/schema/Play.js graphql/model/PlayModel.js graphql/resolvers/Play/index.js
git commit -m "feat(venues): add submitVenue with dedupe, area and rate limits"
```

---

## Task 10: `reportVenueProblem`

**Files:**
- Modify: `graphql/resolvers/Play/Venues.js`, `graphql/schema/Play.js`, `graphql/model/PlayModel.js`, `graphql/resolvers/Play/index.js`

**Interfaces:**
- Produces:
  - `input reportVenueProblemInput { venueId: ID!, reason: String!, note: String, duplicateOfVenueId: Int }`
  - `insertVenueReportFromDb({ venueId, reportedBy, reason, note, duplicateOfVenueId }) -> Promise<Row>`
  - `findOpenReportFromDb(venueId, playerId) -> Promise<Row | undefined>`
  - `reportVenueProblem(_obj, { data }, context) -> Promise<Confirmation>`

- [ ] **Step 1: Add the SDL and model functions**

`reason` validated against `['CLOSED','WRONG_DETAILS','NEW_INFO','DUPLICATE','OTHER']`. Reuse the existing `Confirmation` type.

- [ ] **Step 2: Write the resolver**

JWT check. Reject an unknown `reason`. Require `duplicateOfVenueId` when `reason` is `DUPLICATE`, and reject it equalling `venueId`. On the `23505` from `venue_reports_one_open_per_user_venue`, return a success-shaped `Confirmation` noting the report already exists — re-reporting is not an error.

- [ ] **Step 3: Verify**

Report a venue as `CLOSED`; expected success and one `OPEN` row. Report the same venue again as the same user; expected the "already reported" response and still exactly one row. Report with `reason: DUPLICATE` and no `duplicateOfVenueId`; expected rejection.

- [ ] **Step 4: Commit**

```bash
git add graphql/resolvers/Play/Venues.js graphql/schema/Play.js graphql/model/PlayModel.js graphql/resolvers/Play/index.js
git commit -m "feat(venues): add reportVenueProblem"
```

---

## Task 11: Admin review queue

**Files:**
- Modify: `graphql/schema/Play.js`, `graphql/model/PlayModel.js`, `graphql/resolvers/Play/Queries.js`, `graphql/resolvers/Play/index.js`

**Interfaces:**
- Consumes: `isAppAdminFromDb` from `graphql/model/AuthModel.js`.
- Produces:
  - `type VenueReport`, `type VenueReviewQueue`, `input venueReviewQueueInput { limit: Int }`
  - `getPendingVenuesFromDb(limit) -> Promise<Row[]>`
  - `getOpenVenueReportsFromDb(limit) -> Promise<Row[]>`
  - `getVenueReviewQueue(_obj, { data }, context) -> Promise<VenueReviewQueue>`

- [ ] **Step 1: Add the SDL**

`VenueReport` carries `id`, `venue: Venue!`, `reason: String!`, `note`, `duplicateOfVenue: Venue`, `status: String!`, `reportedBy: Int`, `createdAt: Date!`. The queue is admin-only, so exposing `reportedBy` is fine. `limit` defaults to 50, hard cap 100.

- [ ] **Step 2: Write the model functions and resolver**

`pendingVenues` is `status = 'UNVERIFIED'` ordered `created_at ASC` (oldest first). `openReports` is `status = 'OPEN'`, also oldest first. The resolver calls `isAppAdminFromDb(playerId)` after `verifyJwt` and throws if false, exactly as `adminReviewClubResolver` does. `VenueReport.venue` and `.duplicateOfVenue` resolve through `venueLoader`, which is unfiltered — a report about a closed venue must still show it.

- [ ] **Step 3: Verify both authorisation outcomes**

Query as a non-admin player: expected an authorisation error and no data. Query as an `is_app_admin` player: expected the pending venue from Task 9's leftovers (if any) and the open report from Task 10.

- [ ] **Step 4: Commit**

```bash
git add graphql/schema/Play.js graphql/model/PlayModel.js graphql/resolvers/Play/Queries.js graphql/resolvers/Play/index.js
git commit -m "feat(venues): add admin venue review queue"
```

---

## Task 12: `adminReviewVenue` and the merge flow

**Files:**
- Modify: `graphql/resolvers/Play/Venues.js`, `graphql/schema/Play.js`, `graphql/model/PlayModel.js`, `graphql/resolvers/Play/index.js`

**Interfaces:**
- Consumes: `withTransaction`, `isAppAdminFromDb`, `venueGeo.js` validators.
- Produces:
  - `input adminReviewVenueInput`, `input adminResolveVenueReportInput`
  - `updateVenueFromDb(client, venueId, fields) -> Promise<Row>`
  - `mergeVenuesFromDb(client, sourceId, targetId) -> Promise<{ matchesRepointed, reportsRepointed }>`
  - `adminReviewVenue(_obj, { data }, context) -> Promise<Confirmation>`
  - `adminResolveVenueReport(_obj, { data }, context) -> Promise<Confirmation>`

- [ ] **Step 1: Add the SDL**

`action` is one of `VERIFY | EDIT | REJECT | CLOSE | MERGE`, plus the optional field edits and `mergeIntoVenueId`.

- [ ] **Step 2: Implement `VERIFY`, `EDIT`, `REJECT`, `CLOSE`**

`VERIFY` sets `status = 'VERIFIED'`, `last_verified_at = now()` and applies any field edits in the same statement — the spec's reason for folding edits into `VERIFY` is that the admin is the one supplying corrected coordinates. `EDIT` applies edits with no status change. `REJECT` and `CLOSE` set status only.

**Admin edits are deliberately not bounded by `SUPPORTED_AREA`** — the admin is the escape hatch for a real venue just outside a box chosen by eye. Formats and surfaces *are* still validated, by throwing.

- [ ] **Step 3: Implement `MERGE`**

In one transaction, in this order:
1. Reject `mergeIntoVenueId === venueId`; reject a target whose status is `MERGED` or `REJECTED` — **no chains**, so the redirect is always one hop.
2. `UPDATE play.matches SET venue_id = $target WHERE venue_id = $source`.
3. `UPDATE play.venue_reports SET venue_id = $target WHERE venue_id = $source`.
4. **Move** `google_place_id` to the target if the target has none: set it on the target, `NULL` it on the source. Copy coordinates and details the target lacks.
5. Set `merged_into_venue_id = $target`, `status = 'MERGED'` on the source.

Step 4 must *move* and not copy: the source row lives forever and `venues_google_place_id_uniq` forbids two non-null rows sharing a place_id.

- [ ] **Step 4: Implement `adminResolveVenueReport`**

Sets `status` to `RESOLVED` or `DISMISSED`, with `resolution_note`, `resolved_by` from the JWT, `resolved_at = now()`.

- [ ] **Step 5: Verify the straightforward actions**

On a throwaway `UNVERIFIED` venue: `VERIFY` with corrected `lat`/`lng` — expected `VERIFIED`, `last_verified_at` set, new coordinates, `geog` regenerated. Then `CLOSE` — expected gone from `getAllVenues`, still returned by `getVenueById`. Then `REJECT`.

- [ ] **Step 6: Verify the merge, place_id and all** *(Review Focus 3)*

Create two throwaway venues, give the **source** a `google_place_id` and the target none, put a match on the source (or use a transaction on venue 2's real matches and roll back). `MERGE` source into target.

Expected: every match repointed to the target; target now holds the `google_place_id`; **source's `google_place_id` is `NULL`**; source `status = 'MERGED'` with `merged_into_venue_id` set; source row still present; no `23505`. Then confirm `submitVenue` with that place_id now returns the **target**. Then attempt to merge the target into the already-merged source — expected rejection, no chain.

- [ ] **Step 7: Verify report resolution closes the queue item**

`adminResolveVenueReport` on Task 10's open report, with `status: RESOLVED` and a note.
Expected: the row's `status`, `resolution_note`, `resolved_by` and `resolved_at` all set; the report gone from `getVenueReviewQueue.openReports`; and a fresh `reportVenueProblem` from the same user on the same venue now **succeeding**, because the partial unique index only covers `OPEN` rows.

- [ ] **Step 8: Verify non-admins are refused**

Call `adminReviewVenue` and `adminResolveVenueReport` as a non-admin. Expected: authorisation error from both, and the venue and report unchanged.

- [ ] **Step 9: Commit**

```bash
git add graphql/resolvers/Play/Venues.js graphql/schema/Play.js graphql/model/PlayModel.js graphql/resolvers/Play/index.js
git commit -m "feat(venues): add admin review, merge and report resolution"
```

---

## Task 13: `createMatch` rejects an unpickable venue

**Files:**
- Modify: `graphql/model/PlayModel.js` (`createMatchModel` :92-140)

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exports — a guard inside the existing insert path.

- [ ] **Step 1: Add the guard**

Inside `createMatchModel`, in the **same transaction** as the `INSERT`, `SELECT status FROM play.venues WHERE id = $1` and throw a clear error when the status is `CLOSED`, `REJECTED` or `MERGED`, or when no row is found. `UNVERIFIED` is accepted — the brief requires submissions be usable immediately.

Sharing the transaction is the point: a merge landing between a separate check and the insert would reintroduce exactly the race the guard exists to prevent *(Review Focus 5)*. Reject rather than silently following `merged_into_venue_id`, so a stale client gets a clear error instead of a game quietly changing venue.

- [ ] **Step 2: Verify a normal match still creates**

`createMatch` against a `VERIFIED` venue, then against an `UNVERIFIED` one.
Expected: both succeed.

- [ ] **Step 3: Verify each unpickable status is refused**

In a rolled-back transaction, set a venue to `CLOSED`, then `MERGED`, then `REJECTED`, attempting `createMatch` against it each time.
Expected: three clear errors, and **no match row written** in any case. Confirm the match count is unchanged after `ROLLBACK`.

- [ ] **Step 4: Commit**

```bash
git add graphql/model/PlayModel.js
git commit -m "feat(matches): reject closed, merged and rejected venues on match creation"
```

---

## Task 14: Documentation and deferred items

**Files:**
- Modify: `docs/BACKLOG.md` (**parent repo**, not the submodule)

- [ ] **Step 1: Add the items this work surfaced**

- `play.venues.pincode` is an `integer` — fine for Indian six-digit pincodes, wrong in principle. Deliberately untouched.
- The module-level `venueLoader` caches for the process lifetime, and venue data now changes through admin action rather than never, so a verified or merged venue serves stale from warm instances. Pre-existing item, newly sharper.
- Dormancy filtering is built but off by default; revisit the 90-day cutoff when there are enough venues for it to be a kindness. Record that at four venues it would have hidden two, including one with 14 matches.
- `VENUE_FORMATS` exists in `venueGeo.js` and `play.matches.format` is still unconstrained; converging them is a follow-up.
- Whether `play.matches.venue_id` should become `NOT NULL` (0 of 49 are null today).
- Deferred by the brief: booking integration, the owner-claim flow, a venue edit-suggestions table, multi-city tooling, and admin notification of new submissions (with the reason it was dropped).

- [ ] **Step 2: Commit, in the parent repo**

```bash
cd .. && git add docs/BACKLOG.md
git commit -m "docs: record deferred items from the venues canonical entity work"
```

- [ ] **Step 3: Bump the submodule pointer**

```bash
cd .. && git add functions && git commit -m "chore: bump functions submodule to venues canonical entity"
```

---

## Deployment note

The migrations run by hand before deploy: `cd functions && npm run migrate:latest`, then `npm run deploy`. Migrations 1–4 are ordered and interdependent (3 needs 1 and 2; 2 needs 1), so they run as one batch in order.

**Before deploying Task 6**, confirm the client sends an `Authorization` header on its `getAllVenues` call. It is the round's only client-breaking change. Do not bundle this deploy with anything urgent, so it can be rolled back alone.
