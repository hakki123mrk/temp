const https = require('https');
const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const TABLE_NAME = process.env.MESSAGES_TABLE_NAME;

// Load product catalog from CSV
let productCatalog = new Map();

function loadProductCatalog() {
  try {
    const csvPath = path.join(__dirname, 'facebook_catalog.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const lines = csvContent.split('\n');
    
    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // Simple CSV parsing (handles basic cases)
      const columns = line.split(',');
      if (columns.length >= 2) {
        const id = columns[0].trim();
        const title = columns[1].trim();
        if (id && title) {
          productCatalog.set(id, title);
        }
      }
    }
    
    console.log(`Loaded ${productCatalog.size} products from catalog`);
  } catch (error) {
    console.error('Error loading product catalog:', error);
  }
}

// Load catalog on cold start
loadProductCatalog();

// Get product name by ID
function getProductName(productId) {
  return productCatalog.get(productId) || `Product #${productId}`;
}

// Save message to DynamoDB
async function saveMessage(waId, messageData) {
  try {
    const item = {
      waId: waId,
      timestamp: Date.now(),
      messageId: messageData.id || 'unknown',
      messageType: messageData.type || 'unknown',
      profileName: messageData.profileName || 'Unknown',
      ...messageData,
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
    }));

    console.log(`Message saved to DynamoDB: ${messageData.id}`);
    return true;
  } catch (error) {
    console.error('Error saving to DynamoDB:', error);
    return false;
  }
}

// Forward order to middleware API
async function forwardOrderToMiddleware(orderData) {
  const middlewareUrl = 'https://mvwxud7juf.execute-api.me-central-1.amazonaws.com/dev/webhooks/pd30wdfa5g/whatsapp';
  
  const payload = JSON.stringify(orderData);
  
  const url = new URL(middlewareUrl);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`Middleware API response (${res.statusCode}):`, body);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, data: body });
        } else {
          reject(new Error(`Middleware API returned ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Helper function to send WhatsApp text message
async function sendWhatsAppMessage(phoneNumberId, token, to, message) {
  const data = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'text',
    text: { body: message }
  });

  return makeWhatsAppRequest(phoneNumberId, token, data);
}

// Helper function to send interactive button message
async function sendInteractiveButtons(phoneNumberId, token, to, header, body, buttons) {
  const data = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: header },
      body: { text: body },
      action: { buttons: buttons }
    }
  });

  return makeWhatsAppRequest(phoneNumberId, token, data);
}

// Core WhatsApp API request function
function makeWhatsAppRequest(phoneNumberId, token, data) {
  const options = {
    hostname: 'graph.facebook.com',
    port: 443,
    path: `/v17.0/${phoneNumberId}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log('WhatsApp API Response:', body);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body));
        } else {
          reject(new Error(`WhatsApp API error: ${res.statusCode} - ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Process different message types
async function processMessage(message, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  const messageType = message.type;

  console.log(`Processing ${messageType} message from ${profileName} (${waId})`);

  // Save message to DynamoDB
  await saveMessage(waId, {
    ...message,
    profileName: profileName,
    receivedAt: new Date().toISOString(),
  });

  try {
    // Handle text messages
    if (messageType === 'text') {
      const text = message.text?.body || '';
      console.log(`Text message: "${text}"`);

      // Simple command handling
      const lowerText = text.toLowerCase().trim();
      
      if (lowerText === 'hi' || lowerText === 'hello' || lowerText === 'hey') {
        await sendWhatsAppMessage(
          phoneNumberId, token, waId,
          `Hello ${profileName}! 👋 Welcome to our store. How can I help you today?`
        );
      } else if (lowerText.includes('order') || lowerText.includes('menu') || lowerText.includes('catalog')) {
        await sendWhatsAppMessage(
          phoneNumberId, token, waId,
          `Great! You can browse our menu by tapping the shopping icon 🛒 at the bottom of the chat.`
        );
      } else if (lowerText.includes('help')) {
        await sendWhatsAppMessage(
          phoneNumberId, token, waId,
          `I'm here to help! 😊\n\nYou can:\n- Browse our menu (tap 🛒)\n- Place orders\n- Track your delivery\n\nJust send a message or tap the menu icon!`
        );
      } else {
        await sendWhatsAppMessage(
          phoneNumberId, token, waId,
          `Thank you for your message, ${profileName}! I've received: "${text}"\n\nOur team will respond shortly. Need help now? Reply with 'help'.`
        );
      }
    }
    
    // Handle order messages
    else if (messageType === 'order') {
      const order = message.order;
      const items = order?.product_items || [];
      console.log(`Order received with ${items.length} items`, order);

      // Generate order reference
      const orderRef = `ORD-${Date.now()}-${waId.slice(-4)}`;
      
      // Save order with reference
      await saveMessage(waId, {
        ...message,
        profileName: profileName,
        orderRef: orderRef,
        orderItems: items,
        receivedAt: new Date().toISOString(),
      });
      
      // Build order summary with actual product names
      let totalAmount = 0;
      const itemsList = items.map(item => {
        const itemTotal = (item.item_price || 0) * (item.quantity || 1);
        totalAmount += itemTotal;
        const productName = getProductName(item.product_retailer_id);
        return `• ${item.quantity}x ${productName} - AED ${item.item_price.toFixed(2)} each`;
      }).join('\n');

      // Forward order to middleware API
      let middlewareOrderId = orderRef; // Default to local reference
      try {
        const middlewarePayload = {
          channelOrderId: message.id,
          customerName: profileName,
          customerPhone: waId,
          customerAddress: 'Address to be collected',
          orderType: 'delivery',
          tableNo: null,
          totalAmount: totalAmount,
          items: items.map(item => ({
            itemCode: item.product_retailer_id,
            itemName: getProductName(item.product_retailer_id),
            quantity: item.quantity,
            price: item.item_price
          })),
          notes: order.text || ''
        };

        const middlewareResponse = await forwardOrderToMiddleware(middlewarePayload);
        const responseData = JSON.parse(middlewareResponse.data);
        
        // Extract the actual order ID from middleware response
        if (responseData.orderReferenceId) {
          middlewareOrderId = responseData.orderReferenceId;
        }
        
        console.log(`Order forwarded to middleware: ${middlewareOrderId}`);
      } catch (error) {
        console.error(`Failed to forward order to middleware:`, error);
      }

      // Send order acknowledgment with middleware order ID
      try {
        await sendWhatsAppMessage(
          phoneNumberId, token, waId,
          `✅ Order Received! (${middlewareOrderId})\n\n📦 Your Order:\n${itemsList}\n\n💰 Total: AED ${totalAmount.toFixed(2)}\n\nWe're preparing your order now. You'll receive updates shortly!`
        );
        console.log(`Order confirmation sent for ${middlewareOrderId}`);
      } catch (error) {
        console.error(`Failed to send order confirmation for ${middlewareOrderId}:`, error);
      }

      // Simulate address collection (simplified - in production this would check Firebase)
      setTimeout(async () => {
        try {
          await sendInteractiveButtons(
            phoneNumberId, token, waId,
            'Delivery Address Required',
            `Great! To complete your order ${middlewareOrderId}, we need a delivery address.\n\nDo you have an address on file?`,
            [
              {
                type: 'reply',
                reply: {
                  id: `use_saved_address_${orderRef}`,
                  title: 'Use Saved Address'
                }
              },
              {
                type: 'reply',
                reply: {
                  id: `enter_new_address_${orderRef}`,
                  title: 'Enter New Address'
                }
              }
            ]
          );
        } catch (error) {
          console.error('Error sending address request:', error);
        }
      }, 2000);
    }
    
    // Handle interactive button responses
    else if (messageType === 'interactive') {
      const buttonReply = message.interactive?.button_reply;
      if (buttonReply) {
        console.log(`Button clicked: ${buttonReply.id}`);
        
        if (buttonReply.id.includes('use_saved_address')) {
          await sendWhatsAppMessage(
            phoneNumberId, token, waId,
            `Perfect! We'll use your saved address for delivery. Your order will arrive within 30-45 minutes. 🚚`
          );
        } else if (buttonReply.id.includes('enter_new_address')) {
          await sendWhatsAppMessage(
            phoneNumberId, token, waId,
            `Please send us your complete delivery address including:\n- Building/Villa number\n- Street name\n- Area/District\n- Nearby landmark`
          );
        }
      }
    }
    
    // Log other message types
    else {
      console.log(`Received ${messageType} message:`, message);
    }
  } catch (error) {
    console.error('Error in processMessage:', error);
  }
}

