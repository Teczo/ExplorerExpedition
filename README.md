# Explorer Expedition Platform

An API-first game engine for real-world expeditions. Teachers author an
expedition, students play it on their phones, and the creator watches it live
from Director Mode.

This repository is a single npm workspace. Everything lives here.

## Layout

| Path                     | What it is                                                              |
| ------------------------ | ----------------------------------------------------------------------- |
| `apps/api`               | Express REST API. The only thing that talks to the database.            |
| `apps/api/db`            | The PostgreSQL schema, as numbered SQL migrations.                      |
| `apps/creator-web`       | React app teachers use to build and run expeditions.                    |
| `apps/studio`            | React app for authoring mission types, graphs and scoring rules.        |
| `apps/admin`             | React app for internal organisation, plan and support work.             |
| `apps/student-mobile`    | React Native app students play on.                                      |
| `packages/engine`        | Mission Engine. Game rules only — no database, no HTTP.                 |
| `packages/shared-types`  | Types shared across apps and the engine.                                |
| `infra`                  | The Azure baseline for dev and prod, as Bicep.                          |
| `scripts`                | Builds the deployment package for the API and for a web app.            |
| `.github/workflows`      | The build, lint, test and deploy pipeline.                              |

`packages/*` may not import from `apps/*`. Apps import from packages.

## Requirements

- Node.js 22.18 or newer. The API runs TypeScript directly, which needs that
  version. Run `nvm use` to pick up `.nvmrc`.
- PostgreSQL 14 or newer, to apply the schema in `apps/api/db`. Nothing in the
  repository connects to it yet.

## Getting started

```bash
npm install
npm run build:packages   # apps read the built output of packages/
```

`npm run build:packages` has to run before the first typecheck or app build,
because the apps import `@explorer/shared-types` from its `dist/` folder.

## Commands

Run these from the repository root.

| Command                      | What it does                                    |
| ---------------------------- | ----------------------------------------------- |
| `npm run build`              | Builds packages, then every app.                |
| `npm run build:packages`     | Builds `shared-types` and `engine` only.        |
| `npm run typecheck`          | Type-checks every workspace.                    |
| `npm run test`               | Runs the automated tests.                       |
| `npm run dev:api`            | API on http://localhost:3000                    |
| `npm run dev:creator-web`    | Creator web on http://localhost:5173            |
| `npm run dev:studio`         | Studio on http://localhost:5174                 |
| `npm run dev:admin`          | Admin on http://localhost:5175                  |
| `npm run dev:student-mobile` | Starts the Metro bundler.                       |
| `npm run clean`              | Removes `node_modules` and all build output.     |

And the two the pipeline runs, which work the same on your own machine:

| Command                          | What it does                                |
| -------------------------------- | ------------------------------------------- |
| `scripts/package-api.sh`         | Builds the zip App Service runs, and checks it. |
| `scripts/package-web.sh studio`  | Builds what Vercel serves, for one app.     |

Check the API is up, and whether it can reach what it needs:

```bash
curl http://localhost:3000/health         # is the process alive?
curl http://localhost:3000/health/ready   # can it serve a real request?
```

## State of the code

The phase-0 scaffold (EXPD-001) is in place: each app and package has a
working build and a placeholder entry point. On top of it sit the Expedition
Definition schema (EXPD-002), the database schema (EXPD-003), auth and
organisation tenancy (EXPD-004), the cross-organisation isolation tests that
hold EXPD-004 to its word (EXPD-005), the append-only audit log
(EXPD-006), the Azure baseline those all run on (EXPD-007), the pipeline
that builds, checks and deploys the lot (EXPD-008), the mission type
registry the engine is built around (EXPD-009), the mission state machine
that says where a team stands on a mission (EXPD-010), the completion and
validation interface every finished mission comes through (EXPD-011), the
scoring engine that says what a verdict was worth (EXPD-012), and the
progression engine that says what the graph comes to for one team
(EXPD-013), the auditable event stream that carries what both decided so
a final result can be rebuilt and disputed (EXPD-014), and the simulation
harness that plays a whole expedition with fake teams so all six can be held
to account at once (EXPD-015), and the REST API skeleton every endpoint from
here on is built on (EXPD-016), and the first endpoints standing on it: the
expeditions themselves, their drafts, and the publish that freezes a revision
(EXPD-017), and the join codes, teams and participants that fill a run of one
with a class (EXPD-018), and the lifecycle of the run itself — starting it,
pausing it, extending it and ending it, and the one clock every team in it
plays against (EXPD-019), and the endpoints a team plays a mission through —
starting a try, handing work in, opening a hint, and a teacher marking
waiting work complete (EXPD-020), and the signed URLs a phone uploads a
photograph with and a teacher reads it back with (EXPD-021), and the
leaderboards of a run and of an expedition (EXPD-022), all described
below. The rest is tracked in its
own tickets:

- Studio shell — EXPD-024
- Student app shell — EXPD-040
- Creator web shell — EXPD-049
- Admin portal — EXPD-070

### The Expedition Definition schema

`packages/shared-types/src/expedition/` holds the contract for an expedition:
its metadata, missions, graph, rules and scoring. Everything that authors,
stores, plays or generates an expedition reads and writes this one shape.

```ts
import {
  validateExpeditionDefinition,
  type ExpeditionDefinition,
} from '@explorer/shared-types';

const result = validateExpeditionDefinition(await request.json());
if (!result.valid) {
  // Each issue carries the path to the field, such as `graph.edges[3].to`.
  return reply.status(400).send({ issues: result.issues });
}
```

The document carries its own `schemaVersion`, so a reader can tell whether it
understands a file before reading it. `packages/shared-types/src/expedition/version.ts`
sets out the compatibility rules. It is at **1.1.0**: progression (EXPD-013)
added `optional` and `secret` to a mission node, `audience` to an edge, and
`routes` to the expedition's rules. All four are optional fields, so a 1.0.0
document is still a valid one and reads as an expedition with no routes where
every mission blocks the way and none is hidden.

`validateExpeditionDefinition` checks the shape of a document and the way its
parts point at each other: unknown ids, a mission no node uses, a graph with no
start, a node nothing can reach, a loop. It does not check
`MissionInstance.config`, because only the mission type knows the right shape
for that. The mission type registry below is what checks it, and running both
is what fully checks a document.

The only tests over it are the ones EXPD-013 brought with the fields it added,
in `packages/shared-types/test/expedition/progression-fields.test.ts`. Testing
the rest of the validator is not part of any ticket that has been done.

### The database schema

`apps/api/db/migrations/` holds the PostgreSQL schema as numbered SQL files.
`0001_core_data_model.sql` creates all 25 tables, from `organisation` down to
`audit_log`, `0003_append_only_audit_log.sql` makes the last of those a table
nothing can edit, and `0004_auditable_event_stream.sql` adds
`progression_event` and holds it and `score_event` to the same rule.
`apps/api/db/README.md` explains how to apply them and how the tables are laid
out.

```bash
createdb explorer
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0001_core_data_model.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0002_auth_and_tenancy.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0003_append_only_audit_log.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0004_auditable_event_stream.sql
```

The schema stores a published expedition twice over, on purpose. The whole
EXPD-002 document goes into `expedition_version.definition` as JSONB and is
the source of truth. `mission_instance`, `mission_node` and `hint` are a flat
copy of the parts that runtime rows have to hold a foreign key to, since a
mission attempt cannot point at a string buried in a JSONB document. EXPD-017
writes both together.

Nothing in the repository connects to a database yet. A driver is a
dependency, and so is a migration runner, and no ticket has been allowed to add
one. The REST skeleton (EXPD-016) left the hole open rather than filling it:
`createApp({ db })` takes a connection from its caller, and nothing calls it
that way.

### Auth and organisation tenancy

Two halves. The vocabulary is in `packages/shared-types/src/auth/`, because
the Studio and the student app need it too. Everything that hashes, signs or
reads a row is in `apps/api/src/auth/` and `apps/api/src/db/`.

**Roles.** The database stores five membership roles; the code checks six
platform roles. They are different lists on purpose, and
`ORG_ROLE_BY_MEMBERSHIP_ROLE` is the one place they are joined up.

| `membership.role` | Platform role    | What it means                          |
| ----------------- | ---------------- | -------------------------------------- |
| `owner`, `admin`  | `org-admin`      | Runs one organisation.                 |
| `creator`         | `creator`        | Builds expeditions and mission types.  |
| `teacher`         | `facilitator`    | Runs a class. Does not author.         |
| `member`          | `org-member`     | Signed in, granted nothing yet.        |
| —                 | `platform-admin` | `app_user.is_platform_admin`.          |
| —                 | `student-device` | A phone. No account (EXPD-071).        |

Code asks what somebody may *do*, never what role they hold:

```ts
import { can } from '@explorer/shared-types';

if (!can(principal, 'expedition:publish')) {
  return response.status(403).json({ error: 'forbidden' });
}
```

**Org-scoped tokens.** Signing in is two steps. `POST /auth/sign-in` checks
the password and answers with a refresh token and the organisations the
person may act for; `POST /auth/token` trades that for an access token naming
one of them. A teacher who works for two schools holds one sign-in and one
access token per school, and the organisation is inside the signature, so no
header a caller sends can change it. Somebody who belongs to one organisation
gets their access token from the first call, so the common case is still one
round trip.

**Isolation.** `apps/api/src/db` is the only thing that talks to PostgreSQL.
A `TenantRepository` cannot be built without an organisation, and it puts
`organisation_id = $n` into every statement it builds — reads, writes and
deletes alike — so isolation is not something anybody has to remember:

```ts
const teams = await tenantOf(request).find('team', { where: { status: 'playing' } });
```

There are two ways out, and both are loud. `includeSharedRows` widens *reads*
to the platform-wide mission types, templates and badges; it never widens a
write. `GlobalRepository` reaches the four tables that belong to no
organisation — `organisation`, `app_user`, `user_credential`, `auth_session` —
and makes each call state a reason. What holds all of that to its word is
EXPD-005, below.

**Passwords and tokens** are built on `node:crypto` alone: scrypt for
passwords, HMAC-SHA256 for access tokens, and 256 random bits for refresh and
device tokens, stored only as a SHA-256 hash. No dependency was added.

**Settings.** `AUTH_TOKEN_SECRET` is required and has to be at least 32
bytes; the API refuses to start without it rather than inventing one that
would differ between instances.

```bash
export AUTH_TOKEN_SECRET="$(openssl rand -base64 48)"
```

`AUTH_ACCESS_TOKEN_SECONDS` (900), `AUTH_REFRESH_TOKEN_SECONDS` (30 days) and
`AUTH_DEVICE_TOKEN_SECONDS` (14 days) are optional.

The auth routes are mounted only when `createApp` is given a database.
Nothing in the repository opens a connection yet, because a driver is a
dependency no ticket has added. `pg.Pool` already satisfies the `Queryable`
interface the repository layer is written against, so the ticket that adds it
has nothing to write but the pool:

```ts
createApp({ db: new Pool({ connectionString: process.env.DATABASE_URL }) });
```

Until then `createApp()` serves the health check, exactly as before.

### Cross-organisation isolation tests

`apps/api/test/isolation/` is the proof that the paragraph above is true. Every
claim EXPD-004 makes about tenancy has a test that tries to break it.

```bash
npm run test
```

The runner is Node's own `node --test`, and the tests are TypeScript that Node
runs directly, the same way `npm run dev:api` runs the API. No dependency was
added, and nothing has to be installed to run them.

**They need no database.** Two fakes stand in for one, in `test/support/`, and
they do different jobs:

- `FakeDatabase` keeps rows in memory and really runs the statements the
  repository layer builds against them. It filters nothing itself, so a row
  that fails to come back was held back by the code under test and nothing
  else. A statement outside the small grammar `src/db/sql.ts` produces makes it
  throw, rather than quietly matching nothing and passing for the wrong reason.
- `RecordingDatabase` answers from a script and remembers the questions. It is
  for the statements written by hand — the membership join, for one — where
  what matters is that the organisation reached the statement as a bound value.

Most tests are the same experiment. Put a row in for Portside School and a row
in for Riverbank Academy, act as one of them, and check the other one's row is
neither returned nor changed. That runs over **every** tenant-scoped table
rather than a chosen few, because the predicate is attached per table and a
table nobody thought about is how a leak would arrive.

| File                        | What it holds to account                                      |
| --------------------------- | ------------------------------------------------------------- |
| `table-registry.test.ts`    | `TABLE_SCOPES` against the migrations themselves.             |
| `tenant-reads.test.ts`      | No read reaches another organisation, on any table.           |
| `tenant-writes.test.ts`     | No insert, update or delete does either.                      |
| `shared-rows.test.ts`       | `includeSharedRows` widens reads, and only reads.             |
| `hand-written-sql.test.ts`  | `readPredicate`, `writePredicate` and `queryScoped`.          |
| `global-repository.test.ts` | The hole is four tables wide, and no wider.                   |
| `device-tokens.test.ts`     | A phone's token is looked up inside one organisation.         |
| `access-tokens.test.ts`     | The organisation is inside the signature.                     |
| `auth-service.test.ts`      | No token is minted for an organisation nobody belongs to.     |
| `request-pipeline.test.ts`  | All of it end to end, over HTTP, with hostile headers.        |

`table-registry.test.ts` is the one that does not use a fake at all. It parses
every `CREATE TABLE` in `apps/api/db/migrations/` and compares it with
`TABLE_SCOPES`, so a migration that adds a table without registering it fails
on the commit that adds it — which matters, because an unregistered table is
one that nothing scopes.

