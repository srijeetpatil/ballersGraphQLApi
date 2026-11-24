# Domain Schema Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all fourteen tables out of the `test` schema into four domain schemas — `auth`, `play`, `alerts`, `chat` — and delete `test`.

**Architecture:** One knex migration performs `ALTER TABLE ... SET SCHEMA` for all fourteen tables inside a single transaction; no data is copied. The 92 literal `test.` references in two model files are rewritten and committed *before* the migration runs, so the gap between migration and deploy is one `npm run deploy`. There are no users yet, so that gap is acceptable and no compatibility shims are built.

**Tech Stack:** PostgreSQL, knex (devDependency, migrations only), node-postgres `pg` pool, Firebase Cloud Functions.

**Spec:** `docs/superpowers/specs/2026-11-10-domain-schema-split-design.md`

## Global Constraints

- Branch: `feat/domain-schema-split`, cut from `origin/develop`, in the `functions` submodule. Docs changes go in the outer repo on their own branch.
- **This project has no automated tests and none are to be scaffolded.** Every task verifies with SQL queries and manual API exercise instead of a test suite. Steps are written as verify-then-act cycles, not red/green.
- Tables move with `ALTER TABLE ... SET SCHEMA`. Copying rows is forbidden.
- Never edit the three existing migrations in `functions/migrations/`.
- knex stays a devDependency. No query moves off the `pg` pool.
- No table or column is renamed. Only its schema changes.
- Every migration has a working `down`.
- The schema assignment is fixed:
  - `auth`: `players`, `clubs`, `player_club_map`, `club_join_requests`
  - `play`: `matches`, `player_match_map`, `match_goals`, `match_audit_log`, `temp_teams`, `player_temp_team_map`, `venues`, `match_ratings`, `player_match_ratings`
  - `alerts`: `alerts`
  - `chat`: (empty)
- Database connection comes from `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` in `functions/.env`, as `knexfile.js` and `graphql/config/dbConfig.js` both read it.

## Review Focus

Five failure modes the spec implies that no task's own checks would otherwise catch. Each has a check added to the task that owns it.

1. **A sequence not owned by a moved column is left behind in `test`** — ~~a standalone or shared sequence does not travel with its table.~~ **Resolved by Task 1 Finding 3: all 17 sequences are table-owned (10 serial, 7 identity) and travel with the move.** Task 5's `pg_sequences` check is retained as a cheap re-check.
2. **Moving `knex_migrations` makes knex replay every migration** — if the relocated table is not found, `migrate:latest` re-runs the baseline, the `played` backfill, the rating-table creation and the schema move. Checked in Task 5 before anything is dropped.
3. **A view, function or materialized view in `test` silently depends on a moved table** — it survives the move and breaks at `DROP SCHEMA`, or earlier and quietly. **Task 1 found none** — no views, no routines. It did find two unexpected *tables*, `login` and `notifications`, handled in Task 5 Step 5.
4. **A future migration creates a table in a domain schema with no grants** — **void, not mitigated.** `ballers_owner` owns every schema and table and is also the grantee, and an owner holds all privileges implicitly, so Task 2's GRANT and `ALTER DEFAULT PRIVILEGES` statements cannot grant anything not already in effect. They are kept because they cost nothing and become load-bearing if the app ever connects as a non-owning role — but they would **not** cover that role, which needs `ALTER DEFAULT PRIVILEGES FOR ROLE <creator> IN SCHEMA ... GRANT ... TO <app_role>`. The failure mode only exists in a world this database is not in yet.
5. **A `test.` reference in a case or form the replace missed** — the count check in Task 3 is per-table and exact, and a case-insensitive sweep catches `TEST.` or `Test.` which the original inventory would not have seen.

---

### Task 1: Audit the database before touching it

Read-only. Produces the only baseline that will exist, and a go/no-go on ownership. **If any check here fails, stop and report rather than proceeding.**

**Files:**
- Create: `docs/superpowers/plans/2026-11-10-schema-split-baseline.md` (in the outer repo — the captured output, committed as the record)

**Interfaces:**
- Produces: the baseline file, read by Task 4 and Task 5 for comparison.

