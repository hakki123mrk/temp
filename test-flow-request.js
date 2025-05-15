const axios = require('axios');
require('dotenv').config();

// Test phone number
const TEST_PHONE_NUMBER = '919886781317';
const FLOW_ID = '678077614823992';

// Send flow message for address collection
async function sendFlowRequest() {
  try {
    console.log(`Sending flow address request to ${TEST_PHONE_NUMBER}...`);
    
    const response = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: TEST_PHONE_NUMBER,
        type: 'interactive',
        interactive: {
          type: 'flow',
          header: {
            type: 'text',
            text: 'Delivery Address'
          },
          body: {
            text: 'Please provide your delivery address so we can deliver your order.'
          },
          footer: {
            text: 'Your address will be saved for future orders'
          },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_id: FLOW_ID,
              flow_cta: 'Provide Address',
              flow_action: 'navigate'
            }
          }
        }
      }
    });
    
    console.log('Flow address request sent successfully!');
    console.log('Response data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error sending flow address request:');
    if (error.response) {
      // Error response from the API
      console.error('API Error:', JSON.stringify(error.response.data, null, 2));
      console.error('Status:', error.response.status);
      
      // If the error is because flows aren't available, try the fallback
      if (error.response.data.error && 
          (error.response.data.error.code === 131009 || 
           (error.response.data.error.message && 
            error.response.data.error.message.includes('flow')))) {
        console.log('\nFlow message not available, trying text fallback...');
        sendTextFallback();
      }
    } else {
      // Network or other error
      console.error(error.message);
    }
  }
}

// Fallback to text message approach
async function sendTextFallback() {
  try {
    const response = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: TEST_PHONE_NUMBER,
        type: 'text',
        text: {
          body: 'Please share your delivery address in the following format:\n\n' +
                'Full Address:\n\n' +
                'Example:\n123 Main Street\nApartment 456\nCity, State, Zip Code'
        }
      }
    });
    
    console.log('Text fallback address request sent successfully!');
    console.log('Response data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error sending text fallback:', error.message);
    if (error.response) {
      console.error('API Error:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Run the test
sendFlowRequest();