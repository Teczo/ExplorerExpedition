/*
  Azure Database for PostgreSQL Flexible Server, and the one database the
  platform uses (EXPD-007).

  Version 16, because `apps/api/db` needs 14 or newer for `gen_random_uuid()`
  and there is no reason to start further back than the current major.

  The server is reachable over the public internet and closed to everything
  except Azure, which is the firewall rule below. That is the baseline, not
  the destination: private networking is a later ticket, and the note in
  `infra/README.md` says so.
*/

@description('The server name. Globally unique.')
param name string

@description('Azure region.')
param location string

@description('Tags for the server.')
param tags object

@description('Compute size, such as Standard_B1ms.')
param skuName string

@description('Compute tier the SKU belongs to.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param skuTier string

@description('Disk size in GB. It can be grown later, never shrunk.')
param storageSizeGb int

@description('How many days of backups to keep.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int

@description('Whether backups are copied to the paired region.')
@allowed([
  'Enabled'
  'Disabled'
])
param geoRedundantBackup string

@description('High availability. Burstable supports only Disabled.')
@allowed([
  'Disabled'
  'ZoneRedundant'
  'SameZone'
])
param highAvailabilityMode string

@description('The server administrator login.')
param administratorLogin string

@description('The server administrator password.')
@secure()
param administratorPassword string

@description('The database to create on it.')
param databaseName string

@description('The major version of PostgreSQL.')
param postgresVersion string = '16'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGb
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    highAvailability: {
      mode: highAvailabilityMode
    }
    authConfig: {
      // Password authentication, because that is what a connection string in
      // Key Vault is. Entra authentication would remove the password
      // altogether and is worth doing; it is not this ticket.
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// The database the migrations in `apps/api/db/migrations` are applied to.
// Collation and encoding are stated rather than left to the server default,
// because a database that sorts differently between dev and prod is a class
// of bug that only shows up in one of them.
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

// 0.0.0.0 to 0.0.0.0 is not "every address". It is the one rule Azure reads as
// "resources inside Azure", which is how the web app gets in. Nothing on the
// public internet matches it.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [
    database
  ]
}

@description('The host to connect to.')
output fullyQualifiedDomainName string = server.properties.fullyQualifiedDomainName

@description('The server\'s name.')
output name string = server.name

@description('The database that was created on it.')
output databaseName string = database.name
