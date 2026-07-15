targetScope = 'resourceGroup'

@description('Azure Developer CLI environment name used for runtime build labeling.')
param environmentName string

@description('Primary Azure region.')
param location string

@description('Azure region for the App Service plan and web app.')
param appServiceLocation string

@description('Common resource tags.')
param tags object

@description('Linux App Service plan SKU.')
param appServiceSku string = 'P0v3'

@description('Realtime conversation deployment capacity.')
param realtimeCapacity int = 1

@description('Realtime input-transcription deployment capacity.')
param transcriptionCapacity int = 1

@description('Enable sanitized result persistence. Raw audio and raw transcripts are never persisted.')
param persistResults bool = false

var resourceSuffix = take(uniqueString(subscription().subscriptionId, resourceGroup().id, environmentName), 8)
var appServicePlanName = 'asp-empathy-${resourceSuffix}'
var webAppName = 'app-empathy-avatar-${resourceSuffix}'
var aiAccountName = 'fndry-empathy-${resourceSuffix}'
var aiProjectName = 'proj-empathy-${resourceSuffix}'
var storageAccountName = 'stempathy${resourceSuffix}'
var logAnalyticsName = 'log-empathy-${resourceSuffix}'
var applicationInsightsName = 'appi-empathy-${resourceSuffix}'
var realtimeDeploymentName = 'gpt-realtime-1-5'
var transcriptionDeploymentName = 'gpt-realtime-whisper'
var cognitiveServicesUserRoleId = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var foundryUserRoleId = '53ca6127-db72-4b80-b1b0-d745d6d5456d'
var webAppUri = 'https://${webAppName}.azurewebsites.net'
var aiEndpoint = 'https://${aiAccountName}.openai.azure.com'
var voiceLiveEndpoint = 'https://${aiAccountName}.cognitiveservices.azure.com/'
var storageAccountUrl = 'https://${storageAccountName}.blob.${environment().suffixes.storage}'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2025-07-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
    workspaceCapping: {
      dailyQuotaGb: 1
    }
  }
}

module applicationInsights 'br/public:avm/res/insights/component:0.7.2' = {
  name: 'applicationInsightsDeployment'
  params: {
    name: applicationInsightsName
    location: location
    applicationType: 'web'
    disableLocalAuth: true
    workspaceResourceId: logAnalytics.id
    tags: tags
  }
}

module appServicePlan 'br/public:avm/res/web/serverfarm:0.7.0' = {
  name: 'appServicePlanDeployment'
  params: {
    name: appServicePlanName
    location: appServiceLocation
    kind: 'linux'
    reserved: true
    skuCapacity: 1
    skuName: appServiceSku
    zoneRedundant: false
    tags: tags
  }
}

module webApp 'br/public:avm/res/web/site:0.23.1' = {
  name: 'webAppDeployment'
  params: {
    name: webAppName
    kind: 'app,linux'
    location: appServiceLocation
    serverFarmResourceId: appServicePlan.outputs.resourceId
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    basicPublishingCredentialsPolicies: [
      {
        name: 'ftp'
        allow: false
      }
      {
        name: 'scm'
        allow: false
      }
    ]
    managedIdentities: {
      systemAssigned: true
    }
    siteConfig: {
      alwaysOn: true
      ftpsState: 'Disabled'
      healthCheckPath: '/healthz'
      http20Enabled: true
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      webSocketsEnabled: true
    }
    configs: [
      {
        name: 'web'
        properties: {
          appCommandLine: 'bash startup.sh'
          linuxFxVersion: 'PYTHON|3.12'
        }
      }
      {
        name: 'appsettings'
        applicationInsightResourceId: applicationInsights.outputs.resourceId
        properties: {
          APP_ENV: 'azure'
          APP_MODE: 'azure'
          ALLOWED_ORIGINS: webAppUri
          AZURE_AI_ENDPOINT: aiEndpoint
          AZURE_REALTIME_DEPLOYMENT: realtimeDeploymentName
          AZURE_RESULT_CONTAINER: 'session-results'
          AZURE_SCENARIO_CONTAINER: 'scenario-config'
          AZURE_STORAGE_ACCOUNT_URL: storageAccountUrl
          AZURE_TRANSCRIPTION_DEPLOYMENT: transcriptionDeploymentName
          AZURE_VOICELIVE_ENDPOINT: voiceLiveEndpoint
          AZURE_VOICELIVE_MODEL: 'gpt-realtime-1.5'
          AZURE_VOICELIVE_TRANSCRIPTION_MODEL: 'azure-speech'
          BUILD_LABEL: environmentName
          DEBUG_TRACE: 'false'
          ENABLE_ORYX_BUILD: 'true'
          FRONTEND_DIST_PATH: 'frontend/dist'
          PERSIST_RESULTS: string(persistResults)
          PYTHONUNBUFFERED: '1'
          SCM_DO_BUILD_DURING_DEPLOYMENT: 'true'
          SESSION_MAX_MINUTES: '15'
        }
      }
    ]
    tags: union(tags, {
      'azd-service-name': 'web'
    })
  }
}