Two limits are worth knowing, and both are written down as tests rather than
left to be discovered:

1. `queryScoped` checks that a hand-written statement mentions
   `organisation_id`. It is a guard rail against forgetting the predicate, not
   a parser, and it cannot tell a predicate in the right place from one in the
   wrong place.
2. These tests exercise the repository layer, not PostgreSQL. They prove the
   statements the API builds carry the isolation predicate and behave as
   intended; they do not prove the database would refuse a statement that did
   not. Row-level security would be that second belt, and no ticket has asked
   for one.

### The audit log

`audit_log` answers one question, and it has to keep answering it years
later: who changed this, and when. EXPD-006 is what makes the answer worth
trusting. Two halves again — the vocabulary is in
`packages/shared-types/src/audit/`, because the admin portal and the Studio
read entries; the writing is in `apps/api/src/audit/`.

**It cannot be edited.** The table takes an `INSERT` and nothing else.
Migration `0003` puts triggers on it that refuse an `UPDATE`, a `DELETE` and
a `TRUNCATE` from every caller, and `TenantRepository` refuses the first two
before a statement is built, so the mistake is a clear message rather than a
driver error later:

```
AppendOnlyTableError: audit_log is append-only, so UPDATE is refused.
Correct a wrong entry by appending another entry that says so.
```

There is no method on `AuditLog` that changes an entry, and there is no
`audit:write` permission, because there is nothing either would be for.
`audit:read` already existed, and only `org-admin` and `platform-admin` hold
it.

**It cannot leave its organisation.** `AuditLog` is built on a
`TenantRepository`, so it inherits EXPD-004 whole: entries are stamped with
that organisation and reads are filtered by it, and the class has no way to
ask for another. A NULL `organisation_id` means a platform-level action, and
nothing widens a read to include those — writing one is EXPD-070's, along
with the admin portal that would read them.

**The entry names the caller, and the caller cannot say who they are.**
`auditScope()` sits behind the auth middleware and builds the log from the
token, so a handler is never given the chance to name somebody else:

```ts
router.post(
  '/expeditions/:id/publish',
  authenticate(service),
  requirePermission('expedition:publish'),
  tenantScope(db),
  auditScope(),
  async (request, response) => {
    await auditOf(request).record('expedition.published', {
      entityId: version.id,
      before: { status: 'draft' },
      after: { status: 'published' },
    });
  },
);
```

`record` takes the action from a closed list — `AUDIT_ACTIONS`, which covers
the scoring changes and the administrative actions this ticket asked for —
and works out the entity type from it, because `expedition.published` is
always about an `expedition_version` and an entry that said otherwise would
be one nobody could join back to a row.

Writing the entry inside the change's own transaction is
`audit.withConnection(tx)`, so that neither can exist without the other.

**What goes in `changes`, and what does not.** The note 0001 left on that
column — "EXPD-006 decides how much of a row goes in here, and what has to be
left out of it (EXPD-071)" — is answered in `apps/api/src/audit/redact.ts`.
An entry is not a copy of the row. Only the columns that actually moved are
recorded, and then:

- a secret is never written down. A column whose name carries `password`,
  `token`, `secret`, `credential` or a key is recorded as `[redacted]`, so
  the entry still says the password changed without saying to what.
- a child's details are not either (EXPD-071). On a `participant` or a
  `submission`, the personal columns go the same way: the entry says the name
  changed and writes down neither name. A student is always labelled by id,
  whatever a caller passes, because the type offers no way to pass one.
- a document — an expedition definition, a submission payload — becomes
  `[not recorded]` rather than being copied, and a long string is cut short.
  An entry should stay a line, not become an archive of data somebody may
  later ask to have deleted.

The tests are in `apps/api/test/audit/`:

| File                    | What it holds to account                                  |
| ----------------------- | --------------------------------------------------------- |
| `append-only.test.ts`   | The triggers in the migration, and the repository refusal. |
| `redaction.test.ts`     | Every secret and every child's detail that must not go in. |
| `audit-log.test.ts`     | Which columns an entry carries, and how it is read back.   |
| `vocabulary.test.ts`    | The shared action list against the real table registry.    |
| `route-wiring.test.ts`  | All of it over HTTP, with a body claiming to be somebody.  |

Two limits are worth knowing:

1. `queryScoped` still runs whatever SQL a caller hands it. It checks the
   statement mentions `organisation_id` and it does not parse it, so a
   hand-written `UPDATE audit_log` would reach the database — where the
   triggers refuse it. That is the belt the braces are there for.
2. Nothing writes an entry yet, because nothing else has an endpoint to write
   one from. Every ticket that adds one — EXPD-017, EXPD-031, EXPD-056,
   EXPD-058, EXPD-070 — adds the `record` call its route needs, and the
   action it needs is already in the list.

### The Azure baseline

`infra/` creates the environment the API runs in: a Linux App Service plan and
web app, PostgreSQL Flexible Server with the `explorer` database, a storage
account with a `media` container, Azure Cache for Redis, and a Key Vault
holding the three secrets that join them up. It is Bicep, so it needs the
Azure CLI and nothing from `npm install`. `infra/README.md` has the commands.

There are two environments, `dev` and `prod`, and one template. What differs
between them is size and nothing else — the same resources, the same wiring,
the same settings, the same secret names — because an environment shaped
differently from the one it stands in for has stopped standing in for it. The
sizes are in `main.bicep`, so the two parameter files hold only a region and
where the secrets come from.

```bash
az group create --name rg-explorer-dev --location westeurope
az deployment group create \
  --resource-group rg-explorer-dev \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam
```

**Nothing holds a key it does not need.** Storage has `allowSharedKeyAccess`
off, so its two account keys do not work at all and the web app reaches blobs
as itself, with a managed identity granted Storage Blob Data Contributor. That
is also what EXPD-021 needs, because the user delegation key that signs an
upload URL comes from an identity and not from a key. PostgreSQL and Redis do
need a connection string, so those are Key Vault secrets and the app settings
are references — `@Microsoft.KeyVault(VaultName=...;SecretName=...)` — resolved
by the app with the same identity, granted Key Vault Secrets User and nothing
more. `AUTH_TOKEN_SECRET` arrives the same way, which is what the note in
`apps/api/src/config/auth-config.ts` has been pointing at since EXPD-004.

**The API does not sign in as the administrator.** The administrator owns the
schema and applies the migrations; the API reads and writes rows in tables that
already exist. `infra/sql/application-role.sql` creates the `explorer_api` role
that does the second job, and the connection string in the vault is that one.
It is also where `audit_log` finally gets the grant migration 0003 said a later
ticket would have to create: the role is not given the `UPDATE` and `DELETE`
the triggers would refuse anyway.

Three things this baseline is deliberately not, written down in
`infra/README.md` rather than left to be found: there is no private
networking, no monitoring, and nothing for the three React apps, which the
stack puts on Vercel. The fourth — nothing that deploys code into the web
app — is what EXPD-008 answered, below.

One limit is worth knowing. Nothing in `npm run test` reads these files,
because the tool that would check them is the Azure CLI and `npm install` does
not install it. `az deployment group what-if` is still the review before a
deployment, and still a manual one: EXPD-008 deploys the API and the web
apps, not the infrastructure under them.

### The pipeline

`.github/workflows/ci.yml` is the one that builds, checks and deploys all of
the above. `docs/ci.md` is its own page; this is the shape of it.

One workflow holds every stage, because the ordering is the point. `needs` is
the only way to say "do not deploy this unless it passed" that GitHub
enforces, and it only reaches inside one workflow. A pull request runs `lint`,
`test`, `build-api` and `build-web` in parallel. A push to `main` runs the same
four and then deploys to `dev`. `prod` is only ever reached by starting a run
by hand.

Nothing is built twice. The deploy jobs take the artefact the build jobs
uploaded, so what ships is the thing that was checked and not a second build of
the same commit that nobody looked at.

**`lint` runs `tsc`, and `tsc` is not a linter.** There is no ESLint here,
because adding one is adding a dependency and no ticket has been allowed to —
the same rule that left the React Native CLI out of `apps/student-mobile` and a
migration runner out of `apps/api/db`. What it does catch is real:
`tsconfig.base.json` turns on `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch` and `noUncheckedIndexedAccess`, so an unused
import or a `switch` that falls through already fails. What is missing is style
and habit — import order, `no-console`, React hook dependencies. `docs/ci.md`
says what closing that would take.

**A package is proved before it is pushed.** `scripts/package-api.sh` builds
the zip App Service runs, then starts it and asks it for `/health`. App Service
mounts that zip read-only and installs nothing (EXPD-007 set
`WEBSITE_RUN_FROM_PACKAGE` to 1 and `SCM_DO_BUILD_DURING_DEPLOYMENT` to false),
so the package has to arrive whole — which means no symlinks, because npm links
a workspace into `node_modules` rather than copying it, and a mounted zip will
not resolve one. The script replaces the three `@explorer/*` links with real
directories and fails if a symlink is left anywhere. It also scopes the
production install to `@explorer/api`, so the tree is express and what express
needs rather than `react-native`, which belongs to a workspace with nothing to
do with the API. The result is 1.6 MB.

Both scripts run the same on your own machine, with no Azure and no Vercel
involved:

```bash
scripts/package-api.sh          # build, stage, start it, check /health, zip
scripts/package-web.sh studio   # creator-web | studio | admin
```

**The three React apps are built here and served there.** `deploy-web` uploads
a finished `.vercel/output` and passes `--prebuilt`, so Vercel runs no build of
its own. Vercel building them would be a second build, on a different machine,
from a different install — and the thing that shipped would not be the thing CI
checked.

**A deploy skips itself, loudly, when its environment has no settings.** A
clone of this repository has no Azure subscription and no Vercel project behind
it. A pipeline that went red over that would be reporting on the repository's
settings rather than on its code, so instead the job stays green and the run
summary names every variable and secret that was missing. `docs/ci.md` lists
them, and how the Azure sign-in is federated rather than a stored password.

Five things the pipeline is deliberately not — no infrastructure deployment, no
migrations, no rollback, no gate in front of `dev`, and no check after a deploy
beyond `/health` — are written down at the end of `docs/ci.md` rather than left
to be found.

### The mission type registry

A *mission type* is the kind of task: scan a QR code, take a photo, count the
birds. A *mission instance* (EXPD-002) is one use of a type inside one
expedition. `packages/engine/src/mission-types/` is the one place that maps a
type key and version to three things — the schema its settings have to match,
the rules that check them, and the runtime behaviour that judges a submission.

The reason it exists is what is *not* in it. Nothing in the engine knows what
a QR hunt is. Adding a mission type — EXPD-032 to EXPD-039, or whatever a
creator builds in the Studio — is a call to `register`, not a change to the
engine, and `packages/engine/test/plug-in.test.ts` reads the engine's own
source on every run to keep it that way.

```ts
import { createMissionTypeRegistry } from '@explorer/engine';

const registry = createMissionTypeRegistry([qrHunt, photoEvidence]);

// The check EXPD-002 said only the registry could do.
const result = registry.validateExpedition(definition);
if (!result.valid) {
  // `missions[2].config.codes[0].value`, the same path shape EXPD-002 uses.
  return reply.status(400).send({ issues: result.issues });
}
```

**A mission type is a row, and sometimes also some code.** The half that can
be written down — key, version, name, status, capabilities, the two schemas,
the starting settings — is `MissionTypeDefinition` in
`packages/shared-types/src/mission-type/`, and it is the `mission_type` row
from migration 0001 field for field. It is in `shared-types` rather than the
engine because the Studio, the API, the AI builder and the student app all
read a mission type, and none of them should need the engine to do it.

The half that cannot be written down is `MissionTypeBehaviour`, which is in
the engine. A type built in the Studio (EXPD-025) has no behaviour at all: it
is a row, so it can be configured, stored and checked, but it cannot decide an
attempt and is reviewed by a teacher instead. A behaviour has to be pure, so
that replaying an attempt and simulating a run (EXPD-015) give the same
answer twice.

This ticket defines that slot and nothing more. The registry holds a
behaviour and hands it over; it never calls one. Nor does the state machine
(EXPD-010), which is told the verdict rather than asking for it. The thing
that calls a behaviour is the completion and validation interface (EXPD-011),
and turning an outcome into points is the scoring engine (EXPD-012).

**`config_schema` is a written-down subset of JSON Schema.** Migration 0001
says the column holds a JSON Schema, and "a JSON Schema" is not on its own a
contract the Mission Type Builder can draw a form for. So
`packages/shared-types/src/mission-type/config-schema.ts` lists exactly the
keywords the platform runs — draft 2020-12, twenty-five of them, covering
objects, lists, strings, numbers, `enum` and `const`.

A schema using anything else is **refused, not ignored**, because a mission
type that looks checked and is not is worse than a schema the Studio will not
save. Three things are deliberately outside the subset, each its own piece of
work: `$ref` and `$defs`, the combinators `oneOf`, `anyOf`, `allOf` and `not`,
and `format`. The validator is written by hand and pulls in no library, the
same rule EXPD-002 follows, so the student app can check a config with nothing
installed.

One deviation from JSON Schema is on purpose and worth knowing:
`additionalProperties` defaults to **false**, not true. A mission config is
written in the Studio and generated by the AI builder, and a misspelled field
that is quietly accepted is a mission that does nothing on the day out. A
schema that really holds open-ended data says `additionalProperties: true`.

