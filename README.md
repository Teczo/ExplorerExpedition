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

Check the API is up:

```bash
curl http://localhost:3000/health
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
validation interface every finished mission comes through (EXPD-011), and the
scoring engine that says what a verdict was worth (EXPD-012), all described
below. The rest is tracked in its own tickets:

- Mission Engine behaviour — EXPD-013 to EXPD-015
- REST API skeleton — EXPD-016
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
sets out the compatibility rules.

`validateExpeditionDefinition` checks the shape of a document and the way its
parts point at each other: unknown ids, a mission no node uses, a graph with no
start, a node nothing can reach, a loop. It does not check
`MissionInstance.config`, because only the mission type knows the right shape
for that. The mission type registry below is what checks it, and running both
is what fully checks a document.

There are no automated tests for it yet. The test runner is now in place —
see the isolation tests below — but writing tests for this schema is not part
of any ticket that has been done.

### The database schema

`apps/api/db/migrations/` holds the PostgreSQL schema as numbered SQL files.
`0001_core_data_model.sql` creates all 25 tables, from `organisation` down to
`audit_log`, and `0003_append_only_audit_log.sql` makes the last of those a
table nothing can edit. `apps/api/db/README.md` explains how to apply them and how the
tables are laid out.

```bash
createdb explorer
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0001_core_data_model.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0002_auth_and_tenancy.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0003_append_only_audit_log.sql
```

The schema stores a published expedition twice over, on purpose. The whole
EXPD-002 document goes into `expedition_version.definition` as JSONB and is
the source of truth. `mission_instance`, `mission_node` and `hint` are a flat
copy of the parts that runtime rows have to hold a foreign key to, since a
mission attempt cannot point at a string buried in a JSONB document. EXPD-017
writes both together.

Nothing in the repository connects to a database yet. Opening a connection is
EXPD-016, and choosing a migration runner needs a dependency, which no ticket
has added.

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
Nothing in the repository opens a connection yet — that is EXPD-016, and it
needs a driver, which is a dependency no ticket has added. `pg.Pool` already
satisfies the `Queryable` interface the repository layer is written against,
so EXPD-016 has nothing to write but the pool:

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
   connection (EXPD-016). The registry takes types from whoever builds it, and
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
   (EXPD-020) are what will, once something opens a database connection
   (EXPD-016). What a verdict is worth is EXPD-012, and what a completed
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
   (EXPD-020) are what will, once something opens a database connection
   (EXPD-016). Carrying the stream across the system — storing it, ordering
   it, proving nothing edited it — is EXPD-014, and this is the value that
   stream is made of.

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
