const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Sample file paths
const SAMPLES_DIR = path.join(__dirname, 'samples');
if (!fs.existsSync(SAMPLES_DIR)) {
  fs.mkdirSync(SAMPLES_DIR);
}

// Sample events
const samples = {
  text_message: {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: '123456789'
          },
          contacts: [{
            profile: {
              name: 'Test User'
            },
            wa_id: '9876543210'
          }],
          messages: [{
            from: '9876543210',
            id: 'wamid.abcdefghijklmnopqrstuvwxyz',
            timestamp: Math.floor(Date.now() / 1000),
            text: {
              body: 'Hello, I would like to order some food!'
            },
            type: 'text'
          }]
        },
        field: 'messages'
      }]
    }]
  },

  catalog_interaction: {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: '123456789'
          },
          contacts: [{
            profile: {
              name: 'Test User'
            },
            wa_id: '9876543210'
          }],
          shopping: {
            catalog_message: {
              catalog_id: '987654321',
              text: 'I want to see the menu'
            }
          }
        },
        field: 'messages'
      }]
    }]
  },

  product_inquiry: {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: '123456789'
          },
          contacts: [{
            profile: {
              name: 'Test User'
            },
            wa_id: '9876543210'
          }],
          shopping: {
            product_inquiry: {
              product: {
                id: '1044',
                retailer_id: 'A001044',
                title: 'Luxury Thai Beef Salad'
              }
            }
          }
        },
        field: 'messages'
      }]
    }]
  },

  order: {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789',
      changes: [{
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: '15551234567',
            phone_number_id: '123456789'
          },
          contacts: [{
            profile: {
              name: 'Test User'
            },
            wa_id: '9876543210'
          }],
          shopping: {
            order: {
              catalog_id: '987654321',
              text: 'Please deliver as soon as possible',
              product_items: [
                {
                  product_retailer_id: 'A001044',
                  name: 'Luxury Thai Beef Salad',
                  quantity: 1,
                  price: 60.00,
                  currency: 'AED'
                },
                {
                  product_retailer_id: 'A001046',
                  name: 'Butter Chicken',
                  quantity: 2,
                  price: 50.00,
                  currency: 'AED'
                }
              ]
            }
          }
        },
        field: 'messages'
      }]
    }]
  }
};

// Save sample files
Object.entries(samples).forEach(([name, payload]) => {
  fs.writeFileSync(
    path.join(SAMPLES_DIR, `${name}.json`),
    JSON.stringify(payload, null, 2)
  );
  console.log(`Sample ${name}.json created`);
});

// Send test event to local webhook
async function sendTestEvent(eventType) {
  try {
    const payload = samples[eventType];
    if (!payload) {
      console.error(`Unknown event type: ${eventType}`);
      console.log(`Available event types: ${Object.keys(samples).join(', ')}`);
      return;
    }

    console.log(`Sending ${eventType} webhook event to local server...`);
    
    const response = await axios.post('http://localhost:3000/webhook', payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`Response: ${response.status} ${response.data}`);
    console.log(`Webhook event sent successfully. Check your server logs for details.`);
  } catch (error) {
    console.error('Error sending test event:', error.message);
    if (error.code === 'ECONNREFUSED') {
      console.error('Make sure your webhook server is running on http://localhost:3000');
    }
  }
}

// Check command line arguments
const eventType = process.argv[2];
if (!eventType) {
  console.log('Usage: node test-webhook.js <event_type>');
  console.log(`Available event types: ${Object.keys(samples).join(', ')}`);
} else {
  sendTestEvent(eventType);
}