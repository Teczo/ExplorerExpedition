/*
  The Explorer Expedition Azure baseline (EXPD-007).

  One template, deployed once per environment. `main.dev.bicepparam` and
  `main.prod.bicepparam` are the two environments the platform has, and the
  only thing that differs between them is the size of what gets created. That
  is written down in `sizing` below rather than in the parameter files, so the
  two environments cannot drift into different shapes.

  What it creates:

    - a Linux App Service plan and one web app, for `apps/api`
    - Azure Database for PostgreSQL Flexible Server, and the `explorer` database
    - a storage account with the `media` blob container
    - Azure Cache for Redis
    - a Key Vault holding the three secrets the API reads

  The web app reaches storage as itself, with a managed identity, and holds no
  key for it. PostgreSQL and Redis are reached with connection strings, which
  are secrets, so those go in the vault and the app settings are references to
  it rather than the values.

  Deployed at resource group scope. The group is not created here, so a
  deployment needs Contributor on one group rather than on a subscription.
  `infra/README.md` has the commands.
*/

targetScope = 'resourceGroup'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

@description('Which environment this deployment is. Decides every size below.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region for every resource. Defaults to the resource group\'s.')
param location string = resourceGroup().location

@description('The administrator login for PostgreSQL. Not the login the API uses.')
@minLength(4)
param postgresAdministratorLogin string = 'explorer_admin'

@description('The administrator password for PostgreSQL. Supply at deploy time; never commit one.')
@secure()
@minLength(16)
param postgresAdministratorPassword string

@description('The password for the explorer_api role the API signs in as. See infra/sql/application-role.sql.')
@secure()
@minLength(16)
param apiDatabasePassword string

@description('AUTH_TOKEN_SECRET, which signs access tokens (EXPD-004). At least 32 bytes.')
@secure()
@minLength(32)
param authTokenSecret string

@description('How the web app starts the API. EXPD-008 owns what it deploys; this owns where it lands.')
param apiStartupCommand string = 'node apps/api/dist/index.js'

@description('Extra tags merged onto every resource.')
param additionalTags object = {}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------
//
// dev is the cheapest thing that still has the same shape as prod: the same
// resources, the same wiring, the same secrets, on the smallest SKU each one
// offers. It exists to be got wrong in cheaply, so it is deliberately not
// highly available and its backups are short.

var sizing = {
  dev: {
    appServicePlanSku: 'B1'
    postgresSkuName: 'Standard_B1ms'
    postgresSkuTier: 'Burstable'
    postgresStorageGb: 32
    postgresBackupRetentionDays: 7
    postgresGeoRedundantBackup: 'Disabled'
    postgresHighAvailability: 'Disabled'
    redisSkuName: 'Basic'
    redisFamily: 'C'
    redisCapacity: 0
    storageSku: 'Standard_LRS'
    keyVaultSoftDeleteRetentionDays: 7
    keyVaultPurgeProtection: false
  }
  prod: {
    appServicePlanSku: 'P1v3'
    postgresSkuName: 'Standard_D2ds_v5'
    postgresSkuTier: 'GeneralPurpose'
    postgresStorageGb: 128
    postgresBackupRetentionDays: 35
    postgresGeoRedundantBackup: 'Enabled'
    postgresHighAvailability: 'ZoneRedundant'
    redisSkuName: 'Standard'
    redisFamily: 'C'
    redisCapacity: 1
    storageSku: 'Standard_ZRS'
    keyVaultSoftDeleteRetentionDays: 90
    keyVaultPurgeProtection: true
  }
}

var size = sizing[environmentName]

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
//
// Four of these have to be unique across the whole of Azure, not just this
// subscription, so they carry a suffix derived from the resource group. The
// same group always produces the same suffix, which is what makes a second
// deployment an update rather than a second set of resources.

var suffix = uniqueString(resourceGroup().id)

