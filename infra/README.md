# Infrastructure

The Azure baseline for the platform (EXPD-007), as Bicep. Two environments,
`dev` and `prod`, from one template.

## What it creates

| Resource                                  | Why it is here                                                  |
| ----------------------------------------- | --------------------------------------------------------------- |
| App Service plan and web app, Linux        | Runs `apps/api`. Node 22, matching `.nvmrc`.                    |
| PostgreSQL Flexible Server, and `explorer` | The schema in `apps/api/db`.                                    |
| Storage account, `media` container         | Photographs and assets (EXPD-021, EXPD-030, EXPD-044).          |
| Azure Cache for Redis                      | The realtime channel and leaderboards (EXPD-022, EXPD-023).     |
| Key Vault, three secrets                   | How the connection strings reach the web app.                   |

Nothing in the repository connects to any of them yet. The API opens its first
connection in EXPD-016, and `apps/api/src/app.ts` serves the health check until
it does. Nothing puts that code on the web app either: this creates the place
the API runs, and EXPD-008 is what deploys into it.

## Layout

| Path                            | What it is                                                |
| ------------------------------- | ---------------------------------------------------------- |
| `main.bicep`                    | The whole environment. Sizes for dev and prod are in it.  |
| `main.dev.bicepparam`           | dev: region, and where the secrets come from.             |
| `main.prod.bicepparam`          | prod: the same.                                           |
| `modules/app-service.bicep`     | The plan and the web app.                                 |
| `modules/postgres.bicep`        | The server, the database and the firewall rule.           |
| `modules/storage.bicep`         | The account and its containers.                           |
| `modules/redis.bicep`           | The cache.                                                |
| `sql/application-role.sql`      | The `explorer_api` role the API signs in as.              |

The Key Vault is in `main.bicep` rather than a module of its own, because the
secrets are its children and the role assignment uses it as a scope, and both
of those are how the file says what has to exist before what.

## Requirements

- Azure CLI 2.53 or newer, which carries Bicep and understands `.bicepparam`.
- Contributor and User Access Administrator on the resource group. Contributor
  creates the resources; the second one is needed because the template grants
  the web app two roles, and granting a role is itself a permission.
- `psql`, for the two steps after the deployment.

## Deploying

### 1. The resource group

One group per environment. The template does not create it, so that a
deployment never needs a permission wider than the group it is deploying into.

```bash
az group create --name rg-explorer-dev --location westeurope
```

### 2. The secrets

Three, and none of them is in this repository. Generate them once per
environment and keep them where the team keeps such things — after the first
deployment the vault holds them too, but something has to supply them the
first time.

```bash
export POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 32)"
export API_DATABASE_PASSWORD="$(openssl rand -base64 32)"
export AUTH_TOKEN_SECRET="$(openssl rand -base64 48)"
```

`AUTH_TOKEN_SECRET` is the one `apps/api/src/config/auth-config.ts` refuses to
start without, and it has to stay the same across restarts and across
instances: change it and every access token in the field stops verifying.

### 3. What would change

`what-if` compares the template with what is already there and prints the
difference. On a first deployment everything is a create; on every one after
that, this is the review.

```bash
az deployment group what-if \
  --resource-group rg-explorer-dev \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam
```

### 4. Deploy

```bash
az deployment group create \
  --name expd-007-dev \
  --resource-group rg-explorer-dev \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam \
  --query properties.outputs
```

The outputs name everything the next two steps need: `apiUrl`, `apiAppName`,
`postgresHost`, `storageAccountName`, `redisHostName` and `keyVaultName`.

### 5. The schema

The migrations are applied with `psql`, because no migration runner has been
chosen — picking one means adding a dependency, and no ticket has. The
administrator login is the one that applies them, so that it owns the tables.

```bash
PGHOST="$(az deployment group show -g rg-explorer-dev -n expd-007-dev \
  --query properties.outputs.postgresHost.value -o tsv)"

for file in apps/api/db/migrations/*.sql; do
  psql "host=$PGHOST port=5432 dbname=explorer user=explorer_admin sslmode=require" \
    -v ON_ERROR_STOP=1 -f "$file"
done
```

### 6. The role the API signs in as

The connection string in the vault is for `explorer_api`, not for the
administrator, and that role does not exist until this runs. Run it as the same
administrator that applied the migrations, and with the same
`API_DATABASE_PASSWORD` the deployment was given.

```bash
psql "host=$PGHOST port=5432 dbname=explorer user=explorer_admin sslmode=require" \
  -v ON_ERROR_STOP=1 \
  -v api_password="$API_DATABASE_PASSWORD" \
  -f infra/sql/application-role.sql
```

### 7. Check

The resources themselves:

