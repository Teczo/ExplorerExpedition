/*
  dev (EXPD-007).

  The three secrets are read from the environment rather than written here,
  because this file is committed and they must not be. `infra/README.md` says
  where they come from.

  `location` is the one value worth changing before a first deployment: pick
  the region the schools are in, not the one this file was written in.
*/

using './main.bicep'

param environmentName = 'dev'
param location = 'westeurope'

param postgresAdministratorLogin = 'explorer_admin'
param postgresAdministratorPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD')
param apiDatabasePassword = readEnvironmentVariable('API_DATABASE_PASSWORD')
param authTokenSecret = readEnvironmentVariable('AUTH_TOKEN_SECRET')