- [ ] **Step 1: Confirm the fourteen tables are exactly what is in `test`**

```sql
SELECT table_name, table_type FROM information_schema.tables
WHERE table_schema = 'test' ORDER BY table_type, table_name;
```

Expected: 14 `BASE TABLE` rows matching the Global Constraints list, plus `knex_migrations` and `knex_migrations_lock`. **Any other row — a `VIEW`, or a table not on the list — is a finding: stop and report it.** This is Review Focus item 3.

- [ ] **Step 2: Capture row counts**

```sql
SELECT relname, n_live_tup FROM pg_stat_user_tables
WHERE schemaname = 'test' ORDER BY relname;
```

`n_live_tup` is an estimate. For the four tables with the most rows, also run an exact `SELECT count(*)`. Record both.

- [ ] **Step 3: Capture constraints, indexes and sequences**

```sql
SELECT conrelid::regclass AS tbl, conname, contype
FROM pg_constraint WHERE connamespace = 'test'::regnamespace ORDER BY tbl, conname;

SELECT tablename, indexname FROM pg_indexes
WHERE schemaname = 'test' ORDER BY tablename, indexname;

SELECT c.relname AS sequence, d.refobjid::regclass AS owned_by
FROM pg_class c
LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
WHERE c.relkind = 'S' AND c.relnamespace = 'test'::regnamespace
ORDER BY c.relname;
```

Record all three. A sequence with a null `owned_by` will **not** move with any table — note it explicitly for Task 2. This is Review Focus item 1.

- [ ] **Step 4: Confirm ownership and `CREATE` privilege**

```sql
SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'test';
SELECT current_user,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create;
```

Expected: `tableowner` equals the connecting `DB_USER` for all fourteen tables, and `can_create` is `true`. `ALTER TABLE ... SET SCHEMA` requires ownership and `CREATE SCHEMA` requires the database privilege. **If either fails, stop — acquiring the privilege is a prerequisite, not something to discover mid-migration.**

- [ ] **Step 5: Check for name collisions in the target schemas**

The generic form of the defect that a table-name-only check misses. Tables,
indexes and sequences share one name namespace per schema, and `SET SCHEMA`
moves all three:

```sql
SELECT tn.nspname AS target_schema, t.relname, t.relkind
FROM pg_class s
JOIN pg_class t ON t.relname = s.relname
JOIN pg_namespace tn ON tn.oid = t.relnamespace
WHERE s.relnamespace = 'test'::regnamespace
  AND tn.nspname IN ('auth','play','alerts','chat','legacy_20261110')
ORDER BY tn.nspname, t.relkind, t.relname;
```

Expected after Task 2's relocation step is written: **zero rows**. Before it,
this returns the five `auth` collisions that drove that step. Re-run it as the
last check before Task 4.

- [ ] **Step 6: Check for dependents on `test` from outside `test`**

A view, matview, function or trigger in `public` or `auth` that reads `test.*`
survives the move silently (dependencies are OID-based) and breaks at Task 5's
`DROP SCHEMA`, or at runtime with no migration error to point at. Scoping the
check to `information_schema` *within* `test` cannot establish this:

```sql
SELECT DISTINCT dn.nspname, dc.relname, dc.relkind
FROM pg_depend d
JOIN pg_rewrite r ON r.oid = d.objid
JOIN pg_class dc ON dc.oid = r.ev_class
JOIN pg_namespace dn ON dn.oid = dc.relnamespace
JOIN pg_class rc ON rc.oid = d.refobjid
WHERE rc.relnamespace = 'test'::regnamespace AND dn.nspname <> 'test';

SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosrc LIKE '%test.%';

SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE c.relnamespace = 'test'::regnamespace AND NOT t.tgisinternal;
```

Expected: no rows from any of the three.

- [ ] **Step 7: Write the baseline file and commit**

