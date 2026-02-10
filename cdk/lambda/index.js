const https = require('https');
const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const Stripe = require('stripe');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = new SQSClient({});
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const TABLE_NAME = process.env.MESSAGES_TABLE_NAME;
const CONTACTS_TABLE = process.env.CONTACTS_TABLE_NAME;
const PENDING_ORDERS_TABLE = process.env.PENDING_ORDERS_TABLE_NAME;
const ORDER_QUEUE_URL = process.env.ORDER_QUEUE_URL;

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

// Helper function for awaitable delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Get product name by ID
function getProductName(productId) {
  return productCatalog.get(productId) || `Product #${productId}`;
}

// Handle Stripe payment success
async function handleStripePaymentSuccess(sessionId) {
  try {
    console.log(`Processing Stripe payment success for session: ${sessionId}`);
    
    // Retrieve the session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      console.log(`Payment not completed: ${session.payment_status}`);
      return;
    }
    
    const { orderRef, waId, profileName } = session.metadata;
    
    console.log(`Payment confirmed for order ${orderRef} by ${profileName}`);
    
    // Get pending order
    const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_payment');
    const order = pendingOrders.find(o => o.orderRef === orderRef);
    
    if (!order) {
      console.error(`No pending order found for ${orderRef}`);
      return;
    }
    
    // Send order to queue
    await sendToOrderQueue({
      orderRef,
      waId,
      profileName,
      orderData: order.orderData,
      orderType: order.orderType,
      addressData: order.confirmedAddress || order.addressData || null,
      addressMethod: order.addressMethod || 'not_required',
      paymentMethod: 'online',
      paymentStatus: 'paid',
      stripeSessionId: sessionId,
      timestamp: Date.now()
    });
    
    // Update order status
    await updatePendingOrder(orderRef, order.timestamp, {
      status: 'queued_for_processing',
      paymentMethod: 'online',
      paymentStatus: 'paid',
      paymentCompletedAt: Date.now(),
      stripePaymentId: session.payment_intent,
      queuedAt: Date.now()
    });
    
    // Update conversation state
    await updateContact(waId, profileName, { 
      conversationState: 'order_processing'
    });
    
    // Send confirmation to WhatsApp
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_API_TOKEN;
    
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `✅ Payment received! Your order is being processed now...\n\nOrder: ${orderRef}`
    );
    
    console.log(`Successfully processed payment for order ${orderRef}`);
    
  } catch (error) {
    console.error('Error handling Stripe payment success:', error);
    throw error;
  }
}

// Save message to DynamoDB
async function saveMessage(waId, messageData) {
  try {
    const item = {
      waId: waId,
      messageId: messageData.id || 'unknown',
      messageType: messageData.type || 'unknown',
      profileName: messageData.profileName || 'Unknown',
      direction: messageData.direction || 'inbound',
      ...messageData,
      // Ensure timestamp is a number (WhatsApp sends string, DynamoDB needs number)
      timestamp: parseInt(messageData.timestamp) || Date.now(),
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

// ===== CONTACT OPERATIONS =====
async function getContact(waId) {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: CONTACTS_TABLE,
      Key: { waId }
    }));
    return result.Item;
  } catch (error) {
    console.error('Error getting contact:', error);
    return null;
  }
}

