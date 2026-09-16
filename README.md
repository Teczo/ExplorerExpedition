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
(EXPD-006), the Azure baseline those all run on (EXPD-007), and the pipeline
that builds, checks and deploys the lot (EXPD-008), all described below. The rest is tracked in its own tickets:

- Mission Engine behaviour — EXPD-009 to EXPD-015
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
for that (EXPD-009).

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
