# Pre-split database baseline

*Captured 2026-11-10, read-only, against the single (dev == prod) database.*
*Plan: `docs/superpowers/plans/2026-11-10-domain-schema-split.md` Task 1.*

## Gate results

| Check | Result |
|---|---|
| Ownership of all tables in `test` | **PASS** — all 18 owned by `ballers_owner` |
| `current_user` | `ballers_owner` |
| Database-level `CREATE` | **PASS** — `true` |
| Routines in `test` | none |
| Views / materialized views in `test` | none |
| Only the expected 14 tables + knex's 2 in `test` | **FAIL** — see Finding 2 |
| No pre-existing target schema | **FAIL** — see Finding 1 |

## Finding 1 (blocker): the `auth` schema already exists, with `players` and `clubs`

Schemas present before this work: `auth`, `public`, `test`.

`auth` is owned by `ballers_owner`, has a null ACL, and already contains two
tables of an older, different shape. Neither is referenced anywhere in the
codebase — all 92 runtime references point at `test`.

| | rows | columns |
|---|---|---|
| `auth.players` | 1 | `id`, `username`, `phone`, `position`, `created_at` (timestamp **without** tz) |
| `test.players` | 18 | `id`, `first_name`, `last_name`, `position`, `profile_picture`, `is_banned`, `saved_upi_ids`, `created_at`, `updated_at`, `phone`, `passkey`, `is_deleted`, `is_app_admin` |
| `auth.clubs` | 2 | `club_id`, `club_name`, `club_founder_id`, `club_members`, `created_at` |
| `test.clubs` | 13 | (13 columns, per `graphql/schema/Auth.js`) |

`auth` also holds `players_id_seq`, `clubs_club_id_seq`, `players_pkey` and
`clubs_pkey`. The `username` and `club_id`/`club_name` naming suggests an early
prototype that predates the current shape.

**Consequence:** `ALTER TABLE test.players SET SCHEMA auth` fails with *relation
"players" already exists in schema "auth"*. The plan's Task 2 cannot run as
written. Awaiting a decision.

## Finding 1b (critical, found in review): the collision is five names, not two

Renaming the two prototype *tables* is not enough. `ALTER TABLE ... SET SCHEMA`
moves a table **together with its indexes and owned sequences**, and tables,
indexes and sequences share one name namespace per schema. Every one needs a
free name in the destination.

Collision query, run 2026-11-10:

```sql
SELECT tn.nspname AS target_schema, t.relname, t.relkind
FROM pg_class s
JOIN pg_class t ON t.relname = s.relname
JOIN pg_namespace tn ON tn.oid = t.relnamespace
WHERE s.relnamespace = 'test'::regnamespace
  AND tn.nspname IN ('auth','play','alerts','chat');
```

| target | name | kind |
|---|---|---|
| `auth` | `players` | table |
| `auth` | `clubs` | table |
| `auth` | `players_pkey` | index |
| `auth` | `clubs_pkey` | index |
| `auth` | `players_id_seq` | sequence |

`test.clubs`' sequence is `clubs_id_seq` against the prototype's
`clubs_club_id_seq`, so that one happens not to clash. `play`, `alerts` and
`chat` do not exist yet and contribute nothing.

**Consequence:** a rename-in-place would have left three collisions and the
first move would have aborted with *relation "players_pkey" already exists in
schema "auth"* — the same shape as the message the rename was meant to prevent.
Resolved by relocating both prototype tables to a `legacy_20261110` schema with
`SET SCHEMA`, which carries their sub-objects out in one statement.

## Finding 1c: lock settings make an untimed migration dangerous

| setting | value |
|---|---|
| `lock_timeout` | `0` (wait forever) |
| `statement_timeout` | `0` |
| `idle_in_transaction_session_timeout` | `300000` (5 min) |
| `search_path` | `"$user", public` |