async function updateContact(waId, profileName, updates = {}) {
  try {
    const updateData = {
      TableName: CONTACTS_TABLE,
      Key: { waId },
      UpdateExpression: 'SET profileName = :name, lastMessageTime = :time',
      ExpressionAttributeValues: {
        ':name': profileName,
        ':time': Date.now()
      }
    };
    
    // Add optional updates (address, conversationState, etc.)
    if (updates.address) {
      updateData.UpdateExpression += ', address = :addr, addressUpdatedAt = :addrTime';
      updateData.ExpressionAttributeValues[':addr'] = updates.address;
      updateData.ExpressionAttributeValues[':addrTime'] = Date.now();
    }
    
    if (updates.conversationState !== undefined) {
      updateData.UpdateExpression += ', conversationState = :state, stateUpdatedAt = :stateTime';
      updateData.ExpressionAttributeValues[':state'] = updates.conversationState;
      updateData.ExpressionAttributeValues[':stateTime'] = Date.now();
    }
    
    if (updates.pendingOrderRef) {
      updateData.UpdateExpression += ', pendingOrderRef = :orderRef';
      updateData.ExpressionAttributeValues[':orderRef'] = updates.pendingOrderRef;
    }
    
    await docClient.send(new UpdateCommand(updateData));
    console.log(`Contact ${waId} updated`);
  } catch (error) {
    console.error('Error updating contact:', error);
  }
}

// ===== PENDING ORDER OPERATIONS =====
async function savePendingOrder(orderRef, waId, profileName, orderData, status, existingAddress = null) {
  try {
    const item = {
      orderRef,
      timestamp: Date.now(),
      waId,
      profileName,
      status,
      orderData,
      createdAt: Date.now()
    };
    
    if (existingAddress) {
      item.existingAddress = existingAddress;
    }
    
    await docClient.send(new PutCommand({
      TableName: PENDING_ORDERS_TABLE,
      Item: item
    }));
    
    console.log(`Saved pending order ${orderRef} with status ${status}`);
    return true;
  } catch (error) {
    console.error('Error saving pending order:', error);
    return false;
  }
}

async function getPendingOrdersByUser(waId, status) {
  try {
    const result = await docClient.send(new QueryCommand({
      TableName: PENDING_ORDERS_TABLE,
      IndexName: 'WaIdStatusIndex',
      KeyConditionExpression: 'waId = :waId AND #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':waId': waId,
        ':status': status
      }
    }));
    return result.Items || [];
  } catch (error) {
    console.error('Error getting pending orders:', error);
    return [];
  }
}

async function updatePendingOrder(orderRef, timestamp, updates) {
  try {
    const updateExpressions = [];
    const attributeNames = {};
    const attributeValues = {};
    
    Object.keys(updates).forEach((key, index) => {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      updateExpressions.push(`${attrName} = ${attrValue}`);
      attributeNames[attrName] = key;
      attributeValues[attrValue] = updates[key];
    });
    
    await docClient.send(new UpdateCommand({
      TableName: PENDING_ORDERS_TABLE,
      Key: { orderRef, timestamp },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: attributeNames,
      ExpressionAttributeValues: attributeValues
    }));
    
    console.log(`Updated pending order ${orderRef}`);
  } catch (error) {
    console.error('Error updating pending order:', error);
  }
}

// ===== SQS OPERATIONS =====
async function sendToOrderQueue(orderData) {
  try {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: ORDER_QUEUE_URL,
      MessageBody: JSON.stringify(orderData)
    }));
    console.log(`Order sent to queue: ${orderData.orderRef}`);
    return true;
  } catch (error) {
    console.error('Error sending to queue:', error);
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

// Helper function to send WhatsApp catalog button
async function sendCatalogButton(phoneNumberId, token, to, messageText = null) {
  const catalogId = process.env.WHATSAPP_CATALOG_ID || '116206601581617';
  const thumbnailId = process.env.CATALOG_THUMBNAIL_ID || 'A001044';
  
  const data = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'catalog_message',
      body: {
        text: messageText || '🍽️ Check out our delicious menu! Tap the button below to browse and place your order.'
      },
      action: {
        name: 'catalog_message',
        parameters: {
          thumbnail_product_retailer_id: thumbnailId
        }
      }
    }
  });

  return makeWhatsAppRequest(phoneNumberId, token, data);
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

