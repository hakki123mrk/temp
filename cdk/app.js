#!/usr/bin/env node
const cdk = require('aws-cdk-lib');
const { WhatsAppWebhookStack } = require('./lib/whatsapp-webhook-stack-simple');

const app = new cdk.App();

new WhatsAppWebhookStack(app, 'WhatsAppWebhookStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'WhatsApp Webhook Lambda Function with API Gateway'
});

app.synth();