Record the output of Steps 1–4 verbatim under dated headings.

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi
git add docs/superpowers/plans/2026-11-10-schema-split-baseline.md
git commit -m "docs: capture pre-split database baseline"
```

---

### Task 2: Write the migration (do not run it)

The migration is authored and reviewed now, run in Task 4. Writing it before the code change means the window in Task 4 contains no authoring.

**Files:**
- Create: `functions/migrations/<timestamp>_split_test_schema_into_domains.js`

**Interfaces:**
- Produces: the migration file, run by Task 4.
- Consumes: the standalone-sequence list from Task 1 Step 3.

- [ ] **Step 1: Generate the migration file**

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi/functions
npm run migrate:make -- split_test_schema_into_domains
```

- [ ] **Step 2: Write `up`**

In order:

1. **Set a lock timeout, first thing:**

```sql
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
```

   The live database has `lock_timeout = 0` and
   `idle_in_transaction_session_timeout = 5min`, and the deployed functions hold
   warm pooled connections to it. `ALTER TABLE ... SET SCHEMA` takes ACCESS
   EXCLUSIVE, and a waiting ACCESS EXCLUSIVE request queues *ahead* of later
   arrivals — so without a timeout, one Cloud Function stuck mid-transaction
   stalls the whole API while this migration sits on a half-moved catalog. Fail
   fast and retry instead. `SET LOCAL` reverts on commit.

2. **Relocate the two colliding prototype tables** (Task 1 Finding 1):

```sql
CREATE SCHEMA IF NOT EXISTS legacy_20261110;
ALTER TABLE auth.players SET SCHEMA legacy_20261110;
ALTER TABLE auth.clubs   SET SCHEMA legacy_20261110;
```

   `auth` already exists and holds a prototype `players` (1 row) and `clubs`
   (2 rows). **Renaming the two tables is not enough.** `SET SCHEMA` moves a
   table *together with its indexes and owned sequences*, and tables, indexes
   and sequences share one name namespace per schema. `auth` holds **five**
   names that `test` also holds:

   | name | kind | cleared by a table rename? |
   |---|---|---|
   | `players` | table | yes |
   | `clubs` | table | yes |
   | `players_pkey` | index | **no** |
   | `clubs_pkey` | index | **no** |
   | `players_id_seq` | sequence | **no** |

   A rename-in-place leaves three collisions, and the first move aborts with
   *relation "players_pkey" already exists in schema "auth"* — a message of the
   same shape as the one the rename was meant to prevent, which mid-window reads
   as "the rename didn't take" and invites the wrong fix. One `SET SCHEMA` per
   prototype table carries all of its sub-objects out at once, invents no names,
   keeps the prototypes' original names as better documentation than a `_legacy_`
   suffix, and preserves OIDs — so `test.login`'s foreign key to `auth.players`
   follows it, which was the reason for relocating rather than dropping.

3. `CREATE SCHEMA IF NOT EXISTS` for `auth`, `play`, `alerts`, `chat`. `auth`
   already exists, so `IF NOT EXISTS` is doing real work here, not defensive
   boilerplate.
4. One `ALTER TABLE test.<t> SET SCHEMA <s>` per table for all fourteen, per the
   Global Constraints assignment.
5. Grants — **after** the moves, since `ON ALL TABLES IN SCHEMA` is a snapshot
   at execution time and granting first would be a silent no-op.

**No `ALTER SEQUENCE` step.** Task 1 Finding 3 established that all 17 sequences
in `test` are owned by a table in `test` — 10 serial (`deptype='a'`), 7 identity
(`deptype='i'`) — so every one travels with its table. There is nothing to move
by hand.

Grants, for each of the four schemas, using `DB_USER` from the environment rather than a hardcoded name:

```sql
GRANT USAGE ON SCHEMA <s> TO <role>;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA <s> TO <role>;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA <s> TO <role>;
ALTER DEFAULT PRIVILEGES IN SCHEMA <s>
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <role>;
```

The `ALTER DEFAULT PRIVILEGES` line is Review Focus item 4 — it is what stops the next migration's new table from landing without grants. Do **not** touch `knex_migrations`; that is Task 5.

- [ ] **Step 3: Write `down`**

The inverse, in reverse order: move all fourteen tables back to `test`; move the two prototype tables from `legacy_20261110` back to `auth`; then `DROP SCHEMA play, alerts, chat, legacy_20261110` — plain, not `CASCADE`, so an unexpected dependent object makes the rollback fail loudly instead of deleting something.