// Helper to send order type selection buttons
async function sendOrderTypeButtons(waId, orderRef) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  const buttons = [
    {
      type: 'reply',
      reply: {
        id: `delivery:${orderRef}`,
        title: '🚗 Delivery'
      }
    },
    {
      type: 'reply',
      reply: {
        id: `takeaway:${orderRef}`,
        title: '🏪 Takeaway'
      }
    }
  ];
  
  await sendInteractiveButtons(
    phoneNumberId,
    token,
    waId,
    '📦 Order Type',
    'How would you like to receive your order?',
    buttons
  );
}

// Helper to send address confirmation buttons
async function sendAddressConfirmationButtons(waId, orderRef, addressText) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  const buttons = [
    {
      type: 'reply',
      reply: {
        id: `use_existing:${orderRef}`,
        title: 'Use This Address'
      }
    },
    {
      type: 'reply',
      reply: {
        id: `new_address:${orderRef}`,
        title: 'Different Address'
      }
    }
  ];
  
  await sendInteractiveButtons(
    phoneNumberId,
    token,
    waId,
    '📦 Delivery Address',
    `We found your saved address:\n\n${addressText}\n\nWould you like to use it for this order?`,
    buttons
  );
}

// Helper to send payment option buttons
async function sendPaymentOptionButtons(waId, orderRef) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  const buttons = [
    {
      type: 'reply',
      reply: {
        id: `pay_online:${orderRef}`,
        title: '💳 Pay Online'
      }
    },
    {
      type: 'reply',
      reply: {
        id: `pay_cod:${orderRef}`,
        title: '💵 Cash on Delivery'
      }
    }
  ];
  
  await sendInteractiveButtons(
    phoneNumberId,
    token,
    waId,
    '💳 Payment Method',
    'Please select your preferred payment method:',
    buttons
  );
}

// Create Stripe checkout session
async function createStripeCheckoutSession(orderRef, waId, profileName, totalAmount, items) {
  try {
    const webhookUrl = process.env.WEBHOOK_BASE_URL || 'https://g6t3xzuzy7.execute-api.me-central-1.amazonaws.com/prod';
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: items.map(item => ({
        price_data: {
          currency: 'aed',
          product_data: {
            name: item.itemName,
          },
          unit_amount: Math.round(item.price * 100), // Convert to cents
        },
        quantity: item.quantity,
      })),
      mode: 'payment',
      success_url: `${webhookUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${webhookUrl}/payment-cancel?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        orderRef,
        waId,
        profileName
      },
      customer_email: undefined, // WhatsApp doesn't provide email
      phone_number_collection: {
        enabled: false
      }
    });
    
    return session;
  } catch (error) {
    console.error('Error creating Stripe checkout session:', error);
    throw error;
  }
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
      await handleOrderMessage(message, waId, profileName);
    }
    
    // Handle interactive messages (buttons, lists, flows)
    else if (messageType === 'interactive') {
      await handleInteractiveMessage(message, waId, profileName);
    }
    
    // Handle other message types
    else {
      await sendWhatsAppMessage(
        phoneNumberId, token, waId,
        `Thank you for your message! I've received your ${messageType}. Our team will respond shortly.`
      );
    }
  } catch (error) {
    console.error('Error in processMessage:', error);
  }
}

// Handle order messages with delivery/takeaway selection
async function handleOrderMessage(message, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  const order = message.order;
  const items = order?.product_items || [];
  
  console.log(`Order received from ${profileName} with ${items.length} items`);
  
  // Generate order reference
  const orderRef = `ORD-${Date.now()}-${waId.slice(-4)}`;
  
  // Save order message to messages table
  await saveMessage(waId, {
    ...message,
    profileName,
    orderRef,
    orderItems: items,
    direction: 'inbound',
    receivedAt: new Date().toISOString()
  });
  
  // Save pending order (awaiting order type selection)
  await savePendingOrder(orderRef, waId, profileName, order, 'awaiting_order_type');
  
  // Update contact activity
  await updateContact(waId, profileName, { 
    conversationState: 'awaiting_order_type',
    pendingOrderRef: orderRef
  });
  
  // Send acknowledgment and ask for order type
  await sendWhatsAppMessage(
    phoneNumberId, token, waId,
    `Thank you for your order, ${profileName}! 🎉`
  );
  
  // Wait a moment then send order type selection buttons
  await delay(1000);
  await sendOrderTypeButtons(waId, orderRef);
}