`DB_HOST` is the Neon **pooler** endpoint, so the deployed functions hold warm
server connections to this database during the migration. `SET SCHEMA` takes
ACCESS EXCLUSIVE, and a waiting ACCESS EXCLUSIVE request queues *ahead* of later
arrivals — one function stuck mid-transaction would stall the whole API while
the migration sat on a half-moved catalog. Resolved by `SET LOCAL lock_timeout =
'5s'` / `statement_timeout = '60s'` at the top of both `up` and `down`.

## Finding 2: two unexpected tables in `test`

| Table | Rows | Columns | Referenced in code? | Inbound FKs |
|---|---|---|---|---|
| `test.login` | 0 | `id`, `name`, `phone_number`, `email_id`, `age`, `type`, `timestamp`, `player_id` | no | none |
| `test.notifications` | 0 | `id`, `type`, `content` (json), `recepient`, `seen`, `created_at` | no | none |

Both are empty, both have an `fk_player` foreign key *out* to `players`, and
nothing references either. `notifications` appears superseded by `alerts`;
`login` by the `players`/`passkey` path in `AuthModel.js`. Neither is in the
plan's fourteen, and both would block `DROP SCHEMA test RESTRICT` in Task 5.

## Finding 3: correction — there are no standalone sequences

An initial query using only `pg_depend.deptype = 'a'` reported seven sequences
with no owning table. That was wrong. Those seven columns are
`GENERATED ALWAYS AS IDENTITY`, whose sequences link with `deptype = 'i'`.

Re-checked across `deptype IN ('a','i','n')`: **all 17 sequences in `test` are
owned by a table in `test`** — 10 via `'a'` (serial) and 7 via `'i'` (identity):
`clubs`, `login`, `matches`, `notifications`, `player_club_map`,
`player_match_map`, `players`.

Every sequence therefore travels with its table on `SET SCHEMA`. Review Focus
item 1 resolves clean, and the "standalone sequence" clauses in Task 2 Step 2
and Task 5 Step 5 have nothing to act on.

## Nothing outside `test` depends on `test`

The "no views, no routines" check above was scoped to `information_schema`
*within* `test`, which cannot establish this — the dangerous dependent is a
view, function or trigger in `public` or `auth` that reads `test.*`. It would
survive the move silently (dependencies are OID-based) and break at
`DROP SCHEMA test`, or at runtime with no migration error to point at.

Run 2026-11-10, all three returned **zero rows**:

- `pg_rewrite` dependencies on `test` relations from any other schema — none.
- `pg_proc` bodies containing `test.` outside the catalogs — none.
- Non-internal triggers on `test` tables — none.

Object inventory of `test` by kind: **18 tables, 33 indexes, 17 sequences, and
nothing else.**

## Row counts

Exact counts where taken, `pg_stat_user_tables` estimates otherwise. Note
`test.players` is **18** exact against a 15 estimate — compare exact-to-exact
after the move.

| Table | Count |
|---|---|
| players | 18 (exact) |
| clubs | 13 (exact) |
| matches | 49 |
| player_match_map | 66 |
| alerts | 43 |
| match_audit_log | 29 |
| player_club_map | 21 |
| match_goals | 15 |
| club_join_requests | 13 |
| match_ratings | 6 |
| player_match_ratings | 6 |
| temp_teams | 4 |
| player_temp_team_map | 2 |
| venues | 0 |
| login | 0 |
| notifications | 0 |
| knex_migrations | 3 |
| knex_migrations_lock | 1 |

## Constraints: 50 total in `test`

Primary keys on all 18 tables. Unique: `match_ratings_unique_pair`,
`player_match_unique`, `club_join_requests` (`uniq_pending_club_join_request`,
partial index), `uniq_player_club_membership`. Check: `match_ratings_no_self`,
`match_ratings_score_range`. 24 foreign keys. Full listing captured in the Task 1
query output.

## Indexes: 33 total in `test`

Including three trigram indexes on `clubs` (`idx_clubs_name_trgm`,
`idx_clubs_locality_trgm`, `idx_clubs_description_trgm`) — these depend on the
`pg_trgm` extension, which lives in whichever schema it was installed into.
Confirm after the move that club search still uses them.
