/*
  The Linux App Service plan and the web app that runs `apps/api` (EXPD-007).

  App Service rather than Container Apps: the API is one Node process behind
  one hostname, and there is no second container to schedule beside it. The
  thing that would argue for Container Apps — many services, scaled apart —
  is not the shape of this repository, and a platform that has to be learned
  before a health check can be read is a cost paid every time somebody new
  looks at it.

  It creates no app settings. The caller writes those in one go once the app
  can read the vault they point at; `main.bicep` explains why the order
  matters.
*/

@description('The App Service plan name.')
param planName string

@description('The web app name. Globally unique: it becomes <name>.azurewebsites.net.')
param siteName string

@description('Azure region.')
param location string

@description('Tags for both resources.')
param tags object

@description('Plan size, such as B1 or P1v3.')
param planSkuName string

@description('The command that starts the API.')
param startupCommand string

@description('Whether to keep the app warm. Off means the first request after a quiet spell pays for a cold start.')
param alwaysOn bool = true

@description('The Node runtime on the plan.')
param nodeRuntime string = 'NODE|22-lts'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: planSkuName
  }
  properties: {
    // `reserved` is how an App Service plan says Linux. Without it the plan is
    // a Windows one whatever `kind` claims.
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: siteName
  location: location
  tags: tags
  kind: 'app,linux'
  identity: {
    // The app's own identity. It is what reads the vault and what writes a
    // blob, so neither needs a key stored anywhere.
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: nodeRuntime
      appCommandLine: startupCommand
      alwaysOn: alwaysOn
      // The platform's own probe. It calls /health, which `apps/api/src/app.ts`
      // has served since EXPD-001, and takes an instance out of rotation when
      // it stops answering.
      healthCheckPath: '/health'
      http20Enabled: true
      minTlsVersion: '1.2'
      // Director Mode and the student app hold a socket open (EXPD-023).
      webSocketsEnabled: true
      ftpsState: 'Disabled'
      // Deployment is over the SCM endpoint with a token (EXPD-008), so the
      // publishing profile passwords are one more credential nothing needs.
      scmType: 'None'
    }
  }
}

@description('The web app\'s hostname.')
output defaultHostName string = site.properties.defaultHostName

@description('The web app\'s name.')
output name string = site.name

@description('The object id of the app\'s managed identity. Role assignments are made to it.')
output principalId string = site.identity.principalId