// Handle delivery option selected
async function handleDeliverySelected(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} selected delivery for order ${orderRef}`);
  
  // Update pending order with delivery type
  const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_order_type');
  const order = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (!order) {
    console.error(`No pending order found: ${orderRef}`);
    return;
  }
  
  await updatePendingOrder(orderRef, order.timestamp, {
    orderType: 'delivery',
    status: 'awaiting_address'
  });
  
  // Check if user has an address
  const contact = await getContact(waId);
  const hasAddress = contact && contact.address && contact.address.addressText;
  
  if (!hasAddress) {
    // NO ADDRESS - Request address
    console.log(`No address found for ${waId}, requesting address`);
    
    // Update conversation state
    await updateContact(waId, profileName, { 
      conversationState: 'awaiting_address',
      pendingOrderRef: orderRef
    });
    
    // Send address request
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `📍 Please reply with your complete delivery address including:\n- Street/Building\n- Area\n- City\n- Landmarks (if any)`
    );
    
  } else {
    // HAS ADDRESS - Ask to confirm or use different
    console.log(`Found address for ${waId}, asking for confirmation`);
    
    await updatePendingOrder(orderRef, order.timestamp, {
      status: 'awaiting_address_confirmation',
      existingAddress: contact.address
    });
    
    // Update conversation state
    await updateContact(waId, profileName, { 
      conversationState: 'awaiting_address_confirmation',
      pendingOrderRef: orderRef
    });
    
    // Send address confirmation buttons
    await sendAddressConfirmationButtons(waId, orderRef, contact.address.addressText);
  }
}

// Handle takeaway option selected
async function handleTakeawaySelected(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} selected takeaway for order ${orderRef}`);
  
  // Get pending order
  const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_order_type');
  const order = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (!order) {
    console.error(`No pending order found: ${orderRef}`);
    return;
  }
  
  // Update order with takeaway type and status
  await updatePendingOrder(orderRef, order.timestamp, {
    orderType: 'takeaway',
    status: 'awaiting_payment_method'
  });
  
  // Update conversation state
  await updateContact(waId, profileName, { 
    conversationState: 'awaiting_payment_method',
    pendingOrderRef: orderRef
  });
  
  // Send payment options
  await sendWhatsAppMessage(
    phoneNumberId, token, waId,
    `Perfect! Your order will be ready for pickup. 🏪`
  );
  
  await delay(500);
  await sendPaymentOptionButtons(waId, orderRef);
}

// Handle interactive messages (button replies, list selections, flow responses)
async function handleInteractiveMessage(message, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  const interactive = message.interactive;
  
  console.log(`Interactive message: ${interactive.type}`);
  
  // Handle button replies
  if (interactive.type === 'button_reply') {
    const buttonId = interactive.button_reply.id;
    const buttonTitle = interactive.button_reply.title;
    console.log(`Button clicked: ${buttonId} (${buttonTitle})`);
    
    // Delivery selected
    if (buttonId.startsWith('delivery:')) {
      const orderRef = buttonId.split(':')[1];
      await handleDeliverySelected(orderRef, waId, profileName);
    }
    // Takeaway selected
    else if (buttonId.startsWith('takeaway:')) {
      const orderRef = buttonId.split(':')[1];
      await handleTakeawaySelected(orderRef, waId, profileName);
    }
    // Use existing address
    else if (buttonId.startsWith('use_existing:')) {
      const orderRef = buttonId.split(':')[1];
      await handleUseExistingAddress(orderRef, waId, profileName);
    }
    // Request new address
    else if (buttonId.startsWith('new_address:')) {
      const orderRef = buttonId.split(':')[1];
      await handleRequestNewAddress(orderRef, waId, profileName);
    }
    // Pay online selected
    else if (buttonId.startsWith('pay_online:')) {
      const orderRef = buttonId.split(':')[1];
      await handlePayOnline(orderRef, waId, profileName);
    }
    // Cash on delivery selected
    else if (buttonId.startsWith('pay_cod:')) {
      const orderRef = buttonId.split(':')[1];
      await handleCashOnDelivery(orderRef, waId, profileName);
    }
  }
  
  // Handle flow responses (nfm_reply) - address collection
  else if (interactive.type === 'nfm_reply') {
    await handleAddressFlowResponse(message, waId, profileName);
  }
}