**`down` must not drop `auth`.** It existed before this work. Derive the drop list from the schemas `up` creates rather than hardcoding it, so adding a schema later cannot silently break the inverse.

**The grant revocation is deliberately not a complete inverse.** Table-level grants travel back to `test` with the tables, but `GRANT USAGE ON SCHEMA auth` persists because `auth` is not dropped, and the `ON ALL TABLES` grant also touched the two prototype tables. All of it is a no-op under single-role ownership; the asymmetry is documented in the migration rather than papered over.

- [ ] **Step 4: Confirm the migration runs in one transaction**

knex wraps each migration in a transaction by default. Confirm the file does **not** set `config.transaction = false`. `ALTER TABLE ... SET SCHEMA` is transactional in Postgres, so a mid-migration failure must leave all fourteen tables in `test`. This is the "no half-applied move" anti-goal.

- [ ] **Step 5: Verify the file lists exactly fourteen moves**

```bash
grep -c 'SET SCHEMA' migrations/*_split_test_schema_into_domains.js
```

Run the require-and-compare check rather than a grep — the migration drives the moves from a data map, so there are no 14 literal statements to count:

```bash
node -e '
const m = require("./migrations/20261110171848_split_test_schema_into_domains.js");
const want = {auth:["players","clubs","player_club_map","club_join_requests"],
  play:["matches","player_match_map","match_goals","match_audit_log","temp_teams","player_temp_team_map","venues","match_ratings","player_match_ratings"],
  alerts:["alerts"]};
let n=0; for (const s in want) {
  const a=[...m.MOVES[s]].sort().join(","), b=[...want[s]].sort().join(",");
  console.log(s, a===b?"MATCH":"MISMATCH "+a+" vs "+b); n+=m.MOVES[s].length; }
console.log("total",n,"auth droppable by down:",m.CREATED_SCHEMAS.includes("auth"));'
```

Expected: three MATCH lines, `total 14`, and `auth droppable by down: false`.

- [ ] **Step 6: Commit without running**

```bash
git add migrations/
git commit -m "feat(db): add migration moving test schema tables into domain schemas"
```

---

### Task 3: Rewrite the 92 references and commit (do not deploy)

**Files:**
- Modify: `functions/graphql/model/PlayModel.js` (64 references)
- Modify: `functions/graphql/model/AuthModel.js` (28 references)

**Do not modify:** `functions/graphql/utils/playerMappers.js:2`, `functions/graphql/utils/alertScopes.js:50`, `functions/graphql/resolvers/Play/Ratings.js:186`. These three match a naive `test\.` grep but are doc comments and the JS property `latest.score`. Rewriting them is a defect.

**Interfaces:**
- Produces: a committed, undeployed code change, deployed by Task 4.

- [ ] **Step 1: Record the per-table reference counts**

The expected counts, from the current branch:

| Reference | Count | New schema |
|---|---|---|
| `test.player_match_map` | 13 | `play` |
| `test.players` | 12 | `auth` |
| `test.player_club_map` | 12 | `auth` |
| `test.matches` | 12 | `play` |
| `test.clubs` | 9 | `auth` |
| `test.match_ratings` | 8 | `play` |
| `test.alerts` | 6 | `alerts` |
| `test.club_join_requests` | 5 | `auth` |
| `test.match_goals` | 4 | `play` |
| `test.venues` | 3 | `play` |
| `test.temp_teams` | 3 | `play` |
| `test.player_match_ratings` | 3 | `play` |
| `test.player_temp_team_map` | 1 | `play` |
| `test.match_audit_log` | 1 | `play` |

Total 92. Re-run the count first and reconcile any drift before editing:

```bash
grep -rhoE 'test\.[a-z_]+' graphql/model/PlayModel.js graphql/model/AuthModel.js | sort | uniq -c | sort -rn
```

- [ ] **Step 2: Replace per table, longest name first**

Replace each full reference with its new schema, one table at a time, using a word boundary at the end of the name. Longest-first ordering and the boundary both matter: `test.player_match_map` and `test.player_match_ratings` share a prefix, as do `test.matches` and `test.match_goals`. A prefix-based replace corrupts them.

