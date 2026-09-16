/*
  The storage account expedition media lands in (EXPD-007).

  Students photograph things (EXPD-033, EXPD-044) and creators upload assets
  (EXPD-030). All of it is a blob, and some of it is a photograph of a child,
  so the account is closed by default: no anonymous read, no unencrypted
  transfer, and no shared key.

  Turning off shared keys is what makes the managed identity the only way in.
  With `allowSharedKeyAccess` left on, anybody holding either of the two
  account keys can read every container, and those keys travel through
  whatever copied them. With it off, access is a role assignment, which is
  auditable and can be taken away from one principal without rotating
  anything.
*/

@description('The account name. Globally unique, lower case letters and digits only.')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region.')
param location string

@description('Tags for the account.')
param tags object

@description('Redundancy, such as Standard_LRS.')
param skuName string

@description('The blob containers to create.')
param containerNames array

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: {
          enabled: true
        }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    // A blob a mission was scored on should survive somebody deleting it by
    // mistake for long enough to notice. Seven days in dev and prod alike,
    // because the cost of a soft-deleted blob is the blob.
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for containerName in containerNames: {
    parent: blobService
    name: containerName
    properties: {
      // None, not Blob: nothing here is readable without a signature, and a
      // container that read anonymously would be a photograph of a child on
      // the open internet.
      publicAccess: 'None'
    }
  }
]

@description('The account\'s name.')
output name string = account.name

@description('The blob endpoint, such as https://stexpddev....blob.core.windows.net/.')
output blobEndpoint string = account.properties.primaryEndpoints.blob

@description('The account\'s resource id.')
output id string = account.id