// User chose to use existing address
async function handleUseExistingAddress(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} chose to use existing address for order ${orderRef}`);
  
  // Get pending orders for this user with this state
  const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_address_confirmation');
  const order = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (order && order.existingAddress) {
    // Update order status to awaiting payment
    await updatePendingOrder(orderRef, order.timestamp, {
      status: 'awaiting_payment_method',
      addressMethod: 'existing_confirmed',
      confirmedAddress: order.existingAddress
    });
    
    // Update conversation state
    await updateContact(waId, profileName, { 
      conversationState: 'awaiting_payment_method',
      pendingOrderRef: orderRef
    });
    
    // Send confirmation and payment options
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `Perfect! ✅ Delivering to your saved address.`
    );
    
    await delay(500);
    await sendPaymentOptionButtons(waId, orderRef);
  }
}

// User wants to add new address
async function handleRequestNewAddress(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} wants new address for order ${orderRef}`);
  
  // Get pending order
  const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_address_confirmation');
  const order = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (order) {
    // Update order status
    await updatePendingOrder(orderRef, order.timestamp, {
      status: 'awaiting_address',
      addressSelectionMethod: 'requested_new'
    });
    
    // Update conversation state
    await updateContact(waId, profileName, { 
      conversationState: 'awaiting_address',
      pendingOrderRef: orderRef
    });
    
    // Send message
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `No problem! 📍 Please send me your complete delivery address including:\n- Street/Building\n- Area\n- City\n- Landmarks (if any)`
    );
  }
}

// Handle address flow response (or text address for simplicity)
async function handleAddressFlowResponse(message, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  // Get contact to check conversation state
  const contact = await getContact(waId);
  
  if (contact && contact.conversationState === 'awaiting_address') {
    // Extract address from flow response
    let addressData = {};
    
    if (message.interactive.nfm_reply && message.interactive.nfm_reply.response_json) {
      const responseJson = typeof message.interactive.nfm_reply.response_json === 'string'
        ? JSON.parse(message.interactive.nfm_reply.response_json)
        : message.interactive.nfm_reply.response_json;
      
      addressData = {
        addressText: responseJson.screen_0_Address_0 || responseJson.address || 'Address provided via flow',
        flowResponse: responseJson,
        updatedAt: Date.now()
      };
    }
    
    console.log(`Address received from ${waId}`);
    
    // Save address to contact
    await updateContact(waId, profileName, { 
      address: addressData,
      conversationState: 'address_received'
    });
    
    // Find pending orders awaiting address
    const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_address');
    
    if (pendingOrders.length > 0) {
      console.log(`Found ${pendingOrders.length} pending orders for ${waId}`);
      
      // Update orders with address and status
      for (const order of pendingOrders) {
        await updatePendingOrder(order.orderRef, order.timestamp, {
          status: 'awaiting_payment_method',
          addressData,
          addressMethod: 'newly_provided'
        });
      }
      
      // Update conversation state
      await updateContact(waId, profileName, { 
        conversationState: 'awaiting_payment_method',
        pendingOrderRef: pendingOrders[0].orderRef // Store first order ref
      });
      
      await sendWhatsAppMessage(
        phoneNumberId, token, waId,
        `Thank you! ✅ Your address has been saved.`
      );
      
      await delay(500);
      await sendPaymentOptionButtons(waId, pendingOrders[0].orderRef);
      
    } else {
      // No pending orders, just save address
      await sendWhatsAppMessage(
        phoneNumberId, token, waId,
        `Great! ✅ Your delivery address has been saved for future orders.`
      );
      
      await updateContact(waId, profileName, { 
        conversationState: 'idle'
      });
    }
  }
}

