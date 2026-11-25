# Split the `test` schema into domain schemas

*Design — 2026-11-10*

## Intent and the why

Every table in this database lives in a Postgres schema called `test`. That name
was chosen for a plan that has since been abandoned: staging and production
tables were going to share one database, separated by schema. That is not how the
project wants to run environments any more — staging and production get separate
databases on separate URLs, which is the ordinary way to do it.

So the schema name now describes an environment that does not exist, and it is
the only schema there is. Rather than rename `test` to something truthful like
`public` or `app`, the schemas become something useful: one per module of the
application. A schema then maps to a part of the app that can be reasoned about
on its own, which lines up with the function-splitting idea already in
`docs/BACKLOG.md` ("`play` carries most traffic — consider splitting the
function").

This is a structural change with no user-visible behaviour change. Nothing about
what the API returns should differ by so much as a field.

## Goals

- Every table lives in a schema named for the module that owns it.
- The `test` schema is gone when the work is finished.
- Schema changes ship as knex migrations, consistent with the decision recorded
  in `docs/BACKLOG.md` (2026-09-14, done 2026-10-29).
- The migration has a real `down` that puts every table back.

## Non-goals

- Splitting the Cloud Functions. That is a separate backlog item. This work makes
  it easier; it does not start it.
- Moving queries off the `pg` pool onto the knex query builder. knex stays a
  migration tool only, and a devDependency, so it stays out of the deployed
  bundle.
- Creating the staging database, or anything else about environment separation
  beyond no longer pretending `test` provides it.
- Renaming tables or columns. The GraphQL field-casing backlog item is untouched.
  A table keeps its name and only changes schema.
- Building anything in the `chat` module.
- Adding per-schema database *roles*. Grants are in scope — see Privileges.
- Fixing migration replay onto an empty database. See the note under Constraints.

## Anti-goals

These would make the work a failure even if the tables ended up in the right
place:

- **Copying data.** Rows must not be read out and written back. A move is a
  catalog operation; copying would introduce both real downtime and a chance of
  divergence.
- **Losing a foreign key, index, constraint, default, or sequence ownership** in
  the move.
- **Editing the three migrations already applied to the database.** They are
  history.
- **A half-applied move.** If the migration fails partway, it must roll back
  whole, leaving every table where it started.

## Constraints

- **Two repositories.** `functions/` is a git submodule
  (`git@github.com:srijeetpatil/ballersCloudFunctions.git`); the docs live in the
  outer repo. This work changes code in the submodule and docs in the outer repo,
  so it is two branches and two merges, not one.
- **Branch:** `feat/domain-schema-split`, cut from `origin/develop`, in the
  submodule. `develop` is the integration branch — there is no `main`. Note that
  `origin/develop` already contains the knex setup and all three migrations; the
  rating work is merged. (A local `develop` checkout is 41 commits stale and
  misleading — do not measure anything against it.)
- **One database.** `functions/knexfile.js` defines a single environment,
  `production`, and dev and production are the same database. There is no
  separate staging database yet and no rehearsal copy.
- **No users yet.** This is what makes the plan below viable: a window where
  writes fail costs nothing. It will not be true forever, and this work should
  land before it stops being true.
- **Two deployed Cloud Functions**, `ballersApiAuth` and `ballersApiPlay`, share
  the single `pg` pool in `functions/graphql/config/dbConfig.js`. They deploy
  together via `npm run deploy`, so one deploy swaps all references at once.
- **92 literal `test.` table references** in runtime code, in two files only:
  - `functions/graphql/model/PlayModel.js` — 64
  - `functions/graphql/model/AuthModel.js` — 28

  A naive `test\.` grep reports 95. The extra three are not table references and
  must not be rewritten: doc comments in
  `functions/graphql/utils/playerMappers.js:2` and
  `functions/graphql/utils/alertScopes.js:50`, and `latest.score` in
  `functions/graphql/resolvers/Play/Ratings.js:186`.
- **Five of those references are upserts** — `ON CONFLICT`, at
  `PlayModel.js:75`, `:194`, `:562`, `:642` and `:995`. They need no special
  handling under this plan, but they are the reason the plan looks like this; see
  Rejected alternatives.
- **knex's own bookkeeping tables** (`knex_migrations`, `knex_migrations_lock`)
  currently live in `test`, via `migrations.schemaName: "test"` in
  `functions/knexfile.js`. They have to move before `test` can be dropped.
- **Migration replay onto an empty database is already broken** and stays that
  way. Nothing in `functions/migrations/` creates the `test` schema, so a fresh
  replay fails at migration 2 today, before this work touches anything. The
  design's call: do not try to fix it here. The staging database will be built
  from the `pg_dump` baseline that `docs/BACKLOG.md` still lists as open, not by
  replaying migrations. If that decision reverses, this plan needs revisiting —
  the migration would have to create `test` and tolerate absent tables.
- **Nothing outside these two repos references `test.`** — confirmed: no BI
  dashboards, saved queries or admin scripts. Dropping the schema is safe.
- **No automated tests in this project**, and none should be scaffolded for this.
  Verification is manual, by standing practice.

## The schemas

Four modules:

| Schema | Tables |
|---|---|
| `auth` | `players`, `clubs`, `player_club_map`, `club_join_requests` |
| `play` | `matches`, `player_match_map`, `match_goals`, `match_audit_log`, `temp_teams`, `player_temp_team_map`, `venues`, `match_ratings`, `player_match_ratings` |
| `alerts` | `alerts` |
| `chat` | none yet |

Fourteen tables. Notes on the placement decisions:

- **Clubs go to `auth`, with players.** Clubs were the one genuinely contested
  group — the backlog records the club domain as already split across both
  functions, created and moderated on `auth` but browsed on `play`. They are
  identity-and-membership rather than gameplay, so they sit with players.
- **`Play` and `Match` are one module, not two.** Both were named separately in
  conversation and then merged: everything match-shaped is `play`.
- **`venues` and `match_audit_log` go to `play`** — the design's call, not a
  stated preference. Only match code reads `venues`, and the audit log records
  match actions, so neither earns a schema of its own.
- **`chat` is created now as an empty schema**, also the design's call. It costs
  nothing, documents the intent in the database itself, and means the first chat
  migration adds a table rather than also inventing a schema. Skipping it is
  acceptable and changes nothing else.

## The method: move, don't copy

`ALTER TABLE test.players SET SCHEMA auth;` moves a table by rewriting a catalog
entry. No rows are read or written. It is effectively instant regardless of table
size, and it carries indexes, constraints, defaults, triggers and owned sequences
with it. Foreign keys across schemas are fine, so a `play.matches` row can
reference `auth.players` with no change to the constraint.

This is the only sanctioned way to move a table here.

Two details the builder should confirm rather than assume:

- **Sequences.** A sequence owned by a moved table's `serial`/`identity` column
  moves with the table. A standalone sequence, or one shared between tables, does
  not. Enumerate sequences before writing the migration and move any stragglers
  explicitly.
- **Other objects in `test`.** If anything else lives there — a view, a function,
  a materialized view — it either moves too or breaks when `test` is dropped.
  Enumerate what `test` actually contains before assuming it is fourteen tables
  and nothing more.

## The cutover: one landing, with a window

Because there are no users, this needs no zero-downtime machinery. The plan is
deliberately the blunt one:

1. One migration moves all fourteen tables and creates the four schemas.
2. Deploy the code with all 92 references rewritten.
3. Writes fail in between. That window is acceptable and is the whole reason this
   should land before there are users.

The migration runs inside a single transaction, so a failure anywhere rolls the
whole thing back rather than leaving tables scattered across two schemas. The
builder should confirm knex wraps it in a transaction and force it if not —
`ALTER TABLE ... SET SCHEMA` is transactional in Postgres, so this works.

Order of operations: run the migration, then deploy immediately. Do not leave the
gap open longer than the deploy takes. Have the code change reviewed, committed
and ready to deploy *before* running the migration, so the window is one
`npm run deploy` and not a round of code review.

## Rejected alternatives

**Compatibility views in `test`.** The original design for this work: move each
table, then create `test.players` as a view over `auth.players`, so old code kept
working and the deploy could happen at leisure. Dropped for two reasons. The
decisive one is that **Postgres rejects `ON CONFLICT` against a view** — a view
has no unique index for conflict arbitration, and `INSTEAD OF` triggers do not
rescue it. Five live queries are upserts, on enrolment and both rating paths, so
the shims would have broken exactly the writes they were meant to protect. The
second reason is that with no users, the zero-downtime benefit the views bought
was worth nothing, while the costs were real: a `SELECT *` view freezes its
column list at creation time, and a view executes with its owner's privileges,
which would have masked a missing grant until the deploy.

Keeping this on record because the approach is sound for a genuinely live
system, and the `ON CONFLICT` limitation is the kind of thing worth not
rediscovering.

**`search_path` instead of schema prefixes.** Strip `test.` from the SQL and let
the pool's `search_path` resolve tables. Rejected: it hardcodes nothing, but it
only works while table names stay unique across all schemas, and it fails
silently and confusingly the day two schemas hold the same name.

## Privileges

The design's call: **the migration issues grants explicitly and idempotently**,
rather than assuming the app role inherits access to the new schemas. A new
schema grants `USAGE` to nobody but its owner, and inherited access is exactly
the kind of assumption that fails after the deploy rather than during the
migration.

The plan's first task is a privilege audit, before any migration is written:

- Confirm `DB_USER` **owns** all fourteen tables — `ALTER TABLE ... SET SCHEMA`
  requires ownership.
- Confirm `DB_USER` holds database-level `CREATE` — `CREATE SCHEMA` requires it.

If either is false, acquiring the privilege is a prerequisite step, not something
to discover halfway through the migration. Likely both are true, since one
`DB_USER` serves both knex and the runtime pool, but it is cheap to verify and
expensive to assume.

## Where knex's bookkeeping goes

`knex_migrations` and `knex_migrations_lock` sit in `test` today and block
dropping it. The design's call: move them to their own `migrations` schema and
update `migrations.schemaName` in `functions/knexfile.js` to match. It keeps
tooling state out of the domain schemas, it is owned by no module, and `public`
is being left empty on purpose.

This needs care, because knex reads that table to decide what to run, and moving
it from inside a migration that knex is itself tracking is order-dependent. The
builder decides whether this is a migration or a one-off step run alongside the
config change, and must sequence it so that `migrate:latest` immediately
afterwards is a no-op rather than a replay.

## Verification

Manual, and the plan should state the checks explicitly. At minimum:

- **Before:** capture per-table row counts, and a listing of foreign keys,
  indexes, constraints and sequences. This is the only baseline there will be.
- **After the migration:** row counts match. Every foreign key, index and
  constraint is present, compared against the listing. `test` contains nothing
  but the knex tables.
- **After the deploy:** exercise login, club browse, club join request, match
  create, enrolment, record result, ratings submit, and alerts. The five upsert
  paths — enrolment and both rating writes — get specific attention, since they
  are the queries this plan was reshaped around.
- **Finally:** `test` is gone, and `migrate:latest` is a no-op.

Migrations run by hand before `npm run deploy`. Whether that becomes a deploy
step is a separate open backlog item and is not decided here.

## Rollback

The migration's `down` moves all fourteen tables back to `test`, drops the four
schemas, and returns the knex bookkeeping. Rolling back the code is a redeploy of
the previous revision.

Because this is one landing rather than three, rollback means doing both: `npm
run migrate:rollback` and a redeploy. Neither is safe alone. The plan should say
so in the task that runs the migration.

## Left to the builder

- Whether the fourteen moves are one migration or several, given the single
  landing.
- Whether the `migrations` schema move is a knex migration or a one-off step.
- Whether to create the empty `chat` schema.
- How to rewrite 92 references and be sure none were missed — including in string
  concatenation, which the SQL-injection backlog item shows exists here. The
  three known false positives are listed under Constraints.
- Whether to add a backlog entry for this work, which was never written down.
