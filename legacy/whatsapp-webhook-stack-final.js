const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const path = require('path');

class WhatsAppWebhookStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Create Lambda layer with dependencies
    const dependenciesLayer = new lambda.LayerVersion(this, 'DependenciesLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda-layer'), {
        bundling: {
          image: lambda.Runtime.NODEJS_18_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'mkdir -p /asset-output/nodejs',
              'cp package.json /asset-output/nodejs/',
              'cd /asset-output/nodejs',
              'npm install --production --no-optional',
              'rm package.json package-lock.json'
            ].join(' && ')
          ]
        }
      }),
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
      description: 'Dependencies for WhatsApp webhook'
    });

    // Lambda function
    const webhookFunction = new lambda.Function(this, 'WhatsAppWebhookFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const serverless = require('serverless-http');
const express = require('express');
const app = express();

app.use(express.json());

app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  
  console.log('Webhook verification:', { mode, token: token ? 'present' : 'missing' });
  
  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.log('Webhook verification failed');
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  console.log('Webhook event received:', JSON.stringify(req.body));
  res.status(200).send('EVENT_RECEIVED');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: 'lambda',
    version: '1.0.0'
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    apiVersion: '1.0',
    timestamp: new Date().toISOString() 
  });
});

exports.handler = serverless(app);
      `),
      layers: [dependenciesLayer],
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        NODE_ENV: 'production',
        VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'your-verify-token-here'
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
        throttlingBurstLimit: 200,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: true
      }
    });

    // Lambda integration
    const webhookIntegration = new apigateway.LambdaIntegration(webhookFunction, {
      proxy: true
    });

    // Add routes
    api.root.addProxy({
      defaultIntegration: webhookIntegration,
      anyMethod: true
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway URL - Use this as your webhook URL'
    });

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.url}webhook`,
      description: 'WhatsApp Webhook Endpoint - Configure this in WhatsApp Business'
    });

    new cdk.CfnOutput(this, 'HealthCheckUrl', {
      value: `${api.url}health`,
      description: 'Health check endpoint'
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: webhookFunction.functionName,
      description: 'Lambda Function Name'
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: webhookFunction.functionArn,
      description: 'Lambda Function ARN'
    });
  }
}

module.exports = { WhatsAppWebhookStack };
