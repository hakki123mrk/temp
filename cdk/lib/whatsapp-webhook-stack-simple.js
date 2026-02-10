const cdk = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigateway = require('aws-cdk-lib/aws-apigateway');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const sqs = require('aws-cdk-lib/aws-sqs');
const { SqsEventSource } = require('aws-cdk-lib/aws-lambda-event-sources');
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

    // ContactsTable - stores user profiles, addresses, and conversation state
    const contactsTable = new dynamodb.Table(this, 'ContactsTable', {
      partitionKey: { name: 'waId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // PendingOrdersTable - stores orders awaiting address/confirmation
    const pendingOrdersTable = new dynamodb.Table(this, 'PendingOrdersTable', {
      partitionKey: { name: 'orderRef', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI for querying pending orders by user and status
    pendingOrdersTable.addGlobalSecondaryIndex({
      indexName: 'WaIdStatusIndex',
      partitionKey: { name: 'waId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
    });

    // SQS Queue for order processing
    const orderQueue = new sqs.Queue(this, 'OrderProcessingQueue', {
      visibilityTimeout: cdk.Duration.seconds(300),
      retentionPeriod: cdk.Duration.days(1),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
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
        CONTACTS_TABLE_NAME: contactsTable.tableName,
        PENDING_ORDERS_TABLE_NAME: pendingOrdersTable.tableName,
        ORDER_QUEUE_URL: orderQueue.queueUrl,
        NODE_ENV: 'production',
        VERIFY_TOKEN: 'wbYWVNbLn1hbOJF5wE6tJQughSMZAR8UvZB85dYiJBDlO',
        WHATSAPP_PHONE_NUMBER_ID: '116206601581617',
        WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN || 'YOUR_WHATSAPP_API_TOKEN',
        WHATSAPP_CATALOG_ID: '116206601581617',
        CATALOG_THUMBNAIL_ID: 'A001044',
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || 'YOUR_STRIPE_SECRET_KEY',
        WEBHOOK_BASE_URL: 'https://g6t3xzuzy7.execute-api.me-central-1.amazonaws.com/prod'
      },
      description: 'WhatsApp Commerce Webhook Handler'
    });

    // Order processor Lambda - processes orders from queue
    const orderProcessor = new lambda.Function(this, 'OrderProcessorFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'order-processor.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        MESSAGES_TABLE_NAME: messagesTable.tableName,
        CONTACTS_TABLE_NAME: contactsTable.tableName,
        PENDING_ORDERS_TABLE_NAME: pendingOrdersTable.tableName,
        WHATSAPP_PHONE_NUMBER_ID: '116206601581617',
        WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN || 'YOUR_WHATSAPP_API_TOKEN'
      },
      description: 'Processes orders from SQS queue'
    });

    // Connect queue to order processor
    orderProcessor.addEventSource(new SqsEventSource(orderQueue, {
      batchSize: 1,
      maxBatchingWindow: cdk.Duration.seconds(5)
    }));

    // Grant Lambda permissions to DynamoDB tables
    messagesTable.grantReadWriteData(webhookFunction);
    contactsTable.grantReadWriteData(webhookFunction);
    pendingOrdersTable.grantReadWriteData(webhookFunction);
    messagesTable.grantReadWriteData(orderProcessor);
    contactsTable.grantReadWriteData(orderProcessor);
    pendingOrdersTable.grantReadWriteData(orderProcessor);
    
    // Grant queue permissions
    orderQueue.grantSendMessages(webhookFunction);

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

    new cdk.CfnOutput(this, 'OrderQueueUrl', {
      value: orderQueue.queueUrl,
      description: 'SQS Queue URL for order processing',
      exportName: 'OrderProcessingQueueUrl'
    });

    new cdk.CfnOutput(this, 'OrderProcessorName', {
      value: orderProcessor.functionName,
      description: 'Order Processor Lambda Function Name',
      exportName: 'OrderProcessorFunctionName'
    });
  }
}

module.exports = { WhatsAppWebhookStack };
