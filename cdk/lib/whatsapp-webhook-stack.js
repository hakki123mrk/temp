const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const path = require('path');

class WhatsAppWebhookStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Lambda function
    const webhookFunction = new lambda.Function(this, 'WhatsAppWebhookFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'lambda.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../..'), {
        exclude: [
          'node_modules',
          'cdk',
          '.git',
          '.env',
          'data',
          'logs',
          'events',
          '*.log',
          '*.md',
          'samples',
          '.gitignore'
        ],
        bundling: {
          image: lambda.Runtime.NODEJS_18_X.bundlingImage,
          command: [
            'bash', '-c',
            'npm install --production && cp -r . /asset-output/'
          ]
        }
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        NODE_ENV: 'production',
        // Add your environment variables here or use .env file
      },
      description: 'WhatsApp Commerce Webhook Handler'
    });

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

    // Add webhook routes
    const webhook = api.root.addResource('webhook');
    webhook.addMethod('GET', webhookIntegration); // For verification
    webhook.addMethod('POST', webhookIntegration); // For events

    // Add health check
    const health = api.root.addResource('health');
    health.addMethod('GET', webhookIntegration);

    // Add API routes
    const apiResource = api.root.addResource('api');
    
    const sendMessage = apiResource.addResource('send-message');
    sendMessage.addMethod('POST', webhookIntegration);
    
    const requestAddress = apiResource.addResource('request-address');
    requestAddress.addMethod('POST', webhookIntegration);

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL',
      exportName: 'WhatsAppWebhookApiUrl'
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: webhookFunction.functionName,
      description: 'Lambda Function Name',
      exportName: 'WhatsAppWebhookFunctionName'
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: webhookFunction.functionArn,
      description: 'Lambda Function ARN',
      exportName: 'WhatsAppWebhookFunctionArn'
    });
  }
}

module.exports = { WhatsAppWebhookStack };