**A type is checked once, when it is registered.** Both schemas are checked
keyword by keyword, the starting settings are run against the type's own
config schema, the capabilities are checked against the closed list, and the
key and version are checked against the shapes the `mission_type` columns
require. A type that could never work fails when the process starts rather
than on the day a class is standing in a field. Registering a key and version
already held is refused too — the whole reason an expedition pins a version is
that the thing behind it cannot move underneath it.

**There is no shared registry.** The class is instantiated, never reached
through a module-level singleton, because an organisation's own Studio-built
types belong to that organisation alone and because a global is state the
simulation harness could not isolate between runs.

The tests are in `packages/engine/test/` and
`packages/shared-types/test/mission-type/`:

| File                       | What it holds to account                                   |
| -------------------------- | ---------------------------------------------------------- |
| `config-schema.test.ts`    | Every keyword outside the subset, refused and named.        |
| `validate-config.test.ts`  | A value against a schema, and where a problem is reported.  |
| `definition.test.ts`       | What a mission type has to be before it can be registered.  |
| `registry.test.ts`         | Holding types, versions, and what it will not hold.         |
| `registry-validation.test.ts` | Missions and whole expeditions against their types.      |
| `plug-in.test.ts`          | That a new type needs no engine change, by reading the source. |

Two limits are worth knowing:

1. A `pattern` is compiled from whatever the mission type author wrote, and a
   regular expression can be written that takes a very long time on a crafted
   input. That is a creator holding up their own organisation's Studio rather
   than a student reaching anything, so the platform compiles what it is given.
2. Nothing loads a mission type from the database yet, because nothing opens a
   connection. The registry takes types from whoever builds it, and
   the row shape is already the shape it takes, so reading them is a query and
   a loop rather than a translation.

### The mission state machine

A *mission instance* (EXPD-002) is one task placed in one expedition. While a
class plays, every team has its own view of every mission, and that view is
one of eight words. `packages/engine/src/mission-state/` is the one place a
mission moves between them.

```text
  locked  ──unlock──▶  available          available  ──relock──▶  locked
  available  ──start──▶  in-progress
  in-progress  ──submit──▶  submitted     in-progress  ──expire──▶  failed
  submitted  ──accept──▶  complete
  submitted  ──refer──▶  awaiting-verification
  submitted  ──reject──▶  available, or failed on the last try
  awaiting-verification  ──verify──▶  complete
  awaiting-verification  ──overrule──▶  available, or failed on the last try
  available, in-progress  ──skip──▶  skipped
```

```ts
import {
  applyMissionTransition,
  createMissionProgress,
  missionStatePolicyFor,
} from '@explorer/engine';

let progress = createMissionProgress(mission.id);
const policy = missionStatePolicyFor(mission, definition.rules);

const result = applyMissionTransition(
  progress,
  { trigger: 'unlock', actor: 'engine', at: now },
  policy,
);
if (result.applied) {
  progress = result.progress;      // a new record; the old one is untouched
} else {
  // `wrong-state`, `terminal-state`, `no-attempts-left`, `skip-not-allowed`
  // or `unknown-trigger`, with a sentence saying which.
  return reply.status(409).send({ refusal: result.refusal });
}
```

**Every change is a named trigger, and there is one table.** Eleven triggers,
written out as data in `table.ts`, and the machine is a walk over it. Nothing
else in the engine writes a mission state, there is no `switch` that grows a
case, and no branch nudges a mission somewhere nobody decided it should go.
`table.test.ts` writes out all eighty-eight state-and-trigger pairs — eight
states by eleven triggers — and checks every one, so an edge added without a
decision behind it fails a test.

**The machine decides nothing.** It is *told* that a submission was right
(`accept`), that a person has to look (`refer`), that an unlock condition
holds (`unlock`), that a clock ran out (`expire`). Judging a submission is the
mission type's behaviour (EXPD-009) through the completion interface
(EXPD-011), working out that a condition holds is EXPD-013, and what any of it
is worth is EXPD-012. Keeping those out is what lets this be a table.

**Every change is written down, and the log is the record.** A change appends
one `MissionTransition`: from, to, trigger, actor, when, which try, and an
optional reason and detail. `replayMissionTransitions` hands a stored history
back to the rules and either lands where the mission was left or names the
line it disagrees with — a line starting somewhere the mission was not, a line
the rules would have refused, or a line that ended somewhere they would not
have put it. That is what makes a team's `failed` mission something anybody
can check rather than something they have to trust. A refused transition is
*not* logged, because it is not something that happened to the mission.

**Refusals are answers, not failures.** Two phones on one team both press
submit, a teacher reviews a queue a team has already moved on from, a
submission queued offline (EXPD-048) arrives after the mission timed out. All
of those are a team playing normally, so `applyMissionTransition` returns a
refusal and changes nothing. `requireMissionTransition` throws instead, for a
caller that has already checked — the same pairing as `get` and `require` on
the registry. `allowedMissionTriggers` is what the student app draws its
buttons from, so a team is never shown one the rules would refuse.

**Two settings bend the machine, and nothing else does.**
`MissionInstance.attempts.maxAttempts` decides whether a wrong answer hands
the mission back or ends it, and `ExpeditionRules.allowSkip` decides whether a
team may walk away. `missionStatePolicyFor` reads both off the documents.
Everything else stays out: `cooldownSeconds` and `timeLimitSeconds` are
clocks, and the engine holds no clock — whoever owns the clock applies `start`
or `expire` when it is time. Nothing here reads `Date.now()`, because a
machine that does cannot be replayed.

**These are mission states, not attempt states.** `mission_attempt.status` in
migration 0001 tracks one try; a team that got a puzzle wrong twice has two
attempt rows and one mission state. Writing either is EXPD-020's, once
anything opens a database connection.

The words — the eight states, the eleven triggers, the shape of a logged line
— are in `packages/shared-types/src/mission-state/` rather than the engine,
the same split the registry makes and for the same reason: the mission board
(EXPD-042) draws a badge from a mission state on every screen, and
`apps/student-mobile` depends on `@explorer/shared-types` alone.

The tests are in `packages/engine/test/mission-state/` and
`packages/shared-types/test/mission-state/`:

| File                  | What it holds to account                                      |
| --------------------- | ------------------------------------------------------------- |
| `vocabulary.test.ts`  | The eight states and eleven triggers, and nothing else.        |
| `table.test.ts`       | All eighty-eight state-and-trigger pairs, one by one.          |
| `machine.test.ts`     | A mission played end to end, and what a refusal leaves behind. |
| `attempts.test.ts`    | Counting tries, and what the last one being wrong means.       |
| `log.test.ts`         | What a history holds, and replaying a tampered one.            |
| `policy.test.ts`      | Skipping, attempt limits, and where both are read from.        |

Three things are deliberately not in the machine:

1. **No edge out of `complete`, `failed` or `skipped`.** Putting a team back
   into a mission a teacher has closed is a live override (EXPD-058), which
   can add its own trigger and say in the log that a person did it.
2. **No way back out of `in-progress` but finishing, timing out or skipping.**
   A team that opens a mission and wanders off has used a try; handing it back
   would make `max_attempts` mean nothing.
3. **Nothing knows which team it is about.** A record is one mission for one
   team, and whatever stores it already knows whose it is. Repeating the team
   id inside would be a second place for it to be wrong.

### The completion and validation interface

A mission is completed in one of six ways: a scanned code matched, a photo was
handed in, a teacher approved the work, an answer was right, a place was
reached, or a clock ran out. `packages/engine/src/completion/` is the one door
all six come through.

```ts
import {
  completeMission,
  missionCompletionPolicyFor,
  missionStatePolicyFor,
} from '@explorer/engine';

const result = completeMission({
  kind: 'submission',
  registry,
  mission,
  progress,
  payload: { scanned: 'EXPD-7742' },
  position,
  at: now,
  completionPolicy: missionCompletionPolicyFor(mission, definition.rules),
  statePolicy: missionStatePolicyFor(mission, definition.rules),
});

if (result.applied) {
  progress = result.progress;   // a new record; the old one is untouched
  send(result.verdict);         // what to show the team
} else {
  // `not-now`, `unknown-mission-type`, `invalid-submission`, `wrong-place`,
  // `poor-accuracy` or `not-yet-expired`, with a sentence saying which.
  return reply.status(409).send({ refusal: result.refusal });
}
```

**The six are not six branches.** A matched code and a right answer are both a
mission type's behaviour (EXPD-009) answering `correct`; the engine cannot tell
them apart and has no reason to. A photo is that same behaviour saying it
cannot decide, or an author saying up front that a person will. A place reached
is the one check the engine owns itself, because a `LocationConstraint` is on
the mission rather than inside the mission type's settings. A teacher's
approval is a person's decision arriving on its own, and a clock running out is
the one thing that finishes a mission with nothing handed in at all.

So there are three ways in — `kind: 'submission'`, `'review'`, `'expiry'` — and
one way out. Whatever went in, what comes back is a `CompletionVerdict`: what
was concluded (`correct`, `incorrect`, `needs-review`, `expired`), what
concluded it (`behaviour`, `location`, `teacher`, `timer`, `referral`), the
trigger that became, and whether a person still has to look.

**It decides, and the state machine moves.** Every verdict is handed to
`applyMissionTransition` (EXPD-010), so there is still exactly one place a
mission state changes and one table that says what may change it. A submission
writes two lines in the mission's history — the team handing work in, and the
verdict on it — and a decision or an expiry writes one. Every line is one the
state machine made, so the history a check leaves behind is one that replays.

**A refusal is not a wrong answer, and the difference matters.** A wrong answer
is a try spent and something the scoring engine (EXPD-012) may take points for.
Work handed in from the wrong end of the park is neither: it is refused, judged
by nobody, and the team may hand it in again when they arrive. The state
machine is asked before anything else, so a second tap on submit and a
submission queued offline (EXPD-048) that arrives after the mission timed out
are both answered before a mission type is looked up and before any of the
author's code runs.

**Who judges, and in what order.** Four rules, tried in this order:

1. The mission says a person decides, so nothing here does. A mission type's
   code is not run at all in that case — the author said the answer is a
   judgement call, and a second opinion nobody will use only clutters the log.
   `ExpeditionRules.submissions.requireReviewForAll` turns this on for a whole
   expedition, and it only ever adds review: nothing takes away a review a
   mission asked for.
2. The mission type has code, so it judges.
3. It has none, and the team reached the place the mission names, so that was
   the mission. This is what makes "location reached" a way to finish one.
4. It has none and there was no place either, so a person decides (EXPD-037).
   A type built in the Studio (EXPD-025) is a row and nothing more, and a row
   cannot judge anything.

**A mission type with a bug in it does not fail the team.** A behaviour that
throws, or that answers with something that is not an outcome, sends the
submission to the teacher and says why in the mission's history. The team is
told nothing about it, and the class carries on.

**The engine still holds no clock.** `timer.ts` does arithmetic on times a
caller passed in and never reads `Date.now()`, for the reason EXPD-010 gives.
What it is for is the mistake at the other end: a timer can fire early, and a
mission put into `failed` with time still on it is not something a team can
argue with afterwards. So `missionDeadline` works out when a running try is
actually up — from the mission's `timeLimitSeconds` and the `at` of the `start`
in its own history — and an `expire` that has not come due is refused, with the
real deadline in the refusal so whoever holds the clock can set it again.

**Four settings, two documents, one place to read them.**
`missionCompletionPolicyFor` gathers `verification`, `timeLimitSeconds` and
`location` off the mission and `requireReviewForAll` off the expedition, the
same way `missionStatePolicyFor` gathers its own two. The interface reads those
and never the mission, so no setting is readable from two places. Everything
else stays out: `cooldownSeconds` is a clock in front of `start`, `latePolicy`
is about the expedition's clock rather than a mission's and belongs with the
session (EXPD-019), and `scoring` is EXPD-012's.

The words a verdict is said in are in
`packages/shared-types/src/completion/`, the same split the registry and the
state machine make, because the student app shows a verdict on the screen a
team is looking at while they wait.

The tests are in `packages/engine/test/completion/` and
`packages/shared-types/test/completion/`:

| File                    | What it holds to account                                      |
| ----------------------- | ------------------------------------------------------------- |
| `vocabulary.test.ts`    | The four outcomes, five methods and six refusals, and no more. |
| `methods.test.ts`       | All six ways to complete a mission, one by one.                |
| `refusals.test.ts`      | Work that is not checked, and that it leaves nothing behind.   |
| `location.test.ts`      | The distance, and what a reading nobody can trust costs.       |
| `timer.test.ts`         | When a running try is up, read off the mission's own history.  |
| `policy.test.ts`        | Which document each of the four settings is read from.         |

Three limits are worth knowing:

1. **A reported position is not a fix the platform trusts.** A phone can be
   told to report any position at all, so a mission whose whole answer is a
   place is one a determined student can pass from the bus. Closing that is a
   product decision no ticket has made.
2. **`automatic-with-review` moves the mission and marks the work.** The team
   is told straight away and the submission is put in front of a teacher
   anyway, as `review: 'optional'`. A teacher who then disagrees is changing a
   mission that has already finished, which is a live override (EXPD-058),
   because the state machine has no edge out of a finished mission.
3. **Nothing calls this yet.** The mission attempt and submission endpoints
   (EXPD-020) are what will, once something opens a database connection.
   What a verdict is worth is EXPD-012, and what a completed
   mission unlocks is EXPD-013; both read what this produces rather than
   producing it again.

### The scoring engine

A verdict says what a team did. This says what it was worth.
`packages/engine/src/scoring/` turns one thing that happened into points and
writes down every change it makes, so a team's total is never a number
somebody has to trust.

