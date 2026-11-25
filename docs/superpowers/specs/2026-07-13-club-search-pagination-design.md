# Club Search & Pagination for `getClubsList` — Design

**Date:** 2026-07-13
**Branch:** `searchClubs` (functions submodule)
**Status:** Approved

## Purpose

Let users find clubs by name or locality (description as a fallback) and page through
results. Replaces the current unfiltered, unpaginated `getClubsList` query, which
returns every row in `test.clubs` including pending-review and banned clubs.

## Decisions

- **Search technique:** simple `ILIKE` substring matching across `name`, `locality`,
  `description` (Approach A). No full-text search, no fuzzy matching — pre-launch scale
  (thousands of rows at most) doesn't justify it. A pg_trgm GIN index makes the
  `ILIKE '%…%'` scans indexable and is the same index a future fuzzy-similarity upgrade
  would use, so upgrading later is a query change only.
- **UX model:** submit-a-query search (not type-ahead). Substring matching means
  "chester" finds "Manchester"; typos do not match.
- **Result scope:** only `review_status = 'APPROVED'` and not banned. `access`
  (PUBLIC/PRIVATE) is **not** filtered — nothing in the codebase enforces access
  semantics yet, so PRIVATE clubs remain searchable.
- **Pagination:** limit/offset with a total count, via `COUNT(*) OVER()` in the same
  query (window function — counted after WHERE, before LIMIT). One round-trip, no
  duplicated WHERE clause. Acceptable cost at this scale.
- **Empty search returns all clubs**, paginated, alphabetical by name.

## GraphQL API

In `graphql/schema/Play.js`:

```graphql
input clubsListInput {
  search: String      # optional; empty/absent = return all
  limit: Int          # default 20, clamped to 1–50
  offset: Int         # default 0, clamped to >= 0
}

type ClubsPage {
  clubs: [Club]!
  total: Int!         # total matching rows (not just this page)
  hasMore: Boolean!   # offset + clubs.length < total
}

getClubsList(data: clubsListInput): ClubsPage
```

**Breaking change (accepted, pre-launch):** return type changes from `[Club]` to
`ClubsPage`. Calling with no `data` argument still works and returns the first page of
all approved clubs.

## Resolver (`graphql/resolvers/Play/Queries.js`)

`getClubsList(_, { data })`:

1. `search`: trim; `null`/`undefined`/whitespace-only → `''`.
2. `limit`: default 20; clamp to `[1, 50]`.
3. `offset`: default 0; clamp to `>= 0`.
4. Call `getClubsListFromDb({ search, limit, offset })`.
5. Build `{ clubs, total, hasMore }` where `total` comes from the first row's
   `total_count` (0 if no rows) and `hasMore = offset + clubs.length < total`.
6. Errors wrapped as `"Failed to fetch clubs list: " + error.message`, matching the
   existing style.

Bad input never throws: it is normalized/clamped instead.

## Model (`graphql/model/PlayModel.js`)

`getClubsListFromDb({ search, limit, offset })` — single parameterized query:

```sql
SELECT *, COUNT(*) OVER() AS total_count
FROM test.clubs
WHERE review_status = 'APPROVED'
  AND is_banned IS NOT TRUE
  AND ($1 = '' OR name ILIKE $2 OR locality ILIKE $2 OR description ILIKE $2)
ORDER BY
  CASE WHEN $1 <> '' AND name ILIKE $2 THEN 0
       WHEN $1 <> '' AND locality ILIKE $2 THEN 1
       ELSE 2 END,
  name ASC
LIMIT $3 OFFSET $4
```

- `$1` = trimmed search string; `$2` = `'%' + escapeLike(search) + '%'`.
- `escapeLike` escapes `\`, `%`, `_` in user input so LIKE wildcards can't be injected
  into the pattern (parameterization already prevents SQL injection; this prevents
  pattern injection).
- Ranking: name matches first, then locality matches, then description-only matches;
  alphabetical by name within each tier. With empty search everything falls into the
  last tier → plain alphabetical listing.
- `total_count` is stripped from the club rows before returning (or simply ignored by
  the GraphQL layer since `Club` has no such field).

## Index (manual DDL — no migration system in this repo)

Run once against the database:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_clubs_name_trgm ON test.clubs USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clubs_locality_trgm ON test.clubs USING gin (locality gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clubs_description_trgm ON test.clubs USING gin (description gin_trgm_ops);
```

Optional at current row counts; future-proofs `ILIKE '%…%'` and enables a later
pg_trgm fuzzy-search upgrade without reindexing.

## Error handling

- Empty/whitespace search → list all (not an error).
- Out-of-range `limit`/`offset` → clamped (not an error).
- Database failures → existing `"Failed to fetch clubs list: …"` error surface.

## Verification

No test harness exists in the repo. Verify by exercising the query against the running
function:

- empty search → paginated alphabetical list of approved, non-banned clubs only
- search hitting `name`, hitting `locality` only, hitting `description` only (ranking order)
- search containing `%`, `_`, `\` → treated literally, no wildcard injection
- pagination: `limit`/`offset` boundaries, `total` stable across pages, `hasMore`
  flips false on the last page
- no `data` argument at all → first page of all clubs

## Out of scope

- Fuzzy/typo-tolerant matching (future: pg_trgm `word_similarity`, same index)
- Full-text search on `description`
- `access`-based visibility filtering
- Cursor-based pagination
