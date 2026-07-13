# Club Search & Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `search` + limit/offset pagination to the `getClubsList` GraphQL query, matching clubs on `name`, `locality`, `description` via `ILIKE`, returning only approved, non-banned clubs.

**Architecture:** Firebase Cloud Function (`ballersApiPlay`) serving express-graphql. SDL lives in `graphql/schema/Play.js` (built with `buildSchema`, combined with resolvers via `makeExecutableSchema`). Resolvers in `graphql/resolvers/Play/Queries.js` call raw-SQL model functions in `graphql/model/PlayModel.js` that use a shared `pg` pool (`graphql/config/dbConfig.js`). New pure helpers (LIKE-escaping, arg normalization) go in a small utils file so they are unit-testable without a database.

**Tech Stack:** Node 20 (CommonJS), `pg` 8, `graphql` 14 + `express-graphql` + `@graphql-tools/schema`, Postgres (`test.clubs` table). Tests: Node's built-in `node:test` runner — **no new dependencies**.

**Spec:** `docs/superpowers/specs/2026-07-13-club-search-pagination-design.md` (outer repo)

## Global Constraints

- All code changes happen in the **functions repo** (`/Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions`), branch `searchClubs`. Run all commands from that directory.
- CommonJS modules (`require`/`module.exports`) — no ESM.
- No new npm dependencies. Tests use Node 20's built-in `node:test` + `node:assert`.
- Table is `test.clubs`. Result scope: `review_status = 'APPROVED' AND is_banned IS NOT TRUE`. Do **not** filter on `access`.
- Pagination defaults: `limit` 20, clamped to 1–50; `offset` default 0, clamped to ≥ 0.
- Empty/whitespace-only `search` returns all clubs (no error), ordered alphabetically by `name`.
- Error surface from the resolver: `"Failed to fetch clubs list: " + error.message`.
- The trigram index DDL is a manual, run-once step against the database (no migration system exists); it is documented, not coded.

---

### Task 1: LIKE-escape and argument-normalization helpers (with test runner setup)

**Files:**
- Create: `graphql/utils/clubSearch.js`
- Test: `test/clubSearch.test.js` (new directory `test/`)
- Modify: `package.json` (add `test` script to `scripts`)

**Interfaces:**
- Consumes: nothing (pure functions).
- Produces:
  - `escapeLike(input: string): string` — returns `input` with `\`, `%`, `_` each prefixed by `\`.
  - `normalizeClubsListArgs(data: object|null|undefined): { search: string, limit: number, offset: number }` — trims `data.search` (non-string → `''`), defaults/clamps `limit` (default 20, min 1, max 50; non-integer → default) and `offset` (default 0, min 0; non-integer → default).
  - Exported as `module.exports = { escapeLike, normalizeClubsListArgs };`

- [ ] **Step 1: Add the test script to package.json**

In `package.json`, add to the `"scripts"` object (after `"logs"`):

```json
    "logs": "firebase functions:log",
    "test": "node --test test/"
```

- [ ] **Step 2: Write the failing tests**

Create `test/clubSearch.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { escapeLike, normalizeClubsListArgs } = require("../graphql/utils/clubSearch");

test("escapeLike leaves plain text unchanged", () => {
  assert.equal(escapeLike("Manchester"), "Manchester");
});

test("escapeLike escapes percent, underscore, and backslash", () => {
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("a\\b"), "a\\\\b");
  assert.equal(escapeLike("%_\\"), "\\%\\_\\\\");
});

test("escapeLike handles empty string", () => {
  assert.equal(escapeLike(""), "");
});

test("normalizeClubsListArgs returns defaults for missing data", () => {
  assert.deepEqual(normalizeClubsListArgs(undefined), { search: "", limit: 20, offset: 0 });
  assert.deepEqual(normalizeClubsListArgs(null), { search: "", limit: 20, offset: 0 });
  assert.deepEqual(normalizeClubsListArgs({}), { search: "", limit: 20, offset: 0 });
});