// Handle online payment selection
async function handlePayOnline(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} selected online payment for order ${orderRef}`);
  
  try {
    // Get pending order
    const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_payment_method');
    const order = pendingOrders.find(o => o.orderRef === orderRef);
    
    if (!order) {
      console.error(`No pending order found: ${orderRef}`);
      await sendWhatsAppMessage(phoneNumberId, token, waId,`Sorry, I couldn't find that order. Please try again.`);
      return;
    }
    
    const items = order.orderData?.product_items || [];
    
    // Calculate total
    let totalAmount = 0;
    const lineItems = items.map(item => {
      const itemTotal = (item.item_price || 0) * (item.quantity || 1);
      totalAmount += itemTotal;
      return {
        itemName: getProductName(item.product_retailer_id),
        price: item.item_price,
        quantity: item.quantity
      };
    });
    
    // Create Stripe checkout session
    const session = await createStripeCheckoutSession(orderRef, waId, profileName, totalAmount, lineItems);
    
    // Update order with checkout session info
    await updatePendingOrder(orderRef, order.timestamp, {
      status: 'awaiting_payment',
      paymentMethod: 'online',
      stripeSessionId: session.id,
      paymentInitiatedAt: Date.now()
    });
    
    // Update conversation state
    await updateContact(waId, profileName, { 
      conversationState: 'awaiting_payment',
      pendingOrderRef: orderRef
    });
    
    // Send payment link
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `💳 Complete your payment securely:\n\n${session.url}\n\n✅ Click the link to pay with your card.\n⏱️ Link expires in 30 minutes.\n\nTotal: AED ${totalAmount.toFixed(2)}`
    );
    
  } catch (error) {
    console.error('Error creating Stripe checkout:', error);
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `Sorry, there was an error processing your payment. Please try again or select Cash on Delivery.`
    );
  }
}