- [ ] **Step 3: Verify no `test.` table reference survives, case-insensitively**

```bash
grep -rniE 'test\.[a-z_]+' graphql/ | grep -vE 'playerMappers\.js:2|alertScopes\.js:50|Ratings\.js:186'
```

Expected: no output. The `-i` is Review Focus item 5.

- [ ] **Step 4: Verify the new references total 92**

```bash
grep -rhoE '(auth|play|alerts)\.[a-z_]+' graphql/model/PlayModel.js graphql/model/AuthModel.js | sort | uniq -c | sort -rn
```

Expected: the same fourteen table names with the same counts as Step 1's table, now schema-qualified. Totals 92.

- [ ] **Step 5: Confirm nothing else changed**

```bash
git diff --stat
```

Expected: exactly two files changed, and `git diff` shows only schema prefixes differing — no reformatting, no altered SQL.

- [ ] **Step 6: Commit without deploying**

```bash
git add graphql/model/PlayModel.js graphql/model/AuthModel.js
git commit -m "refactor(db): qualify table references with domain schemas"
```

---

### Task 4: The window — run the migration, then deploy

Everything up to here is reversible and invisible. This task is the write-failure window. Both prior tasks must be committed before starting, and the operator should be ready to run the deploy immediately.

**Files:** none changed.

**Interfaces:**
- Consumes: the migration from Task 2, the code change from Task 3, the baseline from Task 1.

**If this task goes wrong, rollback is two commands, and neither is safe alone.**
`npm run migrate:rollback` puts the tables back in `test`; redeploying the
previous revision puts the old `test.`-qualified code back. Running only the
first leaves new code pointing at tables that moved back; running only the second
leaves old code pointing at tables that moved away. Do both, migration first.

- [ ] **Step 1: Confirm the tree is clean and both commits are present**

```bash
git status --short && git log --oneline -3
```

Expected: no output from `status`; the migration and reference-rewrite commits both in the log.

- [ ] **Step 2: Run the migration**

```bash
npm run migrate:latest
```

Expected: the one new migration runs. On any error, confirm with Step 3's query that all fourteen tables are still in `test` — the transaction should have rolled back whole — then stop and report.

- [ ] **Step 3: Verify placement and counts against the baseline**

```sql
SELECT table_schema, table_name FROM information_schema.tables
WHERE table_schema IN ('auth','play','alerts','chat','legacy_20261110','test')
ORDER BY table_schema, table_name;
```

Expected, exactly:

| schema | count | tables |
|---|---|---|
| `auth` | 4 | `players`, `clubs`, `player_club_map`, `club_join_requests` |
| `play` | 9 | the nine from the assignment |
| `alerts` | 1 | `alerts` |
| `chat` | 0 | — |
| `legacy_20261110` | 2 | `players`, `clubs` — **the prototypes, expected, not an error** |
| `test` | 4 | `knex_migrations`, `knex_migrations_lock`, `login`, `notifications` |

The `legacy_20261110` and the two stray `test` rows are the easy ones to misread
as failure mid-window. `login` and `notifications` are dropped in Task 5, not
here. Then re-run Task 1 Step 2 and Step 3's queries against the new schemas and diff against the baseline file: row counts identical, every constraint and index present under its new schema.

- [ ] **Step 4: Deploy immediately**

```bash
npm run deploy
```

- [ ] **Step 5: Exercise the write paths, upserts first**

In the client or via GraphQL calls: match enrolment, record match result, submit a rating, skip a rating. These four cover the five `ON CONFLICT` upserts at `PlayModel.js:75`, `:194`, `:562`, `:642`, `:995` — the queries this whole plan was reshaped around, and the ones a grant or placement mistake breaks first.

- [ ] **Step 6: Exercise the read paths**

Login, signup, club browse, club list, club join request, player matches, alerts. Confirm no `relation ... does not exist` and no permission error in `npm run logs`.

- [ ] **Step 7: Push the branch**

```bash
git branch --unset-upstream
git push -u origin feat/domain-schema-split
```

The `--unset-upstream` is deliberate: the branch was created tracking `origin/develop`, so a bare `git push` would target `develop`.