```ts
import {
  applyScoreChange,
  createTeamScore,
  expeditionScoringPolicyFor,
  missionScoringPolicyFor,
} from '@explorer/engine';

let score = createTeamScore();

const result = applyScoreChange({
  kind: 'mission',
  score,
  verdict: completion.verdict,        // what EXPD-011 concluded
  progress: completion.progress,      // and where it left the mission
  mission: missionScoringPolicyFor(mission),
  scoring: expeditionScoringPolicyFor(definition),
  at: now,
});

if (result.applied) {
  score = result.score;               // a new record; the old one is untouched
  store(result.events);               // every change, and why
} else {
  // `not-decided`, `already-scored` or `hint-already-spent`.
  return reply.status(409).send({ refusal: result.refusal });
}
```

**Every score change writes a `ScoreEvent`, by construction rather than by
everybody remembering.** There is one function in the engine that can move a
total — `award` in `ledger.ts` — and it writes the line at the moment it moves
it. Nothing else adds a number to a score. Adding up a team's events gives
their total back exactly, which is what migration 0001 already says of the two
columns: `score_event` is the record and `team.total_score` is a total kept
alongside it for speed. `createTeamScore` will not take an opening total for
the same reason — a team rebuilt part way through a run is rebuilt from its
events, because a total that did not come from the stream behind it is a total
nobody can check.

**Three things move a score, and there is one door.** A mission was judged, a
team spent a token on a hint, or a teacher moved the score by hand (EXPD-058).
`applyScoreChange` takes any of the three and answers the same way the
completion interface does: a new record and the lines that got it there, or a
refusal and a record that has not moved.

**What a mission earns, in the order it is worked out.** Base points first,
from `MissionScoring.basePoints`, or a share of them when the mission allows
partial credit and the mission type said how much of it was done — that share
is the accuracy of the answer, and `partial-credit` is the reason written
down. Then every rule in `ScoringConfig.rules`, in the order the document
lists them:

| Rule                     | Fires when                                                    |
| ------------------------ | ------------------------------------------------------------- |
| `speed-bonus`            | The mission was finished inside `withinSeconds`.              |
| `first-to-complete-bonus`| The caller says this team got there first.                    |
| `streak-bonus`           | The run of right answers reached `length`, and every multiple. |
| `completion-bonus`       | The last mission the rule names was finished.                  |
| `hint-penalty`           | A hint was opened. Charged then, not at the end.               |
| `attempt-penalty`        | The answer was wrong.                                          |
| `late-penalty`           | A finished mission was handed in past the expedition's clock.  |

The order is part of the answer rather than a detail of how rules are stored.
A mission's `maxPoints` cap applies to whatever that mission has added up to
by the time each rule fires, so a bonus listed first can take the room a later
one wanted. The expedition's `minimumTotal` is the floor: a penalty that would
go under it takes the team to the floor and no further. An award either limit
trims is written down as **what it actually moved**, with a `limit` saying
what it would have been — writing down the untrimmed figure would make a
stream that no longer adds up to the total, and a stream that does not add up
is not a record of anything.

**It is told, the same way the state machine is.** Whether this team was the
first to finish a mission is a fact about every other team, and how late work
was is a fact about the expedition's clock (EXPD-019). The engine holds
neither, so both arrive on the request. How long a team took is the one it
works out for itself, off the `start` in the mission's own history — the same
line `timer.ts` reads — and a caller replaying stored rows can pass
`tookSeconds` instead.

**Two settings, two documents, one place to read each.**
`missionScoringPolicyFor` gathers what one mission is worth off the mission,
and `expeditionScoringPolicyFor` gathers the rules, the floor and the list of
missions off the definition. It takes the whole definition because `target:
{ kind: 'all' }` means every mission in the expedition, and that list is
`definition.missions`. `leaderboard` stays out: how a score is shown and how
two equal ones are separated is EXPD-022 and EXPD-045, not how either was
earned.

**A refusal is not a change worth nothing.** A second verdict on a mission
already finished, a hint charged for twice, a mission still waiting on a
teacher — all three are refused, and none of them moves a total or a count. A
wrong answer on an expedition with no `attempt-penalty` rule is different: it
costs nothing, writes nothing, and still breaks the team's streak, so it is
applied with an empty list of events.

The words a score is said in are in `packages/shared-types/src/scoring/`, the
same split the registry, the state machine and the completion interface make,
because the live score screen (EXPD-045) shows a total on a phone. The ten
reasons there are the `score_event_reason` enum from migration 0001 value for
value, and a test holds them to it: a reason the engine can say and the column
cannot hold is a run that fails at the moment a team scores.

The tests are in `packages/engine/test/scoring/` and
`packages/shared-types/test/scoring/`:

| File                  | What it holds to account                                      |
| --------------------- | ------------------------------------------------------------- |
| `vocabulary.test.ts`  | The ten reasons, against the column and against the rules.     |
| `base.test.ts`        | Base points, partial credit, and the cap and floor around them. |
| `bonuses.test.ts`     | The four rules that add points, and when they do not.          |
| `penalties.test.ts`   | The three that take them away, and what a hint costs.          |
| `record.test.ts`      | That a total is always the sum of the stream behind it.        |
| `policy.test.ts`      | Which document each setting is read from.                      |

Four limits are worth knowing:

1. **A score that did not move writes nothing.** A cap that eats a bonus
   whole, a penalty on a team already at the floor, a mission worth nought
   points: none of them is a score change, so none is a score event. What a
   team is shown about a cap they hit is a screen (EXPD-045) rather than a
   line in the record.
2. **The running counts are not all in the stream.** The total is, exactly.
   The streak, the wrong answers and the hints spent are not, because an
   answer that cost a team nothing still breaks a streak. They are rebuilt by
   replaying the game rather than the score, and stored beside the total.
3. **`hint-penalty` charges per hint, not per token.** `HintDefinition.tokenCost`
   is how many tokens a hint costs, which is EXPD-046's inventory;
   `pointsPerHint` is what opening one costs in points, which is this. A hint
   is counted as spent whether or not a rule charged for it, because the
   `fewest-hints-used` tie break counts hints.
4. **Nothing calls this yet.** The mission attempt and submission endpoints
   (EXPD-020) are what will, once something opens a database connection.
   Carrying the stream across the system — storing it, ordering
   it, proving nothing edited it — is EXPD-014, below, and this is the value
   that stream is made of.

### Progression and unlock evaluation

The graph says how an expedition is laid out for everybody. This says what it
comes to for one team. `packages/engine/src/progression/` works out where a
team has got to, which missions the lock is off, which ones they are shown at
all, and what is holding the rest up.

```ts
import {
  evaluateProgression,
  progressionPolicyFor,
  teamSituation,
} from '@explorer/engine';

const snapshot = evaluateProgression({
  policy: progressionPolicyFor(definition),
  situation: teamSituation({
    missions: progressByMission,   // where EXPD-010 says the team stands
    score,                         // what EXPD-012 says they have earned
    elapsedSeconds,                // the session's clock (EXPD-019)
    routeIds: team.routeIds,       // the route the team was put on
  }),
});

snapshot.unlockedMissionIds;       // what the mission board may offer
snapshot.visibleMissionIds;        // what it may show at all
snapshot.finished;                 // whether they have reached a finish
```

**Reaching a stop and clearing it are two different things.** A team reaches a
stop when an edge lets them through to it. They clear it when they have done
what it asks, and that is what opens the stops after it. A start or a
checkpoint is cleared the moment it is reached. A mission stop is cleared once
its mission is over — finished, failed or skipped — or at once when the author
marked it optional. A team with no tries left on a puzzle has finished with
that puzzle, and an expedition that left them standing in front of it for the
rest of the afternoon would be a bug rather than a rule. But only a mission
that was `complete` counts towards a `mission-completed` condition, so giving
up on one never unlocks what finishing it would have.

**The whole answer is worked out again every time it is asked.** Nothing is
remembered between calls and nothing is stored, so a snapshot cannot drift
from the records behind it, and a team rebuilt from stored rows (EXPD-020)
lands on exactly the snapshot they had. It is told the things it has no right
to know, the same way the scoring engine is told whether a team finished
first: where the team stands on each mission is EXPD-010's record, what they
have earned is EXPD-012's, the clock is the session's (EXPD-019), and the
route they are on was decided when teams were made (EXPD-018).

**What the nine unlock conditions read.**

| Condition                     | Holds when                                                   |
| ----------------------------- | ------------------------------------------------------------ |
| `always`                      | Always. The same as leaving the condition out.                |
| `mission-completed`           | That mission is `complete`. Failed and skipped do not count.  |
| `mission-score-at-least`      | The events naming that mission add up to the points.          |
| `total-score-at-least`        | The team's total is at or above the points.                   |
| `missions-completed-at-least` | Enough of the listed missions are `complete`, each counted once. |
| `elapsed-time-at-least`       | The team has been playing that long.                          |
| `all-of`                      | Every condition inside holds. An empty group holds.           |
| `any-of`                      | One condition inside holds. An empty group does not.          |
| `not`                         | The condition inside does not.                                |

**Three things the author says, and what each one does.**

1. **Optional** says a team may walk past a mission without finishing it. Its
   stop is cleared the moment they arrive, so nothing behind it waits on them,
   and in `strict` it is never in the queue — a side quest that held up the
   main line would be holding the team up, which is the one thing optional
   says it never does. It is not `allowSkip`: that is a team giving up on a
   mission that was in their way, and this is the author saying it never was.
2. **Secret** says the team is not told the mission is there. A secret mission
   is off the board while it is locked and on it from the moment the team
   reaches it, and it stays. It changes what a team is shown and never what
   unlocks, so a secret mission with nothing in front of it is visible from
   the start.
3. **A route** says which teams an edge is for. One graph holds both halves of
   a class: the walkers go round the lake, the cyclists over the hill, and
   both come back to the same finish. A route is not a condition — a team
   cannot play their way onto one — so a stop down somebody else's route comes
   back `offRoute` rather than locked, and nothing they do will change it.

**The three progression modes hand out different amounts.** `strict` opens one
required mission at a time, in the order the document lists the stops, because
that order is the author's and is the same for every team and every replay.
`open` opens everything the graph has opened. `free-roam` opens the lot: the
rules say edges and their conditions are ignored, and a route is carried on an
edge, so ignoring edges ignores routes and secrets with them. An author who
wants either of those wants `open`.

**A snapshot says what is in the way, not just that something is.** Every stop
carries the edges leading into it that did not let the team through, each with
one of three reasons: `not-cleared` when the stop before it is unfinished,
`condition` when the edge's condition does not hold yet, and `off-route` when
the edge is for routes this team is not on. That is what lets a mission board
say "finish the museum first" rather than drawing a padlock and nothing else.

`missionsRequiredBefore` asks the same question of the document with no team
in it: what stands immediately in front of this mission, whether it got there
by being the stop before or by being named in a condition. It is one step
back, not the whole way — whether an expedition can be finished at all is the
simulation harness's question (EXPD-015).

The words a snapshot is said in are in
`packages/shared-types/src/progression/`, the same split the registry, the
state machine, the completion interface and the scoring engine make, because
the mission board (EXPD-042) draws a locked mission on a phone.

The tests are in `packages/engine/test/progression/` and
`packages/shared-types/test/progression/`:

| File                          | What it holds to account                                   |
| ----------------------------- | ---------------------------------------------------------- |
| `conditions.test.ts`          | The nine conditions, one at a time.                         |
| `unlock.test.ts`              | The walk, and what it says is in the way.                   |
| `optional-and-secret.test.ts` | That each of the two does only its own job.                 |
| `routes.test.ts`              | One graph, two ways through it.                             |
| `modes.test.ts`               | What each of the three modes hands out.                     |
| `dependencies.test.ts`        | What stands in front of a mission, with no team in it.      |
| `policy.test.ts`              | Which document each setting is read from.                   |
| `vocabulary.test.ts`          | The three block reasons, and the readers over a snapshot.   |

Four limits are worth knowing:

1. **It does not say a team may press start.** The lock being off is the
   graph's answer. How many tries are left, whether a cooldown is running and
   whether a submission is sitting with a teacher are the state machine's
   (EXPD-010), and the completion interface (EXPD-011) is what judges the work.
2. **Nothing moves a team along.** A snapshot is a reading, not a step. What
   writes a mission state is the state machine, and what tells a team their
   world changed is the realtime channel (EXPD-023).
3. **The database does not hold the new fields yet.** `optional` and `secret`
   live in `expedition_version.definition`, which is the source of truth, and
   the flat `mission_node` copy has no column for them; `team` has no route
   column either. Writing the flat copy is EXPD-017 and putting a team on a
   route is EXPD-018, so the columns are theirs to add.
4. **Nothing calls this yet.** The mission board (EXPD-042) and the attempt
   endpoints (EXPD-020) are what will, once something opens a database
   connection.

### The auditable event stream

A score event says what a team earned. A progression event says what they were
allowed to do. Neither says when it happened relative to the other, and
neither says it was not added afterwards. `packages/engine/src/stream/`
carries both as one numbered, sealed record, so that any final result can be
rebuilt from the record by anybody and argued with line by line.

