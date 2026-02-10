// Manual payment processing script
const AWS = require('aws-sdk');

// Configure AWS
AWS.config.update({ region: 'me-central-1' });
const lambda = new AWS.Lambda();

const sessionId = 'cs_live_a15juDPuRtUIK5RA5rkbR83UKZKPVgjFmNK1g3aZFcvaqp7c1fMgdMRYEX';

// Create a test event that simulates the payment-success redirect
const event = {
  resource: "/{proxy+}",
  path: "/payment-success",
  httpMethod: "GET",
  queryStringParameters: {
    session_id: sessionId
  },
  body: null
};

console.log(`Processing payment for session: ${sessionId}`);

lambda.invoke({
  FunctionName: 'WhatsAppWebhookStack-WhatsAppWebhookFunctionED135A-3uKGEnymCAwr',
  InvocationType: 'RequestResponse',
  Payload: JSON.stringify(event)
}, (err, data) => {
  if (err) {
    console.error('Error invoking Lambda:', err);
  } else {
    console.log('Lambda response:', data);
    const response = JSON.parse(data.Payload);
    console.log('Payment processing result:', response);
  }
});