var names = {
  appServicePlan: 'plan-expd-${environmentName}'
  apiApp: 'app-expd-${environmentName}-${suffix}'
  postgres: 'psql-expd-${environmentName}-${suffix}'
  redis: 'redis-expd-${environmentName}-${suffix}'
  storage: 'stexpd${environmentName}${suffix}'
  keyVault: 'kv-expd-${environmentName}-${take(suffix, 8)}'
}

var databaseName = 'explorer'
var apiDatabaseLogin = 'explorer_api'
var mediaContainerName = 'media'

var tags = union(
  {
    project: 'explorer-expedition'
    environment: environmentName
    managedBy: 'infra/main.bicep'
    ticket: 'EXPD-007'
  },
  additionalTags
)

// The secret names live here because the resources that write them and the
// app settings that read them both have to agree on them.
var secretNames = {
  databaseUrl: 'database-url'
  redisUrl: 'redis-url'
  authTokenSecret: 'auth-token-secret'
}

// ---------------------------------------------------------------------------
// The four resources the ticket asks for
// ---------------------------------------------------------------------------

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: names.postgres
    location: location
    tags: tags
    skuName: size.postgresSkuName
    skuTier: size.postgresSkuTier
    storageSizeGb: size.postgresStorageGb
    backupRetentionDays: size.postgresBackupRetentionDays
    geoRedundantBackup: size.postgresGeoRedundantBackup
    highAvailabilityMode: size.postgresHighAvailability
    administratorLogin: postgresAdministratorLogin
    administratorPassword: postgresAdministratorPassword
    databaseName: databaseName
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    name: names.storage
    location: location
    tags: tags
    skuName: size.storageSku
    containerNames: [
      mediaContainerName
    ]
  }
}

module redis 'modules/redis.bicep' = {
  name: 'redis'
  params: {
    name: names.redis
    location: location
    tags: tags
    skuName: size.redisSkuName
    family: size.redisFamily
    capacity: size.redisCapacity
  }
}

module api 'modules/app-service.bicep' = {
  name: 'app-service'
  params: {
    planName: names.appServicePlan
    siteName: names.apiApp
    location: location
    tags: tags
    planSkuName: size.appServicePlanSku
    startupCommand: apiStartupCommand
    alwaysOn: true
  }
}

// ---------------------------------------------------------------------------
// The vault that joins them up
// ---------------------------------------------------------------------------
//
// Declared here rather than in a module so that the secrets below are its
// children, and therefore wait for it without anybody having to say so.
//
// Access is by Azure RBAC, not by the vault's own access policies, so that
// who may read a secret is answered in the same place as who may read
// anything else. The web app is granted Key Vault Secrets User below, which
// is read of a secret's value and nothing more: it cannot write one, list the
// vault's settings, or delete anything. That grant is in
// `modules/api-access.bicep`, for a reason it explains.

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: names.keyVault
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    // Soft delete cannot be switched off, only shortened. A deleted vault
    // holds on to its name for this long, so dev takes the shortest window
    // Azure allows and prod takes the longest.
    softDeleteRetentionInDays: size.keyVaultSoftDeleteRetentionDays
    // Purge protection, on the other hand, can be turned on and never off
    // again, and it is what stops a soft-deleted vault being purged early. So
    // dev leaves it unset rather than false: a dev vault nobody can clear out
    // is a dev environment nobody can recreate. `null` is how Bicep leaves a
    // property alone.
    enablePurgeProtection: size.keyVaultPurgeProtection ? true : null
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

// ---------------------------------------------------------------------------
// The secrets
// ---------------------------------------------------------------------------
//
// The Redis key is only knowable once Redis exists, and a module output would
// put it in the deployment history in clear. Reading it here with `listKeys`
// keeps it inside this file, where it goes straight into the vault.

resource redisAccount 'Microsoft.Cache/redis@2024-11-01' existing = {
  name: names.redis
}

resource apiSite 'Microsoft.Web/sites@2023-12-01' existing = {
  name: names.apiApp
}

// The API signs in as explorer_api, not as the server administrator. That role
// does not exist until somebody applies infra/sql/application-role.sql, which
// is the step after this deployment.
var databaseUrl = 'postgresql://${apiDatabaseLogin}:${uriComponent(apiDatabasePassword)}@${postgres.outputs.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'