```ts
import {
  appendProgressionEvents,
  appendScoreEvents,
  openStream,
  progressionEventsBetween,
  replayStream,
  verifyStream,
} from '@explorer/engine';

let stream = openStream();

const scored = applyScoreChange({ kind: 'mission', ... });   // EXPD-012
if (scored.applied) {
  stream = appendScoreEvents(stream, scored.events);
}

stream = appendProgressionEvents(                            // EXPD-013
  stream,
  progressionEventsBetween(before, after, now),
);

const check = verifyStream(stream, { expectedTotal: team.totalScore });
const result = replayStream(stream);      // the 340, and where it came from
```

**One stream per team, and one number line through it.** The two kinds of
event share the numbering rather than each keeping their own, because a final
result is an argument about order as much as about arithmetic: a bonus awarded
for finishing a mission the team was never shown is a different complaint from
one awarded a second too late, and only one numbering can tell them apart.
`sequence` starts at 1 and never skips. Ordering by a timestamp would not do:
two lines can share a millisecond, a clock can step backwards, and a
submission queued offline (EXPD-048) is stamped an hour before the line that
follows it.

**Each line seals the one before it.** `hash` is SHA-256 over the line's own
contents *and* `previousHash`, so a line cannot be changed, removed, reordered
or slipped in without every hash after it disagreeing. The seal is over the
number as well as the contents, so a line moved from place 9 to place 4 seals
differently even though not one character of the event changed.

The hash is written out in `hash.ts` rather than taken from anywhere, because
the engine has no dependencies and may not grow one. `node:crypto` would have
needed `@types/node` on the package to typecheck, which is a dependency, and
would have made the engine Node-only — while a results screen checking a total
in a browser is exactly the use this record is for. It is FIPS 180-4 as
published, and `hash.test.ts` holds it to the published vectors rather than to
itself: a hash that is self-consistent and wrong would pass every other test
here and be worthless the first time somebody checked it with another tool.

**Progression events are new, and they are the other half of a result.** A
`ProgressionSnapshot` (EXPD-013) answers "where does this team stand" and
answers it from scratch every time, against today's document and today's
clock. It cannot answer "the app never showed us mission four", which is the
dispute teams actually have. So whoever moves a team compares the snapshot
before with the snapshot after, and `progressionEventsBetween` writes down
what changed. Five reasons: `node-reached`, `node-cleared`, `mission-unlocked`,
`mission-revealed`, `expedition-finished`. Only doors that *opened* are written
down — a mission relocked in `strict` mode because it is somebody else's turn
is not something anybody disputes.

**A stream can be checked, and the check says where.** `verifyStream` reports
every defect it finds, each naming a line, rather than stopping at the first:
`out-of-order`, `broken-chain`, `edited`, and `total-disagrees` when a check
was given a total to hold the stream to. "Line 14 does not match its own seal"
is an answer somebody can act on, and "the stream is invalid" is not. An
edited line is reported once rather than as an avalanche, because the chain is
followed by the seal each line carries rather than by the seal its contents
come to.

**A result is rebuilt from the stream and nothing else.** No expedition
document, no scoring rule, no other team, no clock. `replayStream` gives the
total, what each of the ten reasons was worth, what each mission came to, the
stops reached and cleared, the missions unlocked and revealed, and whether the
team finished. `replayTeamScore` gives back the `TeamScore` that
`applyScoreChange` takes, which is what EXPD-020 will use to pick a run up
part way through — the total exact, and the streak, failed attempts and hints
spent at nought, because those were never in the stream and rebuilding them
means replaying the game rather than the score.

It reads the record; it does not re-judge it. Whether a `speed-bonus` of 25
should have been awarded at all is a question about the rules, and running the
rules over a run again is the simulation harness (EXPD-015).

#### Where it is stored

`0004_auditable_event_stream.sql` is the half of the ticket the database
keeps. It creates `progression_event`, adds `stream_sequence`,
`previous_hash` and `hash` to it and to `score_event`, puts the head of the
chain on `team` in `stream_length` and `stream_head_hash` beside
`total_score`, and attaches to both tables the same triggers 0003 wrote for
`audit_log` — which is what 0003 said it was leaving them for:

```
UPDATE score_event SET points = 500;
ERROR:  score_event is append-only: UPDATE is not allowed on it
HINT:  Correct a wrong entry by appending another entry that says so.
```

It also adds four columns `score_event` was missing, and they are not a tidy
up. The seal is taken over the engine's event, which names a mission and a
hint by the ids the *definition document* uses while `score_event` named both
by the uuid of a row in another table — so a reader checking a seal would have
had to join to `mission_instance` and `hint`, and a line about a mission since
deleted could not have been checked at all. `mission_instance_key` and
`hint_key` are those ids, the way `scoring_rule_key` already was;
`attempt_number` is which try it was; and `limit_kind` with
`limit_would_have_been` is what a cap or a floor trimmed, which the record
could not say before and which is precisely the conversation a cap causes.
The keys are the record and the uuids are the join, so a line may carry a key
alone and never a uuid alone.

`apps/api/src/stream/` carries it. `TeamStream` takes the team row
`FOR UPDATE`, reads the head, seals, inserts and writes the head back, all in
one transaction — which is what makes the numbering hold when two phones
submit at once, and why it refuses to write outside a transaction at all.
There is no method on it that changes a line and none that removes one, the
same way there is none on `AuditLog`.

`score_event` loses its foreign keys, all nine, the way `audit_log` lost its
three. Three were `ON DELETE CASCADE`, which is a `DELETE` the database itself
runs and the rule above would refuse. A team's result is disputed after the
afternoon is over and sometimes after the session has been tidied away, so a
line outliving the rows it names is the behaviour wanted rather than the price
of one. `organisation_id` still scopes every read, because the repository
layer keys off the column and not off a constraint.

`live_event` stays out of all of it. It is the realtime channel's replay
buffer (EXPD-023) rather than a record anything is decided by.

#### The tests

| File | What it holds to account |
| ---- | ------------------------- |
| `packages/shared-types/test/stream/vocabulary.test.ts` | The five progression reasons against the column, and the four defect codes. |
| `packages/engine/test/stream/hash.test.ts` | That the seal is SHA-256 as published, and that the same line always becomes the same bytes. |
| `packages/engine/test/stream/chain.test.ts` | Editing, removing, inserting, reordering and resealing a stream — each caught, each named. |
| `packages/engine/test/stream/replay.test.ts` | That a result is rebuilt from the stream alone, and stops where the stream stops. |
| `packages/engine/test/stream/progression-events.test.ts` | That every door that opened is written once, in the order it opened. |
| `apps/api/test/stream/round-trip.test.ts` | That a stored line is the line that was sealed, field by awkward field. |
| `apps/api/test/stream/team-stream.test.ts` | One number line across two tables, the lock, the head on `team`, and the absent methods. |

Three limits are worth knowing:

1. **The seal is not a signature.** It proves nobody edited the stream *in
   place*, which is what a wrong total looks like. It does not prove who wrote
   it, and somebody able to rewrite every row from a given line onwards could
   reseal the lot. Two things already stand in the way, and both are
   elsewhere: the tables take an `INSERT` and nothing else, and `audit_log`
   (EXPD-006) records who touched what.
2. **The running counts are still not in the stream.** The total is, exactly.
   The streak, the wrong answers and the hints spent are not, for the reason
   `TeamScore` gives, so a replay hands them back at nought.
3. **Nothing stores this yet.** The attempt and submission endpoints
   (EXPD-020) are what will write a line, once something opens a database
   connection. The simulation harness (EXPD-015) already produces
   whole runs to seal, and `packages/engine/test/simulation/stream.test.ts` is
   what holds the claims above to a real afternoon of play rather than to
   events a test wrote by hand.

### The simulation harness

`packages/engine/src/simulation/` plays a whole expedition with fake teams and
says what happened. It is the first thing in the engine that *uses* the engine
rather than being part of it: it owns a clock and a random number, and it has
them so that nothing else has to.

```ts
import { simulateExpedition } from '@explorer/engine';

const report = simulateExpedition({ definition, teamCount: 5, seed: 'the-lake' });

if (!report.playable) {
  return report.findings.filter((finding) => finding.severity === 'error');
}

report.duration.medianSeconds;    // how long an afternoon of this takes
report.teams[0]?.stream;          // the sealed record, to verify and replay
```

Three callers want three halves of the same answer. A **test** wants the
per-team detail and the stream. An **author** wants `duration`. The **AI
builder's validation step** (EXPD-066) wants `findings`: the short list of
things that would go wrong on the day.

**It plays the game through the engine's own doors and no others.** Every
mission state comes out of `applyMissionTransition` (EXPD-010), every verdict
out of `completeMission` (EXPD-011), every point out of `applyScoreChange`
(EXPD-012), every locked door out of `evaluateProgression` (EXPD-013), and
every line out of the stream's own sealer (EXPD-014). Nothing in the harness
decides a game rule, so a run cannot pass where the platform would fail —
which is the only reason a test would trust one.

**The same seed gives the same run, down to the last timestamp.** Nothing
reads `Date.now()` or `Math.random`. The clock is a number of seconds the
harness moves forward itself, and the generator is mulberry32 written out in
`random.ts` for the same reason SHA-256 is written out next door: the engine
has no dependencies and may not grow one. Each team's generator is seeded from
the run's seed and the team's own id, so adding a fourth team does not change
what the first three did.

**Teams are played in step, by the simulated clock.** At each turn the team
furthest behind on its own clock moves. That buys the one thing running them
one after another could not: `first-to-complete-bonus` means what it says,
because whoever reaches a mission first in simulated time reaches it first in
the run.

#### The fake teams

A team is six dials and a route, in `teams.ts`. `skill` is how often they get
a mission right, rolled once per attempt; `paceSeconds` and `travelSeconds`
are how long they take thinking and walking; `givesUp` is how often they walk
away from a mission the rules let them walk away from; `usesHints` is how
often they open a hint first. `simulatedTeams(5)` builds a class spread from
quick and able to slow and struggling, dealing out the expedition's routes one
team at a time, so the commonest use of the harness is a number rather than a
list of objects.

The numbers behind the middling team are a starting point an author can argue
with rather than a claim about real classes. Every one of them is a dial.

#### How work is judged

The harness cannot know the answer to a mission. A hunt's codes are in its
config and only the mission type knows which field is which — that is what the
registry exists to prevent anybody unpicking. So there are two ways to judge a
run, and `judging` picks one.

`scripted` is the default, and it is what lets an expedition be played before
anybody has built a mission type for it. The harness builds a **stand-in
registry**: one type per `key@version` the document names, whose behaviour
reads the intended outcome straight out of the submission. The run then goes
through `completeMission` exactly as it would on the day — the attempt is
counted, the location is checked, the teacher review still happens, the
mission's own clock still runs — and nothing anywhere has a second opinion
about what `correct` means. The obvious alternative, letting the harness move
the mission itself, would have put a second copy of the outcome-to-trigger
mapping in the engine, which is the one thing EXPD-011 exists to prevent.

`behaviour` is what a test of a real mission type wants. The registry's own
code judges, and a **player** per mission type key writes the payload a team
hands in. A key with no player falls back to a payload built from the type's
own submission schema, which is the right shape and almost never the right
answer — so the report says `sampled-mission-type` rather than leaving a
reader to conclude the expedition is unwinnable.

#### What comes back

`SimulationReport` holds three things.

`teams` is the per-team detail: where every mission ended, how many tries it
took, what it earned, the `MissionProgress` records, the `TeamScore`, the
final `ProgressionSnapshot`, and the sealed stream.

`duration` is built only from the teams that reached a finish — shortest,
longest, median and mean — plus `unfinishedSeconds`, so an expedition nobody
finished still says something about its own length.

`findings` is the advice, worst first. An **error** means the expedition
cannot be played as written: no start, no finish, a mission type no registry
could hold, a mission teams finished the expedition without ever reaching, or
not one team finishing at all. A **warning** means it can be played and
something probably is not what the author meant: a mission everybody reached
and nobody finished, a checkpoint hanging off the graph, a team left with
nowhere to go. A **note** is about the run rather than the expedition.

A finding is evidence, not a proof. A mission nobody reached is only an error
once some team walked the expedition to its end — teams that gave up half way
never got near the far side, and calling that a broken edge would send an
author looking for something that is not there.

#### The tests

| File | What it holds to account |
| ---- | ------------------------- |
| `packages/engine/test/simulation/parts.test.ts` | The clock, the generator, the class of teams and the schema sampler, on their own. |
| `packages/engine/test/simulation/determinism.test.ts` | That the same seed replays exactly, and that one team's luck does not depend on how many others are playing. |
| `packages/engine/test/simulation/run.test.ts` | That a run really plays the game: modes, routes, timers, attempts, skipping, review, and what the scoring rules pay. |
| `packages/engine/test/simulation/findings.test.ts` | One broken expedition per test, and what the run noticed about it. |
| `packages/engine/test/simulation/duration.test.ts` | That the estimate moves when the expedition does, and is built from the teams that finished. |
| `packages/engine/test/simulation/judging.test.ts` | Both ways of judging, and that the stand-ins and the real behaviours go through the same door. |
| `packages/engine/test/simulation/stream.test.ts` | A whole run's record, verified and replayed the way an outsider would. |

Three limits are worth knowing:

1. **A run is about the teams that played it.** Three middling teams failing
   to finish is worth reporting and is not a proof that nobody could. A caller
   who wants more confidence runs more teams, or turns the dials.
2. **A fake team does everything it is allowed to do.** It does not decide to
   leave an optional mission alone, and it walks straight to a mission's area
   rather than getting lost on the way. Modelling either is a product question
   nobody has asked.
3. **Nothing calls this yet.** The AI builder's validation step is EXPD-066,
   and the API has no route that runs one. What is here is the runner, and the
   tests that use it.

