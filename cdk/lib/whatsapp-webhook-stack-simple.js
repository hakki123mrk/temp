const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const path = require('path');

class WhatsAppWebhookStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // DynamoDB table for storing messages and orders
    const messagesTable = new dynamodb.Table(this, 'MessagesTable', {
      partitionKey: { name: 'waId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Add GSI for querying by message type
    messagesTable.addGlobalSecondaryIndex({
      indexName: 'MessageTypeIndex',
      partitionKey: { name: 'messageType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
    });

    // Add GSI for querying by order reference
    messagesTable.addGlobalSecondaryIndex({
      indexName: 'OrderRefIndex',
      partitionKey: { name: 'orderRef', type: dynamodb.AttributeType.STRING },
    });

    // Lambda function with product catalog
    const webhookFunction = new lambda.Function(this, 'WhatsAppWebhookFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        MESSAGES_TABLE_NAME: messagesTable.tableName,
        NODE_ENV: 'production',
        VERIFY_TOKEN: 'wbYWVNbLn1hbOJF5wE6tJQughSMZAR8UvZB85dYiJBDlO',
        WHATSAPP_PHONE_NUMBER_ID: '116206601581617',
        WHATSAPP_API_TOKEN: 'YOUR_WHATSAPP_API_TOKEN'
      },
      description: 'WhatsApp Commerce Webhook Handler'
    });

    // Grant Lambda permission to write to DynamoDB
    messagesTable.grantWriteData(webhookFunction);

    // API Gateway
    const api = new apigateway.RestApi(this, 'WhatsAppWebhookApi', {
      restApiName: 'WhatsApp Webhook Service',
      description: 'API Gateway for WhatsApp webhook',
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200
      }
    });

    // Lambda integration
    const webhookIntegration = new apigateway.LambdaIntegration(webhookFunction, {
      proxy: true,
      allowTestInvoke: true
    });

    // Add routes
    api.root.addProxy({
      defaultIntegration: webhookIntegration,
      anyMethod: true
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL - Use this as your webhook URL',
      exportName: 'WhatsAppWebhookApiUrl'
    });

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.url}webhook`,
      description: 'Full webhook endpoint URL',
      exportName: 'WhatsAppWebhookEndpoint'
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: webhookFunction.functionName,
      description: 'Lambda Function Name',
      exportName: 'WhatsAppWebhookFunctionName'
    });
  }
}

module.exports = { WhatsAppWebhookStack };
