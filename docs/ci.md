# The pipeline

`.github/workflows/ci.yml` builds, checks and deploys this repository
(EXPD-008). One workflow holds all of it, because the ordering is the point:
`needs` is the only way to say "do not deploy this unless it passed" that
GitHub enforces, and it only works inside one workflow.

## What runs when

| Event                  | What happens                                          |
| ---------------------- | ----------------------------------------------------- |
| Pull request to `main` | Lint, test, build. Nothing deploys.                   |
| Push to `main`         | The same, then a deploy to `dev`.                     |
| Run it by hand         | The same, then a deploy to the environment picked.    |

The six jobs:

| Job          | What it does                                                        |
| ------------ | -------------------------------------------------------------------- |
| `lint`       | `npm run typecheck` over every workspace. See the gap below.        |
| `test`       | `npm run test`. 726 tests, no database, no service.                 |
| `build-api`  | Builds the App Service package and starts it to check it serves.    |
| `build-web`  | Builds `creator-web`, `studio` and `admin`, in parallel.            |
| `deploy-api` | Pushes the package `build-api` made to App Service.                 |
| `deploy-web` | Pushes what `build-web` made to Vercel.                             |

The four checks run in parallel; the deploys wait for all of them. A deploy
never builds anything of its own — it takes the artefact the build job
uploaded, so what ships is what was checked, and not a second build of the
same commit that nobody looked at.

## The lint gap

`lint` runs `tsc`, and `tsc` is not a linter.

There is no ESLint and no Prettier in this repository. Adding one means adding
a dependency, and EXPD-008 was not allowed to — the same rule that left the
React Native CLI out of `apps/student-mobile` and a migration runner out of
`apps/api/db`.

What the job does catch is not nothing. `tsconfig.base.json` turns on `strict`,
`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch` and
`noUncheckedIndexedAccess`, which is most of what a linter's default rules are
for. An unused import, an unread parameter, a `switch` case that falls through
and an array index used without a check all fail the build already.

What is missing is everything about style and habit rather than types: import
order, `no-console`, exhaustive hook dependencies in the React apps, `await` in
a loop. Closing that is one devDependency and one config file:

```bash
npm install -D eslint typescript-eslint eslint-plugin-react-hooks
```

Until a ticket adds it, the job is named for the stage it occupies and its step
is named for what it actually runs.

## Building a package locally

Both scripts do what the pipeline does, on your own machine, with no Azure and
no Vercel involved.

```bash
scripts/package-api.sh            # build, stage, start it, check /health, zip
scripts/package-api.sh --no-zip   # stop before the zip
scripts/package-web.sh studio     # creator-web | studio | admin
```

Everything lands in `dist-deploy/`, which is ignored by git.

`package-api.sh` is doing more than it looks. App Service mounts the zip
read-only and installs nothing (`WEBSITE_RUN_FROM_PACKAGE` is 1 and
`SCM_DO_BUILD_DURING_DEPLOYMENT` is false, from EXPD-007), so the package has
to arrive whole, and two things could quietly go wrong:

- npm links a workspace into `node_modules` instead of copying it. A symlink
  in a mounted zip is not something to find out about in production, so the
  three `@explorer/*` links are replaced with real directories and the script
  fails if any symlink is left anywhere in the tree.
- A plain production install would pull `react-native` too, because it is a
  runtime dependency of a workspace that has nothing to do with the API. The
  install is scoped to `@explorer/api` and driven by `package-lock.json`, so
  the tree is express and what express needs: 1.6 MB rather than 305 MB.

Then it starts the package and asks it for `/health`. A package that cannot
serve its own health check fails in CI rather than after a deployment.

## Configuring an environment

The deploy jobs **skip themselves and stay green** when the environment they
would deploy to has not been set up. A clone of this repository has no Azure
subscription and no Vercel project behind it, and a red pipeline there would be
reporting on the repository's settings rather than on its code. When a job
skips, the run summary names every variable and secret that was missing.

Both sets belong to a GitHub Environment — `dev` or `prod` — and not to the
repository, because the whole point is that the two differ.

### Azure, for the API

