require('dotenv').config();
const axios = require('axios');

// Phone number to send test message to (from environment variables or default)
const TEST_PHONE_NUMBER = process.env.TEST_PHONE_NUMBER || '12345678901';

// Flow ID for address collection
const FLOW_ID = '678077614823992';

async function testFlowAddressRequest() {
  try {
    console.log(`Sending Flow-based address request to ${TEST_PHONE_NUMBER}...`);
    
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

    console.log('Flow-based address request sent successfully!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    
    return response.data;
  } catch (error) {
    console.error('Error sending flow-based address request:');
    
    if (error.response && error.response.data) {
      console.error('API Error:', JSON.stringify(error.response.data, null, 2));
      
      // Log the error code specifically for debugging
      const errorCode = error.response.data.error?.code;
      const errorMessage = error.response.data.error?.message;
      
      console.error(`Error code: ${errorCode}`);
      console.error(`Error message: ${errorMessage}`);
      
      if (errorCode === 131009) {
        console.error('This feature is not supported in your region or account configuration.');
      }
    } else {
      console.error(error.message);
    }
    
    // Try the text-based fallback
    console.log('\nTrying text-based fallback approach...');
    await sendTextFallback();
  }
}

async function sendTextFallback() {
  try {
    const textMessage = 'Please share your delivery address in the following format:\n\n' +
      'Full Name:\n' +
      'Phone Number:\n' +
      'Street Address & Building:\n' +
      'Apartment/Floor/Unit:\n' +
      'City:\n' +
      'State/Province:\n' +
      'PIN Code/ZIP:\n' +
      'Landmark (optional):';
    
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
          body: textMessage
        }
      }
    });
    
    console.log('Text fallback sent successfully!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Even text fallback failed:');
    console.error(error.message);
    
    if (error.response && error.response.data) {
      console.error('API Error:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Execute the test
testFlowAddressRequest();