resource databaseUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: secretNames.databaseUrl
  properties: {
    value: databaseUrl
    contentType: 'PostgreSQL connection string for the explorer_api role'
  }
}

resource redisUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: secretNames.redisUrl
  properties: {
    value: 'rediss://:${uriComponent(redisAccount.listKeys().primaryKey)}@${redisAccount.properties.hostName}:${redisAccount.properties.sslPort}'
    contentType: 'Redis connection string, TLS only'
  }
  dependsOn: [
    redis
  ]
}

resource authTokenSecretEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: secretNames.authTokenSecret
  properties: {
    value: authTokenSecret
    contentType: 'AUTH_TOKEN_SECRET (EXPD-004)'
  }
}

// ---------------------------------------------------------------------------
// What the web app is allowed to reach
// ---------------------------------------------------------------------------
//
// In a module because a role assignment's name has to be computable before the
// deployment starts, and the app's principal id is not: it exists only once
// the app does. The module explains the rest.

module apiAccess 'modules/api-access.bicep' = {
  name: 'api-access'
  params: {
    keyVaultName: keyVault.name
    storageAccountName: names.storage
    principalId: api.outputs.principalId
  }
  dependsOn: [
    storage
  ]
}

// ---------------------------------------------------------------------------
// The app settings
// ---------------------------------------------------------------------------
//
// Written last, and on purpose. A Key Vault reference is resolved by the web
// app itself, so the app has to be able to read the vault before a setting
// naming one exists — otherwise the first start fails on an unresolved
// reference and stays failed until something restarts it. Everything this
// needs is therefore listed below it.
//
// This is the only writer of app settings, which is what makes it safe: the
// call replaces the whole collection, so a second writer would silently drop
// the first one's settings.

resource apiAppSettings 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: apiSite
  name: 'appsettings'
  properties: {
    NODE_ENV: environmentName == 'prod' ? 'production' : 'development'
    AUTH_TOKEN_SECRET: '@Microsoft.KeyVault(VaultName=${names.keyVault};SecretName=${secretNames.authTokenSecret})'
    DATABASE_URL: '@Microsoft.KeyVault(VaultName=${names.keyVault};SecretName=${secretNames.databaseUrl})'
    REDIS_URL: '@Microsoft.KeyVault(VaultName=${names.keyVault};SecretName=${secretNames.redisUrl})'
    // Storage is reached with the app's own identity, so there is no key here
    // to leak. EXPD-021 signs its upload URLs with a user delegation key,
    // which is what that identity is for.
    AZURE_STORAGE_ACCOUNT: names.storage
    AZURE_STORAGE_BLOB_ENDPOINT: storage.outputs.blobEndpoint
    AZURE_STORAGE_MEDIA_CONTAINER: mediaContainerName
    // App Service builds nothing. EXPD-008 pushes an artefact that is already
    // built, so a build here would only be a second, different one.
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
    WEBSITE_RUN_FROM_PACKAGE: '1'
  }
  dependsOn: [
    api
    apiAccess
    databaseUrlSecret
    redisUrlSecret
    authTokenSecretEntry
  ]
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('The API\'s public URL. /health answers on it.')
output apiUrl string = 'https://${api.outputs.defaultHostName}'

@description('The web app\'s name, for `az webapp deploy` in EXPD-008.')
output apiAppName string = names.apiApp

@description('The PostgreSQL host. psql connects to it to apply the migrations.')
output postgresHost string = postgres.outputs.fullyQualifiedDomainName

@description('The database the migrations go in.')
output postgresDatabaseName string = databaseName

@description('The role the API signs in as, which application-role.sql creates.')
output apiDatabaseLogin string = apiDatabaseLogin

@description('The storage account holding the media container.')
output storageAccountName string = names.storage

@description('The blob container media uploads land in (EXPD-021).')
output mediaContainerName string = mediaContainerName

@description('The Redis host.')
output redisHostName string = redis.outputs.hostName

@description('The vault holding the three secrets.')
output keyVaultName string = names.keyVault