// Main Lambda handler
exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event));
  
  const path = event.rawPath || event.path || '/';
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const queryParams = event.queryStringParameters || {};
  
  // Webhook verification (GET)
  if (method === 'GET' && path.includes('webhook')) {
    const mode = queryParams['hub.mode'];
    const token = queryParams['hub.verify_token'];
    const challenge = queryParams['hub.challenge'];
    
    console.log('Verification:', { mode, token: token ? 'present' : 'missing' });
    
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      return {
        statusCode: 200,
        body: challenge
      };
    }
    return { statusCode: 403, body: 'Forbidden' };
  }
  
  // Webhook events (POST)
  if (method === 'POST' && path.includes('webhook')) {
    const body = event.body ? JSON.parse(event.body) : {};
    console.log('Webhook event received:', JSON.stringify(body));
    
    // Process incoming messages
    try {
      if (body.object === 'whatsapp_business_account') {
        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            
            // Handle message status updates
            if (change.value?.statuses) {
              const statuses = change.value.statuses;
              for (const status of statuses) {
                console.log(`Status update: ${status.status} for message ${status.id}`);
              }
            }
            
            // Handle incoming messages
            if (change.value?.messages) {
              const messages = change.value.messages;
              const contacts = change.value.contacts || [];
              const waId = contacts[0]?.wa_id || 'unknown';
              const profileName = contacts[0]?.profile?.name || 'Customer';
              
              console.log(`Processing ${messages.length} message(s) from ${profileName} (${waId})`);
              
              // Process each message
              for (const message of messages) {
                await processMessage(message, waId, profileName);
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Error processing webhook:', error);
    }
    
    // Return response to WhatsApp
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'EVENT_RECEIVED'
    };
  }
  
  // Health check
  if (path.includes('health')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        catalogProducts: productCatalog.size
      })
    };
  }
  
  return {
    statusCode: 404,
    body: 'Not Found'
  };
};