| Name                    | Kind     | What it is                          |
| ----------------------- | -------- | ------------------------------------ |
| `AZURE_RESOURCE_GROUP`  | variable | `rg-explorer-dev` or `-prod`.       |
| `AZURE_API_APP_NAME`    | variable | The `apiAppName` deployment output. |
| `AZURE_CLIENT_ID`       | secret   | The CI app registration.            |
| `AZURE_TENANT_ID`       | secret   | The directory it is in.             |
| `AZURE_SUBSCRIPTION_ID` | secret   | The subscription.                   |

The two variables come from the EXPD-007 deployment:

```bash
az deployment group show -g rg-explorer-dev -n expd-007-dev \
  --query properties.outputs.apiAppName.value -o tsv
```

There is no password among those three secrets, on purpose. GitHub signs in
with a federated token it mints per run, which is the same reasoning EXPD-007
applied to the web app's managed identity: nothing holds a credential it does
not need, because a credential that is never stored is one that cannot leak.

```bash
az ad app create --display-name explorer-expedition-ci
APP_ID="$(az ad app list --display-name explorer-expedition-ci --query '[0].appId' -o tsv)"
az ad sp create --id "$APP_ID"

# Website Contributor deploys to a web app and does nothing else. Contributor
# on the group would also work, and would be more than this needs.
az role assignment create \
  --assignee "$APP_ID" \
  --role 'Website Contributor' \
  --scope "/subscriptions/<subscription-id>/resourceGroups/rg-explorer-dev"

# The subject is what ties the token to this repository and this environment.
# A run deploying to prod presents a different subject, so a dev credential
# cannot reach prod however the workflow is edited.
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-explorer-dev",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:Teczo/ExplorerExpedition:environment:dev",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

Repeat the role assignment and the federated credential for `prod`, against
`rg-explorer-prod` and `...:environment:prod`.

### Vercel, for the three React apps

| Name                            | Kind   | What it is                       |
| ------------------------------- | ------ | --------------------------------- |
| `VERCEL_TOKEN`                  | secret | An access token.                 |
| `VERCEL_ORG_ID`                 | secret | The team the projects are in.    |
| `VERCEL_PROJECT_ID_CREATOR_WEB` | secret | One project per app.             |
| `VERCEL_PROJECT_ID_STUDIO`      | secret |                                  |
| `VERCEL_PROJECT_ID_ADMIN`       | secret |                                  |

Three Vercel projects, one per app. None of them needs a build command, a root
directory or an install command set, because none of them builds anything:
`deploy-web` uploads a finished `.vercel/output` and passes `--prebuilt`, so
Vercel serves it and runs nothing.

That is the reason the apps are built here rather than there. Vercel building
them would be a second build, on a different machine, from a different install,
at a different moment — and the thing that shipped would not be the thing CI
checked.

`prod` gets Vercel's production deployment. `dev` gets a preview deployment:
the same build, on a URL that nobody has been given.

The Vercel CLI is fetched by `npx` at deploy time and pinned. It is not in
`package.json` for the same reason the Azure CLI is not: it is a tool the
pipeline runs, not something the platform imports.

## What this pipeline is not

Written down here rather than discovered later.

1. **It does not deploy infrastructure.** `infra/` is still applied by hand,
   and so are the migrations and `infra/sql/application-role.sql`. EXPD-007
   noted that `az deployment group what-if` could become an automatic check
   here; it has not, because this ticket's scope is the API and the web apps.
2. **It does not run migrations.** A deploy pushes code onto a schema that is
   already there. Nothing coordinates the two, and nothing rolls either back.
3. **There is no rollback.** Putting the previous commit back through the
   pipeline is the way back, which is fine while the API is one stateless
   process and stops being fine once a deploy changes a schema.
4. **`dev` deploys on every push to `main`.** There is no gate in front of it.
   `prod` is only ever reached by starting a run by hand, and a GitHub
   Environment protection rule is where an approval would go.
5. **Nothing tests the deployed thing beyond `/health`.** The check after a
   deploy is the same one the App Service probe makes. It proves the plan, the
   runtime, the startup command and the package are right, and it does not
   touch PostgreSQL or Redis, because nothing in the repository opens a
   connection to either yet (EXPD-016).
