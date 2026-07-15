targetScope = 'resourceGroup'

@description('Existing App Service application to amend in place.')
param webAppName string

@description('Existing Azure AI Services account used by Voice Live.')
param aiAccountName string

@description('Existing App Service system-assigned managed identity principal ID.')
param webAppPrincipalId string

@description('Optional keyless Azure Voice Live endpoint. Defaults to the selected AI Services account.')
param voiceLiveEndpoint string = ''

var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var foundryUserRoleId = '53ca6127-db72-4b80-b1b0-d745d6d5456d'
var effectiveVoiceLiveEndpoint = empty(voiceLiveEndpoint)
  ? 'https://${aiAccountName}.cognitiveservices.azure.com/'
  : voiceLiveEndpoint

resource webApp 'Microsoft.Web/sites@2024-11-01' existing = {
  name: webAppName
}

resource currentWebConfig 'Microsoft.Web/sites/config@2024-11-01' existing = {
  parent: webApp
  name: 'web'
}

resource aiAccount 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: aiAccountName
}

module webConfig 'br/public:avm/res/web/site/config:0.2.2' = {
  name: 'voiceLiveWebConfig'
  params: {
    appName: webAppName
    enableTelemetry: false
    name: 'web'
    properties: union(currentWebConfig.properties, {
      alwaysOn: true
      webSocketsEnabled: true
    })
  }
}

module appSettings 'br/public:avm/res/web/site/config:0.2.2' = {
  name: 'voiceLiveAppSettings'
  params: {
    appName: webAppName
    currentAppSettings: list('${webApp.id}/config/appsettings', '2024-11-01').properties
    enableTelemetry: false
    name: 'appsettings'
    properties: {
      AZURE_VOICELIVE_ENDPOINT: effectiveVoiceLiveEndpoint
      AZURE_VOICELIVE_MODEL: 'gpt-realtime-1.5'
      AZURE_VOICELIVE_TRANSCRIPTION_MODEL: 'azure-speech'
    }
  }
}

resource cognitiveServicesUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aiAccount.id, webAppName, 'Cognitive Services User')
  scope: aiAccount
  properties: {
    principalId: webAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      cognitiveServicesUserRoleId
    )
  }
}

resource foundryUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aiAccount.id, webAppName, 'Foundry User')
  scope: aiAccount
  properties: {
    principalId: webAppPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      foundryUserRoleId
    )
  }
}

output webAppName string = webApp.name
output aiAccountName string = aiAccount.name