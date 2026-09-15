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
| `npm run dev:api`            | API on http://localhost:3000                    |
| `npm run dev:creator-web`    | Creator web on http://localhost:5173            |
| `npm run dev:studio`         | Studio on http://localhost:5174                 |
| `npm run dev:admin`          | Admin on http://localhost:5175                  |
| `npm run dev:student-mobile` | Starts the Metro bundler.                       |
| `npm run clean`              | Removes `node_modules` and all build output.     |

Check the API is up:

```bash
curl http://localhost:3000/health
```

## State of the code

The phase-0 scaffold (EXPD-001) is in place: each app and package has a
working build and a placeholder entry point. On top of it sit the Expedition
Definition schema (EXPD-002), the database schema (EXPD-003), and auth and
organisation tenancy (EXPD-004), all described below. The rest is tracked in
its own tickets:

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

There are no automated tests for it yet. The repository has no test runner, and
adding one is EXPD-008.

### The database schema

`apps/api/db/migrations/` holds the PostgreSQL schema as numbered SQL files.
`0001_core_data_model.sql` creates all 25 tables, from `organisation` down to
`audit_log`. `apps/api/db/README.md` explains how to apply them and how the
tables are laid out.

```bash
createdb explorer
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0001_core_data_model.sql
psql -d explorer -v ON_ERROR_STOP=1 -f apps/api/db/migrations/0002_auth_and_tenancy.sql
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
and makes each call state a reason. Testing all of this is EXPD-005.

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
