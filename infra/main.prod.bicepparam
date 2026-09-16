/*
  prod (EXPD-007).

  The same template as dev, with the sizes `main.bicep` holds for prod: a
  zone-redundant database, 35 days of geo-redundant backups, zone-redundant
  storage, and a vault that cannot be purged.

  The three secrets are read from the environment rather than written here,
  because this file is committed and they must not be. `infra/README.md` says
  where they come from.
*/

using './main.bicep'

param environmentName = 'prod'
param location = 'westeurope'

param postgresAdministratorLogin = 'explorer_admin'
param postgresAdministratorPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD')
param apiDatabasePassword = readEnvironmentVariable('API_DATABASE_PASSWORD')
param authTokenSecret = readEnvironmentVariable('AUTH_TOKEN_SECRET')