### The REST API skeleton

`apps/api/src/http/` is what every endpoint after this one is built on. It
holds no endpoint of its own beyond the health checks, and it knows nothing
about expeditions, missions or teams. That is the point of it: the error
contract, the request id, the body limit and the 404 are decided once, so no
two endpoints can decide them differently.

`createApp` in `apps/api/src/app.ts` is the only place that says what order
the pieces run in:

```ts
app.use(requestId());            // 1. before anything that can fail
app.use(createHealthRouter());   // 2. before anything that can be slow
app.use(express.json(...));      // 3. with a 1 MB limit
app.use('/auth', ...);           // 4. the feature routers
app.use(notFoundHandler());      // 5. nothing claimed the path
app.use(errorHandler());         // 6. the last word
```

A later ticket adds a router at step 4 and writes none of the rest.

**One error body, whatever went wrong.**

```json
{ "error": "validation-failed", "message": "Some of what was sent is not valid.",
  "details": [{ "path": "name", "message": "This cannot be empty." }] }
```

`error` is a stable code to branch on; `message` is English for a person and
may be reworded at any time, so nothing should read it. Only a validation
failure carries `details`. `AuthError` (EXPD-004) already answered in this
shape, so the two are one contract rather than two that look alike, and
`errorHandler` passes an `AuthError` through with its own code and the
`WWW-Authenticate` header a 401 needs.

| Code                     | Status | When                                        |
| ------------------------ | ------ | ------------------------------------------- |
| `bad-request`            | 400    | Unreadable JSON, a malformed parameter.     |
| `not-found`              | 404    | Nothing lives at that address.              |
| `method-not-allowed`     | 405    | That address does not answer to that method.|
| `conflict`               | 409    | It contradicts what already exists.         |
| `payload-too-large`      | 413    | Over the 1 MB body limit.                   |
| `unsupported-media-type` | 415    | Not a media type this API reads.            |
| `validation-failed`      | 422    | Readable, but wrong. Carries `details`.     |
| `service-unavailable`    | 503    | Something the API depends on is not there.  |
| `internal-error`         | 500    | A fault on our side.                        |

A 500 says one sentence and nothing else — not the message, not the stack, not
the name of a table. The whole error goes to the log with the request id, and
the caller has the same id in the response header.

Express 5 forwards a rejected promise from an `async` handler to the error
handler by itself, so there is no `asyncHandler` wrapper here and no route
needs one.

**A request id on every answer.** `requestId()` keeps the `X-Request-Id` a
proxy or a client sent, trimmed to 200 characters, and mints a UUID when there
is none. It is echoed on every response, not only on errors, so a client can
record the id of a call that succeeded and later turned out to be wrong. The
audit log (EXPD-006) writes the same id, which is what ties an entry to the
answer somebody was shown.

**Validation before the handler.** A handler never reads `request.body` and
wonders:

```ts
const Body = object({
  name: string({ min: 1, max: 120 }),
  teamSize: integer({ min: 1, max: 8 }),
  visibility: oneOf(['private', 'organisation'] as const),
  notes: optional(string({ max: 2000 })),
});

router.post('/expeditions', validateBody(Body), (request, response) => {
  const body = bodyOf(request, Body);   // typed, and already checked
});
```

Everything wrong is reported at once, each with the path to the field, because
a client that has to fix one mistake per round trip is a client whose user
gives up. A query issue is reported as `?limit` and a path parameter as `:id`,
so a path means one thing. An unknown field is refused rather than ignored: a
misspelled `title` that silently does nothing is the worst kind of bug to be
on the receiving end of.

The checkers are `string`, `integer`, `boolean`, `oneOf`, `id`, `timestamp`,
`array`, `object`, `optional`, `withDefault` and `unchecked`, and they are
hand-written because a schema library is a dependency and no ticket has added
one. They check the *shape of a request* and no more. They do not check an
expedition document — `validateExpeditionDefinition` (EXPD-002) owns that, and
`definition()` is how a route hands over to it while keeping one error
contract.

**Two health checks, because they answer different questions.**

| Endpoint        | Question                       | Answer                        |
| --------------- | ------------------------------ | ----------------------------- |
| `/health`       | Is this process alive?         | Always 200 while it is.       |
| `/health/ready` | Can it serve a real request?   | 200, or 503.                  |

`/health` is what the App Service probe calls (EXPD-007) and what
`scripts/package-api.sh` asks the built package before it ships it. It touches
nothing outside the process, on purpose: a liveness probe that fails when the
database is slow tells the platform to restart every instance at the moment
restarting helps least.

`/health/ready` asks the database `SELECT 1`, with a two-second timeout, and
answers 503 when it does not come back. It says `not-configured` rather than
failing when `createApp` was given no database, because an API with no
database is a deliberate arrangement here and not a broken one. It says
nothing about *why* a check failed — that is in the log. Nothing routes
traffic on it today.

```bash
$ curl -s localhost:3000/health/ready
{"status":"ok","apiVersion":"0.1.0","engineVersion":"0.1.0","uptimeSeconds":12,
 "checks":{"database":"not-configured"}}
```

**What is deliberately not here.**

1. **No database connection.** `createApp({ db })` still takes one from its
   caller, and nothing in the repository calls it that way, because a driver
   is a dependency and no ticket has added one. `pg.Pool` satisfies
   `Queryable` as it is, so the ticket that adds it writes one line:

   ```ts
   createApp({ db: new Pool({ connectionString: process.env.DATABASE_URL }) });
   ```

2. **No route version prefix.** Paths are what they were: `/auth/sign-in`, not
   `/v1/auth/sign-in`. `API_VERSION` in `http/health.ts` is the version of the
   contract, reported by the health checks, and is not a prefix. Adding one
   would change an endpoint EXPD-004 has already published, which is not this
   ticket's to change.

3. **No rate limiting, no CORS, no request logging middleware.** Each is
   somebody's ticket or somebody's dependency, and none of them is in this
   one's scope.

| File                             | What it holds                                        |
| -------------------------------- | ---------------------------------------------------- |
| `http/request-id.ts`             | Giving every request a name, and echoing it.         |
| `http/errors.ts`                 | What the API refuses, and the one body it says so in.|
| `http/validation.ts`             | Checking what a request sent.                        |
| `http/error-handler.ts`          | Turning anything that went wrong into that one body. |
| `http/health.ts`                 | Alive, and ready.                                    |
| `test/http/`                     | 65 tests, over real sockets. No fake `Request`.      |

### Expeditions, drafts and publishing

`apps/api/src/expeditions/` is the first feature router on the skeleton. An
expedition is not one thing that gets edited: it is a row that keeps its id
forever, and a stack of revisions. Everything worth reading lives in a
revision, and that split is what lets publishing mean something — a class
playing a published revision goes on playing exactly what their teacher
published, however much the author changes afterwards.

| Endpoint                                       | What it does                                    |
| ---------------------------------------------- | ----------------------------------------------- |
| `POST /expeditions`                            | Creates one, with revision 1 as a draft.        |
| `GET /expeditions`                             | This organisation's, newest change first.       |
| `GET /expeditions/:id`                         | One, with its draft and published revisions.    |
| `GET /expeditions/:id/draft`                   | The document being worked on.                   |
| `PUT /expeditions/:id/draft`                   | Saves a document over the draft.                |
| `POST /expeditions/:id/publish`                | Freezes the draft.                              |
| `GET /expeditions/:id/versions`                | Every revision, without the documents.          |
| `GET /expeditions/:id/versions/:number`        | One revision, document and all.                 |

**Three rules, and everything else follows from them.**

1. **An expedition is its revisions.** Creating one writes two rows: the
   `expedition`, and `expedition_version` 1 as a draft.
2. **The draft is the newest revision, and there is at most one.** Saving
   writes over it. When the newest revision has been published there is
   nothing to write over, so a save starts the next one. Whether `PUT
   /draft` wrote over revision 3 or started revision 4 is not the caller's
   to decide and comes back in `version.definitionVersion`.
3. **Publishing freezes a revision.** It is stamped with the time and the
   person, and nothing writes to it again. A second publish is `409`: not a
   bad request, simply nothing to publish.

**A draft may be unfinished. A published revision may not.** This is the one
place the two differ, and it is deliberate: an author should be able to save
a half-built graph and come back to it tomorrow.

```bash
$ curl -X PUT .../expeditions/$ID/draft -d '{"definition": {...}}'
{"version": {"definitionVersion": 2, "status": "draft", ...},
 "definition": {...},
 "issues": [{"path": "definition.missions[0]",
             "message": "Mission \"alpha\" is not placed on any node, so no team could reach it."}]}
```

The save succeeded, and `issues` is the list the Studio draws under the
author's nose while they work. Publishing runs the same check and refuses
while the list is not empty — `422`, with every problem and the path to it.
The check is `validateExpeditionDefinition` (EXPD-002); nothing here has a
second opinion about what a valid expedition is.

**Six fields are the platform's, whatever the client sent.** `id`,
`definitionVersion`, `status`, `publishedAt`, `metadata.authoring` and its
`source` are written over rather than refused, because an error message about
a field nobody meant to send helps nobody. So a document cannot claim to be
published, cannot claim to belong to another organisation, and cannot claim
somebody else wrote it. `seal` in `documents.ts` is the only way a document
reaches a row, so this is true in storage and not only in a response.

What a request *does* have to carry is a name: `metadata.title`. The column is
`NOT NULL`, and an expedition nobody can name is not a draft of anything.

**The flat copy.** Migration 0001 asked this ticket to write `mission_instance`,
`mission_node` and `hint` from the document "whenever the revision is saved",
because a foreign key cannot point inside a JSON document and other rows have
to point at missions and stops — an attempt (EXPD-020), a team's progress
(EXPD-013), a QR marker (EXPD-032). The copy is derived and never
authoritative: it is deleted and written again from the document on every
save, so it cannot drift.

A draft that does not validate keeps no copy at all. The database would refuse
most half-finished ones anyway — two start nodes, a stop holding a mission
that was deleted — and a stale copy would be worse than none, because
something else would go on pointing at a mission the author has removed. A
published revision is always valid, so it always has one.

**Reading, writing and publishing are three permissions.** `expedition:read`,
`expedition:write` and `expedition:publish`. A facilitator holds the first
only: they run a class with an expedition somebody else built, and cannot put
one in front of a class as finished. Another organisation's expedition answers
`404` rather than `403`, because "you may not touch that" would be telling
Riverbank Academy that Portside School has an expedition with that id.

Every write is one transaction with its audit entry inside it, so a change and
the record of who made it cannot exist without each other. The entries are
`expedition.created`, `expedition.updated` and `expedition.published`, and the
last one is about the revision rather than the expedition — which is what
EXPD-006's vocabulary already said.

| File                                 | What it holds                                      |
| ------------------------------------ | -------------------------------------------------- |
| `expeditions/documents.ts`           | The six fields the platform writes, and the little a draft has to be. |
| `expeditions/expedition-repository.ts` | The two tables, through the tenant repository.    |
| `expeditions/projection.ts`          | The flat copy other rows point at.                 |
| `expeditions/expedition-service.ts`  | One draft, and publishing freezes it.              |
| `expeditions/views.ts`               | What a client reads.                               |
| `expeditions/routes.ts`              | The endpoints, and the stack in front of them.     |
| `test/expeditions/`                  | 53 tests, over real sockets and real tokens.       |

**What is deliberately not here.**

1. **No archive, and no delete.** `expedition:delete` exists and
   `expedition.deleted` is in the audit vocabulary, but retiring an expedition
   has to decide what happens to the runs pointing at it, and runs are
   EXPD-019.
2. **No unpublish.** `expedition.unpublished` is in the vocabulary too. What it
   should do to a session already playing that revision is EXPD-031's
   question, not this one's.
3. **No mission `config` checking.** Only the mission type knows the right
   shape for it (EXPD-009), and resolving a document's types against the
   registry is a copy of what they claimed, not a judgement on it.

### Join codes, teams and participants

`apps/api/src/participation/` is what happens between six characters on a
whiteboard and a team sheet. A *run* of an expedition is one lesson: one
class, one afternoon, one code. Making the run, starting it and ending it is
EXPD-019; this is everything about the code it carries and the students it
fills up with.

| Endpoint                                              | What it does                                 |
| ----------------------------------------------------- | -------------------------------------------- |
| `POST /join`                                           | A code and a name in, a device token out.    |
| `GET /sessions/:id/join-code`                          | What the students should type.               |
| `POST /sessions/:id/join-code`                         | Mint a new one, and retire the old.          |
| `GET /sessions/:id/teams`                              | The team sheet, and the limits it is held to.|
| `POST /sessions/:id/teams`                             | Add a team.                                  |
| `GET /sessions/:id/participants`                       | Everybody in the run.                        |
| `PUT /sessions/:id/participants/:pid/team`             | Put somebody on a team, with a role.         |
| `DELETE /sessions/:id/participants/:pid/team`          | Take them off it, leaving them in the run.   |
| `DELETE /sessions/:id/participants/:pid`               | Take them out of the run.                    |

**The code is designed for a nine-year-old reading a whiteboard.** The
alphabet keeps one character out of each group people mix up — `0 O Q D`,
`1 I L J`, `2 Z`, `5 S`, `6 G`, `8 B`, `U V` — which leaves 25, and six of
those is 244 million codes. Reading one back is forgiving in the same
direction: `normaliseJoinCode` upper-cases, throws away spaces and hyphens,
and maps each dropped character onto the one its group kept, so a student who
types `0` gets the `D` the code actually has.

