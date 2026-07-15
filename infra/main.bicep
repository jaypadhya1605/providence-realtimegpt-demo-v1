targetScope = 'subscription'

@description('Azure Developer CLI environment name used for resource tags and deployment names.')
param environmentName string

@description('Primary Azure region for all regional resources.')
param location string = 'eastus2'

@description('Azure region for the App Service plan and web app.')
param appServiceLocation string = 'eastus'

@description('Resource group name for the demo environment.')
param resourceGroupName string = 'rg-empathy-avatar-demo'

@description('Optional email recipient for budget alerts. Leave empty to skip budget deployment.')
param budgetContactEmail string = ''

var tags = {
  application: 'EmpathyAI Avatar Demo'
  dataClassification: 'SyntheticOnly'
  environment: 'poc'
  managedBy: 'azd'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources './resources.bicep' = {
  name: 'empathy-avatar-${environmentName}'
  scope: resourceGroup
  params: {
    environmentName: environmentName
    location: location
    appServiceLocation: appServiceLocation
    tags: tags
  }
}

module budget 'br/public:avm/res/consumption/budget:0.3.8' = if (!empty(budgetContactEmail)) {
  name: 'budget-${environmentName}'
  params: {
    amount: 250
    name: 'bud-empathy-avatar-${environmentName}'
    contactEmails: [
      budgetContactEmail
    ]
    location: location
    resourceGroupFilter: [
      resourceGroup.name
    ]
    thresholds: [
      50
      80
      100
    ]
  }
  dependsOn: [
    resources
  ]
}

output AZURE_LOCATION string = location
output AZURE_APP_SERVICE_LOCATION string = appServiceLocation
output AZURE_RESOURCE_GROUP string = resourceGroup.name
output AZURE_AI_ACCOUNT_NAME string = resources.outputs.aiAccountName
output AZURE_AI_PROJECT_NAME string = resources.outputs.aiProjectName
output AZURE_AI_ENDPOINT string = resources.outputs.aiEndpoint
output APPLICATIONINSIGHTS_CONNECTION_STRING string = resources.outputs.applicationInsightsConnectionString
output SERVICE_WEB_NAME string = resources.outputs.webAppName
output SERVICE_WEB_URI string = resources.outputs.webAppUri
output WEB_APP_PRINCIPAL_ID string = resources.outputs.webAppPrincipalId