test("normalizeClubsListArgs trims search and treats whitespace as empty", () => {
  assert.equal(normalizeClubsListArgs({ search: "  chester  " }).search, "chester");
  assert.equal(normalizeClubsListArgs({ search: "   " }).search, "");
  assert.equal(normalizeClubsListArgs({ search: 42 }).search, "");
});

test("normalizeClubsListArgs clamps limit to 1-50 and defaults non-integers", () => {
  assert.equal(normalizeClubsListArgs({ limit: 100 }).limit, 50);
  assert.equal(normalizeClubsListArgs({ limit: 0 }).limit, 1);
  assert.equal(normalizeClubsListArgs({ limit: -5 }).limit, 1);
  assert.equal(normalizeClubsListArgs({ limit: 30 }).limit, 30);
  assert.equal(normalizeClubsListArgs({ limit: 2.5 }).limit, 20);
  assert.equal(normalizeClubsListArgs({ limit: "10" }).limit, 20);
});

test("normalizeClubsListArgs clamps offset to >= 0 and defaults non-integers", () => {
  assert.equal(normalizeClubsListArgs({ offset: -1 }).offset, 0);
  assert.equal(normalizeClubsListArgs({ offset: 40 }).offset, 40);
  assert.equal(normalizeClubsListArgs({ offset: 1.5 }).offset, 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../graphql/utils/clubSearch'`

- [ ] **Step 4: Write the implementation**

Create `graphql/utils/clubSearch.js`:

```js
// Escapes LIKE/ILIKE pattern metacharacters so user input is matched literally.
const escapeLike = (input) => input.replace(/[\\%_]/g, (ch) => "\\" + ch);

const normalizeClubsListArgs = (data) => {
  const search =
    data && typeof data.search === "string" ? data.search.trim() : "";

  const limit =
    data && Number.isInteger(data.limit)
      ? Math.min(Math.max(data.limit, 1), 50)
      : 20;

  const offset =
    data && Number.isInteger(data.offset) ? Math.max(data.offset, 0) : 0;

  return { search, limit, offset };
};

module.exports = { escapeLike, normalizeClubsListArgs };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 7 tests pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add package.json test/clubSearch.test.js graphql/utils/clubSearch.js
git commit -m "feat: add LIKE-escape and clubs-list arg normalization helpers"
```

---

### Task 2: Search + pagination query in the model

**Files:**
- Modify: `graphql/model/PlayModel.js` (replace `getClubsListFromDb`, currently at lines 233–241; add one require at top)

**Interfaces:**
- Consumes: `escapeLike(input)` from `graphql/utils/clubSearch.js` (Task 1); shared `pool` already imported in `PlayModel.js`.
- Produces: `getClubsListFromDb({ search, limit, offset }): Promise<{ clubs: Array<clubRow>, total: number }>` — `clubs` are raw `test.clubs` rows without the `total_count` helper column; `total` is the count of ALL matching rows (not just this page). Caller passes already-normalized values (`search` trimmed string possibly `''`, `limit` 1–50, `offset` ≥ 0). Errors propagate raw (no wrapping) — the resolver wraps them.

- [ ] **Step 1: Add the helper import**

At the top of `graphql/model/PlayModel.js`, next to the existing requires (the file already requires the pool near line 1), add:

```js
const { escapeLike } = require("../utils/clubSearch");
```

- [ ] **Step 2: Replace `getClubsListFromDb`**

Replace this existing function:

```js
const getClubsListFromDb = async () => {
  try {
    const result = await pool.query("SELECT * FROM test.clubs");
    return result.rows;
  } catch (error) {
    throw new Error("Failed to fetch clubs list: " + error.message);
  }
};
```

with:

```js
const getClubsListFromDb = async ({ search, limit, offset }) => {
  const pattern = "%" + escapeLike(search) + "%";
  const query = `
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
    LIMIT $3 OFFSET $4;
  `;
  const result = await pool.query(query, [search, pattern, limit, offset]);
  const total =
    result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;
  const clubs = result.rows.map(({ total_count, ...club }) => club);
  return { clubs, total };
};
```

Notes for the implementer:
- The old version wrapped errors itself AND the resolver wrapped them again, producing a doubled message. The new version deliberately does not wrap — the resolver (Task 3) is the single place that wraps.
- `COUNT(*) OVER()` is a window function: computed after `WHERE`, before `LIMIT`, so every returned row carries the full match count. It comes back from `pg` as a string, hence `Number(...)`.
- The export list at the bottom of the file already contains `getClubsListFromDb` — no change needed there.

- [ ] **Step 3: Syntax-check the file and run existing tests**

Run: `node --check graphql/model/PlayModel.js && npm test`
Expected: no syntax error output; the 7 Task-1 tests still PASS. (Real query behavior is verified end-to-end in Task 4 — the pool is module-level in this codebase, so the model isn't unit-testable without a DB.)

- [ ] **Step 4: Commit**

```bash
git add graphql/model/PlayModel.js
git commit -m "feat: add search and pagination to getClubsListFromDb"
```

---

### Task 3: GraphQL schema + resolver wiring

**Files:**
- Modify: `graphql/schema/Play.js` (add `clubsListInput` input and `ClubsPage` type; change `getClubsList` signature at line 121)
- Modify: `graphql/resolvers/Play/Queries.js` (replace `getClubsList` at lines 44–50; add one require)

**Interfaces:**
- Consumes: `normalizeClubsListArgs(data)` from `graphql/utils/clubSearch.js` (Task 1); `getClubsListFromDb({ search, limit, offset }) → { clubs, total }` (Task 2).
- Produces: GraphQL query `getClubsList(data: clubsListInput): ClubsPage` returning `{ clubs: [Club]!, total: Int!, hasMore: Boolean! }`. **Breaking change** (accepted pre-launch): return type was `[Club]`.

- [ ] **Step 1: Add the new SDL types**

In `graphql/schema/Play.js`, directly after the `removePlayerFromMatchInput` input block (ends near line 50), add:

```graphql
  input clubsListInput {
    search: String
    limit: Int
    offset: Int
  }

  type ClubsPage {
    clubs: [Club]!
    total: Int!
    hasMore: Boolean!
  }
```

- [ ] **Step 2: Change the query signature**

In the same file's `type Query` block, change:

```graphql
    getClubsList: [Club]
```

to:

```graphql
    getClubsList(data: clubsListInput): ClubsPage
```

- [ ] **Step 3: Update the resolver**

In `graphql/resolvers/Play/Queries.js`, add to the requires at the top (after the `verifyJwt` require near line 4):

```js
const { normalizeClubsListArgs } = require("../../utils/clubSearch");
```

Then replace the existing resolver:

```js
const getClubsList = async () => {
  try {
    return await getClubsListFromDb();
  } catch (error) {
    throw new Error("Failed to fetch clubs list: " + error.message);
  }
};
```

with:

```js
const getClubsList = async (_, args) => {
  const { search, limit, offset } = normalizeClubsListArgs(args && args.data);
  try {
    const { clubs, total } = await getClubsListFromDb({ search, limit, offset });
    return { clubs, total, hasMore: offset + clubs.length < total };
  } catch (error) {
    throw new Error("Failed to fetch clubs list: " + error.message);
  }
};
```

No changes needed in `graphql/resolvers/Play/index.js` — it already imports and registers `getClubsList`.

- [ ] **Step 4: Verify the schema builds and tests still pass**

Run: `node --check graphql/schema/Play.js && node --check graphql/resolvers/Play/Queries.js && node -e "require('./graphql/schema/Play'); console.log('schema OK')" && npm test`
Expected: `schema OK` printed (buildSchema throws at require-time on invalid SDL); 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add graphql/schema/Play.js graphql/resolvers/Play/Queries.js
git commit -m "feat: expose search and pagination on getClubsList query"
```

---

### Task 4: End-to-end verification + index DDL

**Files:**
- No code changes. Manual verification against the running function and manual DDL.

**Interfaces:**
- Consumes: the deployed/emulated `ballersApiPlay` function's `/graphql` endpoint (Tasks 1–3 complete).
- Produces: verified behavior per spec; trigram indexes created on the database.

- [ ] **Step 1: Start the local function emulator**

Run (from `functions/`): `npm run serve`
Expected: Firebase emulator starts and prints a local URL for `ballersApiPlay` (e.g. `http://127.0.0.1:5001/<project>/<region>/ballersApiPlay`). Requires the `.env`/database config already used for local development. If the emulator cannot reach a database, stop and report — do not fake verification.

Set a shell variable for the steps below (substitute the printed URL):

```bash
URL="http://127.0.0.1:5001/<project>/<region>/ballersApiPlay/graphql"
```

- [ ] **Step 2: Empty search returns paginated, approved-only clubs**

```bash
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList { total hasMore clubs { id name locality review_status is_banned } } }"}'
```

Expected: JSON with `data.getClubsList.clubs` — at most 20 rows, every row `review_status: "APPROVED"` and `is_banned` null/false, names in alphabetical order; `total` equals the number of approved non-banned clubs; `hasMore` is `total > 20`.

- [ ] **Step 3: Search matching a name substring**

```bash
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { search: \"<substring of a known approved club name>\" }) { total clubs { id name locality } } }"}'
```

Expected: the known club is returned; clubs whose *name* matches rank before clubs matching only on locality/description.

- [ ] **Step 4: Search matching only locality, only description, and a no-match search**

```bash
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { search: \"<known locality>\" }) { total clubs { name locality } } }"}'
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { search: \"<word appearing only in a club description>\" }) { total clubs { name description } } }"}'
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { search: \"zzzznope\" }) { total hasMore clubs { id } } }"}'
```

Expected: first query returns clubs in that locality; second returns the club whose description contains the word (ranked after any name/locality matches); third returns `{ total: 0, hasMore: false, clubs: [] }` (no error).

- [ ] **Step 5: Wildcard characters are treated literally**

```bash
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { search: \"%\" }) { total clubs { id } } }"}'
```

Expected: `total: 0` (assuming no club actually contains a literal `%` in name/locality/description) — NOT the full club list. A full list here means wildcard escaping is broken.

- [ ] **Step 6: Pagination boundaries**

```bash
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { limit: 1, offset: 0 }) { total hasMore clubs { id name } } }"}'
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { limit: 1, offset: 1 }) { total hasMore clubs { id name } } }"}'
curl -s "$URL" -H 'Content-Type: application/json' -d '{"query":"{ getClubsList(data: { limit: 100, offset: 999999 }) { total hasMore clubs { id } } }"}'
```

Expected: first two calls return different single clubs (alphabetical neighbors) with the same `total`; `hasMore: true` while more pages remain. Third call: empty `clubs`, `hasMore: false`, and — because the page is empty — `total: 0` (known `COUNT(*) OVER()` quirk on out-of-range pages; acceptable, clients read `total` from in-range pages).

- [ ] **Step 7: Create the trigram indexes (manual, run-once, optional at current scale)**

Against the real database (psql or admin tool):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_clubs_name_trgm ON test.clubs USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clubs_locality_trgm ON test.clubs USING gin (locality gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_clubs_description_trgm ON test.clubs USING gin (description gin_trgm_ops);
```

Expected: statements succeed. If database credentials/permissions are unavailable in this session, report this step as pending for the user to run — do not skip silently.

- [ ] **Step 8: Report results**

Summarize each verification step's actual output vs expected. Any mismatch is a bug to fix before the branch is finished (use superpowers:systematic-debugging).