A code is not a secret and is not treated as one. It says which run you are
joining and nothing about who you are. The device token handed out at the end
of joining is the credential, and that is `mintOpaqueToken`'s 256 bits.

**One read in the API is not scoped to an organisation, and it is this one.**
A student typing a code has no account and no idea which school the API thinks
they are in — that is what a join code is for. So `JoinCodeDirectory` looks a
code up across every organisation, exactly as `AuthService` looks an account up
by email before there is an organisation to scope to. Migration 0001 says the
same thing in its own way: the unique index on `join_code` is not scoped
either.

Four things keep that crossing narrow. It reads **two columns** — `id` and
`organisation_id`, so a code cannot be used to read a run. It reads **one
table**. It only sees the **four joinable states**, so a code cannot reach a
run that has ended. And every method takes a `reason`, the way
`GlobalRepository` does. Everything after the lookup goes through a
`TenantRepository` pinned to the organisation the code found, and
`test/participation/isolation.test.ts` holds all of it to its word.

**The limits come from the revision the run is pinned to.** `rules.teams` in
the document (EXPD-002) says how big a team may be, how many teams there may
be, and which role names exist. None of it is copied onto the run: it is read
from the document each time it is enforced, so a class that started on
revision 3 plays revision 3's rules however much the author changes
afterwards. A run's capacity is `maxTeams × size.max`, and a run whose
expedition caps no teams has no capacity limit here — what an organisation has
paid for is EXPD-069's question.

A document that is short of a field falls back to a wide default rather than
throwing. Refusing to let a class join over a missing optional field would be
the worse failure by a distance.

**A student is in the run before they are on a team, and on one team at a
time.** Joining puts somebody in the lobby; which team they end up on is a
teacher's to say. Moving them ends one membership and starts another, and
migration 0001's two partial unique indexes mean a bug here is refused by the
database rather than stored. A student sent back to a team they were on
before reuses the row from last time, because `UNIQUE (team_id, participant_id)`
has no predicate on it.

**One endpoint assigns a team and a role, and it is a PUT.** The body is the
whole membership, so leaving `role` out means no role and leaving `isLeader`
out means not the leader. That is how a role is taken away again, and it is
why there is no second endpoint for doing so. A role the expedition does not
hand out is `422` with the list of the ones it does — a teacher who typed
`navigater` should be told, not quietly given a team with nobody navigating.

**A phone that comes back is the same student.** Rejoining with the same
device id finds the participant that phone already is, gives it a fresh token
and lets it correct the name it typed the first time. A student a teacher
removed is refused with `409` rather than `404`: they typed a code that really
does reach a run, and "there is no such run" would send them round the loop of
typing it again.

**Removing somebody does three things in one transaction.** They are marked
removed, their team membership is ended, and every device token their phone
holds for that run is withdrawn. The last one is the point: a student who has
been taken out of a lesson and whose phone goes on submitting work is not out
of the lesson. The rows stay — a removed student is part of what happened, and
their team's event stream (EXPD-014) points at them.

**Reading a code is `session:read` and minting one is `session:write`,
because a code belongs to the run.** Everything about the students is
`participant:read` and `participant:write`, which a facilitator holds: running
a class with somebody else's expedition is exactly the job of moving children
between teams. A student's phone is refused all eight staff endpoints —
`student-device` holds `participant:read`, so without `requireStaff()` a phone
could draw the whole run's team sheet, and what a student's own app should see
of its own run is EXPD-040 and EXPD-041.

Another organisation's run answers `404` rather than `403`, for the reason
EXPD-017 gives: "you may not touch that" would be telling Riverbank Academy
that Portside School has a run with that id.

| File                                     | What it holds                                       |
| ---------------------------------------- | --------------------------------------------------- |
| `participation/join-codes.ts`            | Making a code a child can read and type.            |
| `participation/join-code-directory.ts`   | Turning one back into a run. The one unscoped read. |
| `participation/team-rules.ts`            | The limits, read out of the pinned revision.        |
| `participation/participation-repository.ts` | The four tables, through the tenant repository.  |
| `participation/participation-service.ts` | The rules, and the transactions they run in.        |
| `participation/views.ts`                 | What a client reads.                                |
| `participation/routes.ts`                | The endpoints, and the stack in front of them.      |
| `test/participation/`                    | 112 tests, over real sockets and real tokens.       |

**What is deliberately not here.**

1. **No entry in the audit log for joining, or for a code being reissued.**
   The vocabulary EXPD-006 fixed gives this ticket two actions,
   `participant.team-changed` and `participant.removed`, and both are written.
   There is no action for a student arriving or for a code changing, and
   widening the vocabulary is EXPD-006's to do rather than this ticket's.
2. **No student-side team forming.** A student cannot make a team, pick one,
   or hand themselves a role. The lobby the student app draws is EXPD-040 and
   EXPD-041.
3. **No seat or participant limits from the plan.** The only limits enforced
   here are the ones the expedition's own document lays down. What an
   organisation has paid for is EXPD-069.
4. **Nothing about the run's lifecycle.** There is no endpoint here that
   makes a run, starts one, pauses one or ends one, and nothing here says
   which state may follow which. That is EXPD-019, below, and it is why these
   tests seed a run rather than creating one.

### The run lifecycle

`apps/api/src/sessions/` is the run itself. EXPD-018 gave a run its code and
filled it with students; this is making the run, starting it, stopping the
clock, starting it again, giving the class more time, and stopping it for
good — and the runtime state every team in it plays against.

| Endpoint                          | What it does                                  |
| --------------------------------- | --------------------------------------------- |
| `POST /sessions`                  | Schedule a run of a published expedition.     |
| `GET /sessions`                   | This organisation's runs, newest first.       |
| `GET /sessions/:id`               | One run, with its clock as of now.            |
| `POST /sessions/:id/start`        | Begin play.                                   |
| `POST /sessions/:id/pause`        | Stop the clock.                               |
| `POST /sessions/:id/resume`       | Start it again.                               |
| `POST /sessions/:id/extend`       | Give every team more time.                    |
| `POST /sessions/:id/end`          | Stop the run for good.                        |

**One table says which state may follow which.** It is
`SESSION_TRANSITIONS` in `@explorer/shared-types`, not in the API, because
three sides read it: the API enforces it, Director Mode (EXPD-055) greys out
the buttons a run cannot take, and the student app (EXPD-047) is told a run
changed state and has to know whether that means play has begun or is over.

```
        ┌────────────┐
        │ scheduled  │──────────────┐
        └─────┬──────┘              │
              │ start               │ end, before play
        ┌─────▼──────┐              │
  ┌─────│  running   │◄──┐          │
  │     └─────┬──────┘   │ resume   │
  │ end       │ pause    │          │
  │     ┌─────▼──────┐   │          │
  │     │   paused   │───┘          │
  │     └─────┬──────┘              │
  │           │ end                 │
  │     ┌─────▼──────┐        ┌─────▼──────┐
  └────►│   ended    │        │ cancelled  │
        └────────────┘        └────────────┘
```

A run made for a time still to come waits in `scheduled`; one made for now
opens its `lobby` straight away. Both are joinable and both can be started,
so the difference is what a teacher sees on a dashboard rather than what a
student can do. Ending a run that was never started is `cancelled` rather
than `ended`: it was called off, and a result nobody played for should not be
filed beside the ones that were. Both are final. A class that wants to play
again gets a new run, with a new code and a clean sheet, which is what a
second lesson is.

**Pausing stops the clock; it does not move the end.** A resume adds the
pause it just ended to `paused_seconds_total`, and everything that counts
time takes that total back out. A run paused for twenty minutes finishes
twenty minutes later than it would have, and no team loses a second of play.
Ending a paused run folds the open pause in first, so a run stopped while
paused reports the same elapsed time as one resumed a moment before it was
stopped.

**The clock is worked out on every read, never stored.** Four columns and one
number from the pinned document are all there is:

| What                     | Where it comes from                              |
| ------------------------ | ------------------------------------------------ |
| `started_at`             | When play began.                                 |
| `paused_at`              | When the pause going on now began, or NULL.      |
| `paused_seconds_total`   | Every pause before that one, added up.           |
| `extended_seconds_total` | Time a teacher gave the class on the day.        |
| `rules.timing`           | The pinned revision's own limit, if it set one.  |

A stored "seconds remaining" is wrong the moment it is written and a stored
"ends at" is wrong the moment somebody pauses — and pausing is the whole
point of the feature. So `GET /sessions/:id` answers with a `clock` that
carries the moment it was worked out at, and a client counts down from there
between requests. `endsAt` is given only while a run is `running`: a paused
run's end time moves with every second it stays paused, and handing a client
a time that slides away from it would be worse than handing it none.

**Time given on the day is the run's, not the document's.** The limit a class
plays to is the revision's `rules.timing.totalTimeLimitSeconds` plus the
run's `extended_seconds_total`. The document is frozen when it is published,
and a teacher giving ten more minutes because the coach was late is not
editing what the class is playing — which is why the extension is a column
(migration 0005) rather than a field in the document. Only a run being played
and only a run with a limit can be extended; anything else is `409`.

**Nothing ends a run whose time is up.** The clock reports `expired` and the
run goes on being `running` until somebody ends it. There is no timer in the
API, and a lesson that ended itself while every phone was in a tunnel would
be the worse behaviour. Turning `expired` into an ending is Director Mode's
(EXPD-055) or a live trigger's (EXPD-057).

**Reading and making a run are `session:read` and `session:write`; the five
that change a run under way are `session:control`.** That is the split
EXPD-004 already wrote into the permission list, and this is the first thing
to use it. A facilitator holds all three, because running somebody else's
expedition with a class is the whole of that role. A student's phone is
refused every endpoint here — `student-device` holds `session:read`, so
without `requireStaff()` a phone could list every run in the school.

Another organisation's run answers `404` rather than `403`, for the reason
EXPD-017 gives, and a run is only ever made against an expedition that has a
published revision: you cannot put a draft in front of a class.

`/sessions` is shared ground. EXPD-018's router and this one are both mounted
on it, and the two never claim the same address — everything here is either
`/` or a verb under `/:sessionId`, and everything there is a noun under it.

| File                                 | What it holds                                    |
| ------------------------------------ | ------------------------------------------------ |
| `shared-types/participation/lifecycle.ts` | The transition table, read by all three sides. |
| `sessions/timing-rules.ts`           | The clock the pinned revision lays down.         |
| `sessions/session-clock.ts`          | How long a run has been going, and how long is left. |
| `sessions/session-repository.ts`     | The run's table, through the tenant repository.  |
| `sessions/session-service.ts`        | The rules, and the transactions they run in.     |
| `sessions/views.ts`                  | What a client reads.                             |
| `sessions/routes.ts`                 | The endpoints, and the stack in front of them.   |
| `test/sessions/`                     | 92 tests, over real sockets and real tokens.     |

**What is deliberately not here.**

1. **No entry in the audit log for extending a run.** The vocabulary EXPD-006
   fixed has `session.scheduled`, `started`, `paused`, `resumed`, `ended` and
   `overridden`, and all six are written. There is no action for time being
   added, so an extension is recorded as `session.overridden` — which is what
   it is, a teacher changing a number the author wrote. Widening the
   vocabulary is EXPD-006's to do rather than this ticket's, the same line
   EXPD-018 drew over reissuing a code.
2. **Nothing about a team's own state.** Starting a run does not move a team
   from `forming` to `playing`, and ending one does not mark anybody
   `finished`. A team's lifecycle is EXPD-041, and a run's lifecycle quietly
   rewriting team rows would be that ticket built here by the back door.
3. **Nothing tells the phones.** A run that has been paused is a thing thirty
   students need to hear about within a second, and pushing it to them is the
   realtime channel (EXPD-023) and the student app's handling of it
   (EXPD-047).
4. **No job runs on a schedule.** `scheduledStartAt` is a note a teacher
   writes; nothing opens a lobby or starts a run when the time arrives,
   because a lesson starts when a teacher says so and not when a calendar
   does.
5. **No dashboard.** The buttons that press these endpoints are EXPD-055 and
   EXPD-058.

### Playing a mission

`apps/api/src/play/` is the first thing that calls the engine for real. A
team starts a try, hands work in and opens a hint; a teacher marks waiting
work complete or sends it back. **The engine decides every outcome** — the
state machine (EXPD-010) whether a try may start, the completion interface
(EXPD-011) what the work was, the scoring engine (EXPD-012) what it was
worth, and progression (EXPD-013) what it opened. The API reads the rows
those need, asks, and writes down the answer.

| Endpoint                                                  | Who          | What it does                          |
| --------------------------------------------------------- | ------------ | ------------------------------------- |
| `POST /sessions/:id/missions/:missionId/attempts`         | A phone      | Start a try.                          |
| `POST /sessions/:id/missions/:missionId/submissions`      | A phone      | Hand work in, and get the verdict.    |
| `POST /sessions/:id/missions/:missionId/hints`            | A phone      | Open the next hint, or a named one.   |
| `POST /sessions/:id/teams/:teamId/missions/:missionId/complete` | A teacher | Approve or reject waiting work.   |

`:missionId` is the mission's id in the definition document, which is what
the student app draws its board from. A phone never names a team: it plays
for the team its student is on, read from its token and the team sheet, so
it has no way to play for somebody else's.

**Every answer has the same shape.** The mission's new state and the
triggers the rules would now accept, the try, the submission, the verdict
exactly as the engine gave it, the score events the change wrote and the
total after it, and every door it opened.