module aiAccount 'br/public:avm/res/cognitive-services/account:0.15.0' = {
  name: 'aiAccountDeployment'
  params: {
    name: aiAccountName
    kind: 'AIServices'
    location: location
    sku: 'S0'
    allowProjectManagement: true
    customSubDomainName: aiAccountName
    disableLocalAuth: true
    managedIdentities: {
      systemAssigned: true
    }
    publicNetworkAccess: 'Enabled'
    deployments: [
      {
        name: realtimeDeploymentName
        model: {
          format: 'OpenAI'
          name: 'gpt-realtime-1.5'
          version: '2026-02-23'
        }
        sku: {
          name: 'GlobalStandard'
          capacity: realtimeCapacity
        }
        versionUpgradeOption: 'NoAutoUpgrade'
      }
      {
        name: transcriptionDeploymentName
        model: {
          format: 'OpenAI'
          name: 'gpt-realtime-whisper'
          version: '2026-05-06'
        }
        sku: {
          name: 'GlobalStandard'
          capacity: transcriptionCapacity
        }
        versionUpgradeOption: 'NoAutoUpgrade'
      }
    ]
    roleAssignments: [
      {
        principalId: webApp.outputs.systemAssignedMIPrincipalId!
        principalType: 'ServicePrincipal'
        roleDefinitionIdOrName: 'Cognitive Services OpenAI User'
      }
    ]
    tags: tags
  }
}

resource aiAccountResource 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: aiAccountName
}

resource cognitiveServicesUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aiAccountResource.id, webAppName, 'Cognitive Services User')
  scope: aiAccountResource
  properties: {
    principalId: webApp.outputs.systemAssignedMIPrincipalId!
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      cognitiveServicesUserRoleId
    )
  }
  dependsOn: [
    aiAccount
  ]
}

resource foundryUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aiAccountResource.id, webAppName, 'Foundry User')
  scope: aiAccountResource
  properties: {
    principalId: webApp.outputs.systemAssignedMIPrincipalId!
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      foundryUserRoleId
    )
  }
  dependsOn: [
    aiAccount
  ]
}

resource aiProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: aiAccountResource
  name: aiProjectName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    description: 'Synthetic caregiver empathy-training avatar demo.'
    displayName: 'EmpathyAI Avatar Demo'
  }
  tags: tags
  dependsOn: [
    aiAccount
  ]
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2025-06-01' = {
  name: storageAccountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    sasPolicy: {
      expirationAction: 'Block'
      sasExpirationPeriod: '00.01:00:00'
    }
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-06-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 7
    }
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource scenarioContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobService
  name: 'scenario-config'
  properties: {
    publicAccess: 'None'
  }
}

resource resultsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-06-01' = {
  parent: blobService
  name: 'session-results'
  properties: {
    publicAccess: 'None'
  }
}

resource storageManagementPolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2025-06-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-sanitized-results-after-seven-days'
          type: 'Lifecycle'
          enabled: true
          definition: {
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: 7
                }
              }
            }
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                'session-results/'
              ]
            }
          }
        }
      ]
    }
  }
}

resource storageDataContributorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, webAppName, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    principalId: webApp.outputs.systemAssignedMIPrincipalId!
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
    )
  }
}

resource applicationInsightsResource 'Microsoft.Insights/components@2020-02-02' existing = {
  name: applicationInsightsName
}

resource telemetryPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsightsResource.id, webAppName, 'Monitoring Metrics Publisher')
  scope: applicationInsightsResource
  properties: {
    principalId: webApp.outputs.systemAssignedMIPrincipalId!
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      '3913510d-42f4-4e42-8a64-420c390055eb'
    )
  }
}

output webAppName string = webAppName
output webAppUri string = 'https://${webApp.outputs.defaultHostname!}'
output webAppPrincipalId string = webApp.outputs.systemAssignedMIPrincipalId!
output aiAccountName string = aiAccountName
output aiProjectName string = aiProject.name
output aiEndpoint string = aiEndpoint
output storageAccountName string = storageAccountName
output applicationInsightsConnectionString string = applicationInsights.outputs.connectionString!