// Handle cash on delivery selection
async function handleCashOnDelivery(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} selected cash on delivery for order ${orderRef}`);
  
  // Get pending order
  const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_payment_method');
  const order = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (!order) {
    console.error(`No pending order found: ${orderRef}`);
    return;
  }
  
  // Send order to queue with COD payment method
  await sendToOrderQueue({
    orderRef,
    waId,
    profileName,
    orderData: order.orderData,
    orderType: order.orderType,
    addressData: order.confirmedAddress || null,
    addressMethod: order.addressMethod || 'not_required',
    paymentMethod: 'cod',
    timestamp: Date.now()
  });
  
  // Update order status
  await updatePendingOrder(orderRef, order.timestamp, {
    status: 'queued_for_processing',
    paymentMethod: 'cod',
    queuedAt: Date.now()
  });
  
  // Update conversation state
  await updateContact(waId, profileName, { 
    conversationState: 'order_processing'
  });
  
  // Send confirmation
  await sendWhatsAppMessage(
    phoneNumberId, token, waId,
    `Perfect! 💵 Your order is confirmed with Cash on Delivery.\n\n✅ Processing your order now...`
  );
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
    direction: 'inbound',
    receivedAt: new Date().toISOString(),
  });
  
  // Update contact activity
  await updateContact(waId, profileName);

  try {
    // Get current conversation state
    const contact = await getContact(waId);
    const conversationState = contact?.conversationState || 'idle';
    
    // Handle text messages based on conversation state
    if (messageType === 'text') {
      const text = message.text?.body || '';
      console.log(`Text message: "${text}" (state: ${conversationState})`);

      // If awaiting address, treat text as address
      if (conversationState === 'awaiting_address') {
        const addressData = {
          addressText: text,
          updatedAt: Date.now()
        };
        
        // Save address and process pending orders
        await updateContact(waId, profileName, { 
          address: addressData,
          conversationState: 'address_received'
        });
        
        const pendingOrders = await getPendingOrdersByUser(waId, 'awaiting_address');
        
        if (pendingOrders.length > 0) {
          await sendWhatsAppMessage(
            phoneNumberId, token, waId,
            `Thank you for the address! ✅ Processing your order${pendingOrders.length > 1 ? 's' : ''} now...`
          );
          
          for (const order of pendingOrders) {
            await sendToOrderQueue({
              orderRef: order.orderRef,
              waId,
              profileName,
              orderData: order.orderData,
              addressData,
              addressMethod: 'text_message',
              timestamp: Date.now()
            });
            
            await updatePendingOrder(order.orderRef, order.timestamp, {
              status: 'queued_for_processing',
              addressData,
              addressMethod: 'text_message',
              queuedAt: Date.now()
            });
          }
          
          await updateContact(waId, profileName, { 
            conversationState: 'order_processing'
          });
        }
        return;
      }

      // Regular text message handling
      const lowerText = text.toLowerCase().trim();
      
      if (lowerText === 'hi' || lowerText === 'hello' || lowerText === 'hey') {
        await sendCatalogButton(
          phoneNumberId, token, waId,
          `Hello ${profileName}! 👋 Welcome to our store.\n\n🍽️ Browse our delicious menu by tapping the button below to place your order!`
        );
      } else if (lowerText.includes('order') || lowerText.includes('menu') || lowerText.includes('catalog')) {
        await sendCatalogButton(
          phoneNumberId, token, waId,
          `Great! 🛒 Browse our full catalog by tapping the button below.`
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
      await handleOrderMessage(message, waId, profileName);
    }
    
    // Handle interactive messages (buttons, lists, flows)
    else if (messageType === 'interactive') {
      await handleInteractiveMessage(message, waId, profileName);
    }
    
    // Handle other message types
    else {
      await sendWhatsAppMessage(
        phoneNumberId, token, waId,
        `Thank you for your message! I've received your ${messageType}. Our team will respond shortly.`
      );
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
  
  // Payment success redirect (from Stripe)
  if (path.includes('payment-success')) {
    const sessionId = queryParams.session_id;
    console.log('Payment success redirect:', sessionId);
    
    if (sessionId) {
      // Trigger payment processing asynchronously
      handleStripePaymentSuccess(sessionId).catch(err => {
        console.error('Error processing payment success:', err);
      });
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <html>
          <head>
            <title>Payment Successful</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .success { color: #4CAF50; font-size: 24px; margin: 20px; }
            </style>
          </head>
          <body>
            <div class="success">✅ Payment Successful!</div>
            <p>Your order is being processed.</p>
            <p>You will receive a confirmation on WhatsApp shortly.</p>
            <p>You can close this window now.</p>
            <script>
              setTimeout(function() {  window.close(); }, 3000);
            </script>
          </body>
        </html>
      `
    };
  }
  
  // Payment cancelled
  if (path.includes('payment-cancel')) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <html>
          <head>
            <title>Payment Cancelled</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              .cancelled { color: #f44336; font-size: 24px; margin: 20px; }
            </style>
          </head>
          <body>
            <div class="cancelled">❌ Payment Cancelled</div>
            <p>Your payment was not completed.</p>
            <p>Return to WhatsApp to try again or select Cash on Delivery.</p>
            <p>You can close this window now.</p>
          </body>
        </html>
      `
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
