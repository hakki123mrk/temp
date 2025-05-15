const axios = require('axios');
require('dotenv').config();

// Test phone number (make sure this is a valid WhatsApp test number)
const TEST_PHONE_NUMBER = '919886781317';

// Send address request directly
async function sendAddressRequest() {
  try {
    console.log(`Sending address request message to ${TEST_PHONE_NUMBER}...`);
    
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
          type: 'address_message',
          body: {
            text: 'Please share your delivery address so we can deliver your order.'
          },
          action: {
            name: 'address_message'
            // Country code parameter is not needed
          }
        }
      }
    });
    
    console.log('Address request sent successfully!');
    console.log('Response data:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error sending address request:');
    if (error.response) {
      // Error response from the API
      console.error('API Error:', JSON.stringify(error.response.data, null, 2));
      console.error('Status:', error.response.status);
      
      // If the error is because address messages aren't available, try the fallback
      if (error.response.data.error.code === 100 || 
          (error.response.data.error.message && 
           error.response.data.error.message.includes('address_message'))) {
        console.log('\nAddress message not available, trying text fallback...');
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
                'Full Name:\n' +
                'Phone Number:\n' +
                'Street Address & Building:\n' +
                'Apartment/Floor/Unit:\n' +
                'City:\n' +
                'State/Province:\n' +
                'PIN Code/ZIP:\n' +
                'Landmark (optional):'
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
sendAddressRequest();