---

### Task 5: Relocate knex bookkeeping and drop `test`

**Files:**
- Modify: `functions/knexfile.js` — `migrations.schemaName`
- Create: `docs/BACKLOG.md` entry (outer repo)

**Interfaces:**
- Consumes: the baseline from Task 1 for the final sequence check.

- [ ] **Step 1: Record what knex has applied**

```sql
SELECT id, name, batch FROM test.knex_migrations ORDER BY id;
```

Record this. It is the recovery data if the relocation goes wrong, and the comparison for Step 4. This is Review Focus item 2.

- [ ] **Step 2: Move the bookkeeping tables and update the config together**

Run as a one-off step, not a migration — a migration that relocates the table knex is reading mid-run is order-dependent for no benefit:

```sql
CREATE SCHEMA IF NOT EXISTS migrations;
ALTER TABLE test.knex_migrations SET SCHEMA migrations;
ALTER TABLE test.knex_migrations_lock SET SCHEMA migrations;
```

Then change `migrations.schemaName` in `functions/knexfile.js` from `"test"` to `"migrations"`.

- [ ] **Step 3: Confirm knex reads the relocated table and does not replay**

```bash
npm run migrate:latest
```

Expected: `Already up to date`. **If instead it begins re-running the baseline or any earlier migration, abort immediately** — it has not found the table and is about to replay the `played` backfill, the rating-table creation and the schema move. Recovery is to restore `schemaName` and re-check Step 2.

- [ ] **Step 4: Verify the applied list is unchanged**

```sql
SELECT id, name, batch FROM migrations.knex_migrations ORDER BY id;
```

Expected: identical to Step 1.

- [ ] **Step 5: Drop the two stray tables**

Task 1 Finding 2: `test.login` and `test.notifications` are both 0 rows,
referenced by no code, with no inbound foreign keys. The user's decision is to
drop them. **This `up` destroys tables**, though no rows.

```sql
DROP TABLE test.login;
DROP TABLE test.notifications;
```

Note `test.login` holds a foreign key to `auth.players(id)` — now
`auth.players_legacy_20261110` after Task 2's rename. Dropping `login` removes
that reference; it does not touch the legacy table.

Confirm both are empty immediately before dropping, rather than trusting the
Task 1 reading:

```sql
SELECT (SELECT count(*) FROM test.login) AS login,
       (SELECT count(*) FROM test.notifications) AS notifications;
```

Expected: `0 | 0`. **If either is non-zero, stop** — something wrote to a table
this plan recorded as dead.

- [ ] **Step 6: Confirm `test` is empty, including sequences**

```sql
SELECT 'table' AS kind, table_name AS name FROM information_schema.tables WHERE table_schema = 'test'
UNION ALL
SELECT 'sequence', sequencename FROM pg_sequences WHERE schemaname = 'test'
UNION ALL
SELECT 'routine', routine_name FROM information_schema.routines WHERE routine_schema = 'test';
```

Expected: no rows. The sequence line is now a belt-and-braces check rather than a live risk — Task 1 Finding 3 established every sequence is table-owned — but it costs nothing and catches anything created since.

- [ ] **Step 7: Drop `test`**

```sql
DROP SCHEMA test RESTRICT;
```

`RESTRICT`, not `CASCADE`: if anything unexpected still lives there, this must fail rather than delete it.

- [ ] **Step 8: Smoke-test and commit the config change**

Re-run two write paths and two read paths from Task 4 Steps 5–6.

```bash
git add knexfile.js
git commit -m "chore(db): move knex bookkeeping to migrations schema"
git push
```

- [ ] **Step 9: Record the work in the backlog and commit the docs**

Add a short entry to `docs/BACKLOG.md` under Architecture noting the split is done, the schema assignment, that `test` is gone, and the two things still open from the migrations item it relates to (the `pg_dump` baseline, and whether migrations become a deploy step). The design doc and this plan both predate any backlog entry for this work, which was the gap that started the conversation.

```bash
cd /Users/srijeetpatil/Desktop/projects/nmFootballGraphqlApi
git add docs/
git commit -m "docs: record domain schema split"
```