```bash
az deployment group show -g rg-explorer-dev -n expd-007-dev \
  --query properties.outputs -o jsonc
```

The API is a separate question, and the honest answer is **not yet**. The web
app is created empty — `WEBSITE_RUN_FROM_PACKAGE` is `1` and no package has
been pushed — so App Service serves its own placeholder page and `/health`
answers 404. That is the expected state of a fresh environment.

Once the pipeline has deployed `apps/api` into it (EXPD-008, `docs/ci.md`),
the same URL is the check — and it is the check the pipeline itself makes
after every deploy:

```bash
curl "$(az deployment group show -g rg-explorer-dev -n expd-007-dev \
  --query properties.outputs.apiUrl.value -o tsv)/health"
```

`{"status":"ok","engineVersion":"..."}` means the plan, the app, the runtime
and the startup command are right. It still does not exercise PostgreSQL or
Redis, because nothing in the repository opens a connection to either yet
(EXPD-016).

prod is the same seven steps with `rg-explorer-prod` and
`main.prod.bicepparam`.

## How dev and prod differ

Only in size. Same resources, same wiring, same settings, same secret names —
which is the point, because an environment that is shaped differently from the
one it stands in for stops standing in for it.

| | dev | prod |
| --- | --- | --- |
| App Service plan | B1 | P1v3 |
| PostgreSQL | Standard_B1ms, Burstable, 32 GB | Standard_D2ds_v5, GeneralPurpose, 128 GB |
| Backups | 7 days, local | 35 days, geo-redundant |
| Database HA | none | zone redundant |
| Redis | Basic C0 | Standard C1 |
| Storage | Standard_LRS | Standard_ZRS |
| Key Vault | soft delete 7 days, purge protection off | soft delete 90 days, purge protection on |

Burstable PostgreSQL cannot be highly available, and a Basic Redis has no
replica. That is what dev is: the cheapest thing with the same shape.

Purge protection is on in prod and left off in dev on purpose. Once on it can
never be turned off, and a soft-deleted vault then cannot be cleared out early
— which is what you want around the secret that signs every access token, and
not what you want in an environment somebody tears down on a Friday. Soft
delete itself cannot be switched off at all, only shortened, so dev takes the
seven days Azure allows as a minimum and prod takes ninety.

## How the web app reaches the other four

Three connection strings and one identity.

`DATABASE_URL`, `REDIS_URL` and `AUTH_TOKEN_SECRET` are app settings whose
value is a Key Vault reference — `@Microsoft.KeyVault(VaultName=...;SecretName=...)`
— so the value lives in the vault and the app setting only names it. The web
app resolves them with its own managed identity, which the template grants
**Key Vault Secrets User**: read a secret's value, and nothing else.

Storage has no connection string at all. The account has
`allowSharedKeyAccess` off, so the two account keys do not work and there is
nothing to leak; the app is granted **Storage Blob Data Contributor** and
reaches blobs as itself. That is also what EXPD-021 needs, because a user
delegation key — the thing that signs an upload URL without a shared key —
comes from an identity, not from a key.

The order matters, and `main.bicep` writes the app settings last for that
reason: a Key Vault reference is resolved by the web app when it starts, so a
setting that names a secret the app cannot yet read leaves the app broken
until something restarts it.

## What this baseline is not

Written down here rather than discovered later.

1. **Everything is on the public internet**, closed by firewall and by
   credential rather than by network. PostgreSQL takes connections only from
   inside Azure, storage refuses anonymous reads and shared keys, Redis refuses
   anything but TLS. Private endpoints and VNet integration would be the next
   belt, and no ticket has asked for one.
2. **Nothing is monitored.** No Log Analytics workspace, no Application
   Insights, no alert. The App Service health check takes a sick instance out
   of rotation, and that is the whole of it.
3. **This does not deploy code.** It creates the place the API runs, not the
   thing that puts it there. `SCM_DO_BUILD_DURING_DEPLOYMENT` is `false` and
   `WEBSITE_RUN_FROM_PACKAGE` is `1`, so the app expects a built artefact.
   Building and pushing it is EXPD-008, which is now done: see `docs/ci.md`.
   The two settings above are why its package has to arrive whole.
4. **There is no CDN or static hosting** for `apps/creator-web`, `apps/studio`
   or `apps/admin`. The stack puts those on Vercel, which is not Azure and not
   this file.
5. **`az` is not in this repository's checks.** Nothing in `npm run test`
   reads these files, because the tool that would validate them is not
   installed by `npm install`. `az deployment group what-if` is the check,
   and it is still one somebody runs. EXPD-008 deploys the API and the web
   apps; it does not deploy what is under them, so these files are applied
   by hand exactly as this page describes.
