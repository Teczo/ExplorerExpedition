/*
  What the web app is allowed to reach (EXPD-007).

  Two role assignments, and the reason they are in a module of their own: the
  name of a role assignment has to be computable before the deployment starts,
  and the app's principal id is not — it exists only once the app has been
  created. A module parameter is computable at the start of that module, which
  is what breaks the circle.

  Both grants are the narrow one. Key Vault Secrets User reads a secret's
  value and cannot write, list or delete. Storage Blob Data Contributor reads
  and writes blobs in this account and cannot touch the account itself.
*/

@description('The vault holding the API\'s secrets.')
param keyVaultName string

@description('The storage account holding expedition media.')
param storageAccountName string

@description('The object id of the web app\'s managed identity.')
param principalId string

// Built-in role definition ids. The same in every subscription.
var keyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'
var storageBlobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource readsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, principalId, keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUser)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource writesBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, principalId, storageBlobDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributor)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