```bash
$ curl -X POST .../sessions/$RUN/missions/gate/submissions \
       -d '{"payload": {"code": "OTTER"}}'
{"mission": {"id": "gate", "state": "complete", "attemptsUsed": 1, "allowedTriggers": []},
 "verdict": {"outcome": "correct", "method": "behaviour", "trigger": "accept", "review": "none"},
 "score": {"total": 15, "events": [{"reason": "mission-complete", "points": 10, ...},
                                   {"reason": "first-to-complete-bonus", "points": 5, ...}]},
 "progression": {"events": [{"reason": "mission-unlocked", "missionInstanceId": "tower", ...}], ...},
 ...}
```

**A refusal is `409`, with the engine's own code.** The wrong end of the
park, a second tap on start, work in the wrong shape, a hint already paid
for — each is the engine answering rather than failing, and a phone has to
tell them apart to say anything useful. So a `409` from here carries
`refusal`, with the engine's `code` and whatever else it said, beside the
usual `error` and `message`. That field is the one addition this ticket
makes to the error contract (EXPD-016). A refusal writes nothing at all:
work that was refused was not judged, and is not a try spent.

**A mission state is never stored.** Every line of every mission's history
is kept, append-only, in `mission_transition` (migration 0006), and the state
is replayed from it by `replayMissionTransitions` on every request. A history
the rules could not have produced is caught on the next read and the request
fails, rather than playing on from a record somebody changed.
`mission_attempt` and `submission` are written too, because the rest of the
platform points at them, and they say what the engine said.

**Every point is a sealed line.** Score and progression changes go into the
team's stream (EXPD-014) through `TeamStream`, in the same transaction as the
change, and `team.total_score` is written beside them. The three running
counts the stream does not carry — the streak, the longest streak and the
wrong answers — are on `team` too (0006), as EXPD-012 said they would be.

**The team is locked first.** Every request reads the team row `FOR UPDATE`
before anything else about the team, so two phones pressing submit at the
same moment are played one after the other.

**Three things are the API's, because the engine holds no clock and knows
no other team.**

1. **The run has to be `running`** for a phone to play. A teacher may decide
   while it is running, paused or over: photos are often marked after the
   bell.
2. **The clocks.** A mission's `cooldownSeconds` is checked before a new try.
   Work handed in after the run's time is up is late, and the expedition's
   `latePolicy` says whether it is refused, accepted, or accepted with the
   `late-penalty` rule told how late.
3. **Other teams.** Whether this team was first to finish a mission is read
   from the other teams' tries and handed to the scoring engine.

**Mission types.** A registry is built per request (EXPD-009). A type that
comes as code, with a behaviour that judges, is passed to
`createApp({ missionTypes })`; none are yet, because the mission types are
EXPD-032 to EXPD-039. Otherwise a type is its `mission_type` row, which the
completion interface sends to a teacher, and a type with neither is the
engine's `unknown-mission-type`.

**Who may do what.** The three phone routes need `attempt:write`, which only
`student-device` holds. The teacher's route needs `submission:review`, which
creators and facilitators hold, and writes `submission.accepted` or
`submission.rejected` to the audit log. Another organisation's run is `404`,
and so is another run's, for a phone.

| File                         | What it holds                                           |
| ---------------------------- | ------------------------------------------------------- |
| `play/mission-log.ts`        | A mission's history, stored and replayed.               |
| `play/mission-types.ts`      | The registry one submission is judged against.          |
| `play/play-repository.ts`    | The tables, through the tenant repository.              |
| `play/play-service.ts`       | The four actions, and the transactions they run in.     |
| `play/views.ts`              | What a client reads back.                               |
| `play/routes.ts`             | The endpoints, and the stack in front of them.          |
| `db/migrations/0006_mission_play.sql` | The history, the hints opened, the running counts. |
| `test/play/`                 | 59 tests, over real sockets and real tokens.            |

**What is deliberately not here.**

1. **No hint tokens.** Opening a hint charges points (`hint-penalty`) and
   records the opening; counting and spending tokens is EXPD-046.
2. **No expiry.** Nothing applies `expire` when a mission's own time limit
   runs out, because nothing in the API runs on a timer. `deadline_at` is on
   the try for whoever does.
3. **No reads.** Nothing here lists a team's tries or the review queue. The
   mission board is EXPD-042 and the queue is EXPD-056.
4. **No media.** A photo is handed in by id; the upload is EXPD-021.
5. **Nothing tells the phones.** A verdict reaching the rest of the team is
   the realtime channel (EXPD-023).

### Signed media URLs

`apps/api/src/media/` lets a phone put a file straight into Blob Storage,
and a teacher read it back, without the bytes ever passing through the API.
The API signs a URL; the client talks to storage with it.

| Endpoint                        | Needs         | What it answers with                        |
| ------------------------------- | ------------- | ------------------------------------------- |
| `POST /media/uploads`           | `media:write` | A `pending` row, and a URL that creates it. |
| `GET /media/:mediaId/download`  | `media:read`  | A URL that reads it.                        |

```bash
$ curl -X POST .../media/uploads -d '{"kind": "image", "contentType": "image/jpeg"}'
{"media": {"id": "5c1e…", "kind": "image", "status": "pending", "contentType": "image/jpeg"},
 "upload": {"method": "PUT", "url": "https://stexpd….blob.core.windows.net/media/<org>/5c1e…?sv=…&sp=c&sig=…",
            "headers": {"x-ms-blob-type": "BlockBlob", "content-type": "image/jpeg"},
            "expiresAt": "2026-09-23T10:15:00.000Z"}}

$ curl -X PUT "$URL" -H 'x-ms-blob-type: BlockBlob' -H 'content-type: image/jpeg' --data-binary @photo.jpg
```

The phone then hands the photograph in by `media.id` (EXPD-020).

**What a URL allows.** One blob, over HTTPS, for fifteen minutes by
default. An upload URL is create-only (`sp=c`): it writes a blob that does
not exist yet and cannot replace one that does, so evidence a team handed in
cannot be swapped afterwards by whoever still holds the URL. A download URL
is read-only (`sp=r`). Both answers are sent `Cache-Control: no-store`,
because a URL is a credential for as long as it works.

**Where a file goes.** `media/<organisation id>/<media id>`. The id is
random and minted by the API, so a path cannot be guessed and two uploads
never meet. The row holds the container and the path, never a URL, as 0001
asked.

**Who may do what.** A phone and a staff account may both upload, and the
row names the student or the account — never both. Only staff may download:
a phone holds no `media:read`, because the student app is given the URLs it
needs by the screens that show them. Another organisation's file, and a
deleted one, is `404`; one whose upload `failed` is `409`.

**How it is signed.** With a *user delegation key*, because EXPD-007 turned
the account keys off. The web app's managed identity asks App Service for a
token, and Blob Storage for a key with it; the key is kept in memory for a
day and shared by every URL signed in that time. It is all `node:crypto` and
`fetch` — the Azure SDK is a dependency and nobody has added it — and the
format is pinned to service version `2022-11-02`.

**Settings.** EXPD-007 already sets `AZURE_STORAGE_ACCOUNT`,
`AZURE_STORAGE_BLOB_ENDPOINT` and `AZURE_STORAGE_MEDIA_CONTAINER`, and App
Service sets `IDENTITY_ENDPOINT` and `IDENTITY_HEADER` itself.
`MEDIA_UPLOAD_URL_SECONDS` and `MEDIA_DOWNLOAD_URL_SECONDS` are optional,
default to 900, and may be at most 3600. With no storage account set, both
routes answer `503` and the rest of the API runs as before. An account with
no identity to sign for it is refused when the app is built, with an error
that says so.

| File                          | What it holds                                          |
| ----------------------------- | ------------------------------------------------------ |
| `media/blob-sas.ts`           | Signing one blob's URL.                                |
| `media/delegation-key.ts`     | The token and the key, and how long each is kept.      |
| `media/media-storage.ts`      | The upload URL and the download URL.                   |
| `media/media-service.ts`      | The row an upload writes, and the checks on a download.|
| `media/routes.ts`             | The endpoints, and the stack in front of them.         |
| `config/storage-config.ts`    | The settings.                                          |
| `test/media/`                 | 41 tests. Nothing in them reaches Azure.               |

**What is deliberately not here.**

1. **Nothing marks a file `ready`.** A row is `pending` from the moment the
   URL is signed, and stays so. Checking the blob arrived, and recording its
   real size, is not in this ticket's scope. A download is signed for a
   `pending` file too; if nothing was uploaded, Blob Storage answers 404.
2. **No size limit.** A signed URL cannot cap how many bytes are PUT to it.
3. **No proof against Azure.** The tests prove the signed string matches
   Azure's documented list field by field; only a real storage account can
   prove Azure agrees. Try one upload on `dev` before relying on it.

### Leaderboards

`apps/api/src/leaderboard/` places teams in order. It reads figures other
tickets keep and writes nothing.

| Endpoint                          | Who                  | What it answers with                          |
| --------------------------------- | -------------------- | --------------------------------------------- |
| `GET /sessions/:id/leaderboard`   | Staff, and the run's phones | The teams in one run, placed.          |
| `GET /expeditions/:id/leaderboard`| Staff only           | Every team from every ended run, placed.      |

```bash
$ curl .../sessions/$RUN/leaderboard
{"sessionId": "…", "sessionName": "Year 6 — Tuesday", "sessionStatus": "running",
 "visibility": "live", "tieBreaks": ["earliest-finish"], "final": false, "shown": true,
 "standings": [{"rank": 1, "teamId": "…", "teamName": "Otters", "totalScore": 40,
                "missionsCompleted": 2, "hintsUsed": 2, "failedAttempts": 1,
                "finished": true, "finishSeconds": 1200, "members": ["Asha", "Ben"]}, ...]}
```

**Display names only.** A run's board lists each team's members by the name
they typed when they joined, and nothing else about them: no participant id,
no device, no account, no role. The one read of `participant` names its
columns — `id`, `display_name`, `status` — so nothing more is ever in memory.
A student taken out of the run is not listed. The expedition's board puts
several classes side by side, so it names no child at all: a team there is
its name and the run it played in.

**How teams are placed.** The higher `team.total_score` first — the kept
total EXPD-014 keeps beside the stream. Then each tie break the revision
names, in the order it names them. Teams still level share a place, and the
next place is skipped (1, 1, 3). The tie-break figures are counted from rows
EXPD-020 writes:

| Tie break                  | Counted from                                              |
| -------------------------- | --------------------------------------------------------- |
| `earliest-finish`          | `team.finished_at`, or the first `expedition-finished` line in the stream. Seconds from the run's start. Not finishing is last. |
| `most-missions-completed`  | Distinct missions with a `complete` line in `mission_transition`. |
| `fewest-hints-used`        | Rows in `hint_request`.                                    |
| `fewest-failed-attempts`   | `team.failed_attempts`.                                    |

A withdrawn team is not on either board.

**Who sees a run's board, and when**, is the pinned revision's
`scoring.leaderboard.visibility`:

| visibility     | Staff                 | A phone               |
| -------------- | --------------------- | --------------------- |
| `live`         | always                | always                |
| `teacher-only` | always                | once the run is over  |
| `final-only`   | once the run is over  | once the run is over  |
| `hidden`       | never                 | never                 |

A board that may not be seen yet still answers `200`, with `shown: false`
and no standings, and no team row is read. A phone reads only its own run's
board: another run's is `404`, as is another school's for anybody.

**The expedition's board** takes runs that `ended` (not `cancelled`), leaves
out any whose revision is `hidden`, and uses the tie breaks of the newest
revision among them. `?limit=` takes 1 to 200 and defaults to 50; `total`
says how many teams there are in all.

| File                                  | What it holds                                  |
| ------------------------------------- | ---------------------------------------------- |
| `leaderboard/ranking.ts`              | Placing teams. Pure.                           |
| `leaderboard/leaderboard-repository.ts` | The figures, read column by column.          |
| `leaderboard/leaderboard-service.ts`  | Who sees which board, and when.                |
| `leaderboard/views.ts`                | What a client reads.                           |
| `leaderboard/routes.ts`               | The endpoints, and the stack in front of them. |
| `test/leaderboard/`                   | 52 tests, over real sockets and real tokens.   |

**What is deliberately not here.**

1. **Nothing is pushed.** A phone asks again. Sending a new board when a score
   changes is the realtime channel (EXPD-023).
2. **Nothing is drawn.** The student app's view is EXPD-045, and Director
   Mode's is EXPD-055.
3. **No history.** A board is today's figures. Results and analytics after the
   afternoon are EXPD-059.

### Known gaps in `apps/student-mobile`

Two things are missing, and both are on purpose.

1. **The React Native CLI is not installed.** React Native 0.87 needs
   `@react-native-community/cli` to run `react-native start`, `bundle`,
   `run-android` and `run-ios`. EXPD-001 was not allowed to add a dependency,
   so the package is absent and those four scripts print a warning instead of
   running. The app's own code, `babel.config.js` and `metro.config.js` are
   all correct and verified. Add the devDependency and the scripts work:

   ```bash
   npm install -D -w @explorer/student-mobile @react-native-community/cli
   ```

2. **No `android/` and `ios/` folders.** The native projects are generated by
   the React Native CLI on a machine that has the Android SDK and Xcode. They
   cannot be produced here, and they are also not needed to type-check or
   bundle the JavaScript.

Metro is already configured for the monorepo. It watches the whole workspace
and resolves modules from both the app's `node_modules` and the hoisted root
`node_modules`.
