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

// Get readable order status text
function getOrderStatusText(status) {
  const statusMap = {
    'awaiting_order_type': 'Waiting for delivery/takeaway selection',
    'awaiting_address_confirmation': 'Waiting for address confirmation',
    'awaiting_address': 'Waiting for delivery address',
    'awaiting_payment_method': 'Waiting for payment method selection',
    'awaiting_payment': 'Waiting for payment completion',
    'queued_for_processing': 'Being processed',
    'cancelled_timeout': 'Cancelled (timeout)',
    'cancelled_by_user': 'Cancelled by you'
  };
  return statusMap[status] || status;
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
      isPrepaid: true,
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
    
    // Update conversation state and clear pending order reference
    await updateContact(waId, profileName, { 
      conversationState: 'order_processing',
      pendingOrderRef: null
    });
    
    // Send confirmation to WhatsApp
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_API_TOKEN;
    
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `✅ Payment received! Your order is being processed now...\n\n💳 Payment Reference: ${session.payment_intent}`
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
    
    if (updates.pendingNewOrder !== undefined) {
      updateData.UpdateExpression += ', pendingNewOrder = :pendingNew';
      updateData.ExpressionAttributeValues[':pendingNew'] = updates.pendingNewOrder;
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
    let result;
    if (status) {
      // Query with specific status
      result = await docClient.send(new QueryCommand({
        TableName: PENDING_ORDERS_TABLE,
        IndexName: 'WaIdStatusIndex',
        KeyConditionExpression: 'waId = :waId AND #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':waId': waId,
          ':status': status
        }
      }));
    } else {
      // Query all orders for user using WaIdIndex (without status filter)
      result = await docClient.send(new QueryCommand({
        TableName: PENDING_ORDERS_TABLE,
        IndexName: 'WaIdIndex',
        KeyConditionExpression: 'waId = :waId',
        ExpressionAttributeValues: {
          ':waId': waId
        }
      }));
      
      // Filter out cancelled and processed orders in code
      if (result.Items) {
        result.Items = result.Items.filter(item => 
          item.status !== 'cancelled_timeout' && 
          item.status !== 'cancelled_by_user' && 
          item.status !== 'queued_for_processing'
        );
      }
    }
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
    console.log(`Sending order to queue:`, JSON.stringify(orderData, null, 2));
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
  const middlewareUrl = 'https://api.ipossoft.com/createorder/webhooks/pd30wdfa5g/whatsapp';
  
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

// Helper function to send WhatsApp Flow
async function sendWhatsAppFlow(phoneNumberId, token, to, flowId, flowToken, headerText, bodyText, footerText, ctaText) {
  const data = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: {
        type: 'text',
        text: headerText
      },
      body: {
        text: bodyText
      },
      footer: {
        text: footerText
      },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken,
          flow_id: flowId,
          flow_cta: ctaText,
          flow_action: 'navigate',
          flow_action_payload: {
            screen: 'RECOMMEND'
          }
        }
      }
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
async function sendPaymentOptionButtons(waId, orderRef, orderType) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  // Change button text based on order type
  const cashButtonText = orderType === 'takeaway' ? '💵 Pay at Counter' : '💵 Cash on Delivery';
  
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
        title: cashButtonText
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

// Helper to send existing order conflict buttons
async function sendExistingOrderButtons(waId, existingOrderRef, existingStatus) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  const statusText = getOrderStatusText(existingStatus);
  const buttons = [
    {
      type: 'reply',
      reply: {
        id: `keep_previous:${existingOrderRef}`,
        title: '✅ Keep Previous'
      }
    },
    {
      type: 'reply',
      reply: {
        id: `cancel_previous:${existingOrderRef}`,
        title: '❌ Cancel Previous'
      }
    }
  ];
  
  await sendInteractiveButtons(
    phoneNumberId,
    token,
    waId,
    '⚠️ Existing Order Found',
    `You have an existing order:

📦 Order: ${existingOrderRef}\n⏱️ Status: ${statusText}\n\nWhat would you like to do?`,
    buttons
  );
}

// Helper to send pending order reminder buttons
async function sendPendingOrderReminder(waId, orderRef, status) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  const statusText = getOrderStatusText(status);
  
  // Determine next action based on status
  let nextAction = '';
  switch(status) {
    case 'awaiting_order_type':
      nextAction = '👉 Next step: Choose delivery or takeaway';
      break;
    case 'awaiting_address_confirmation':
      nextAction = '👉 Next step: Confirm your delivery address';
      break;
    case 'awaiting_address':
      nextAction = '👉 Next step: Provide your delivery address';
      break;
    case 'awaiting_payment_method':
      nextAction = '👉 Next step: Choose payment method';
      break;
    case 'awaiting_payment':
      nextAction = '👉 Next step: Complete your payment';
      break;
    default:
      nextAction = '👉 Continue with your order';
  }
  
  const buttons = [
    {
      type: 'reply',
      reply: {
        id: `continue_order:${orderRef}`,
        title: '✅ Continue Order'
      }
    },
    {
      type: 'reply',
      reply: {
        id: `cancel_order:${orderRef}`,
        title: '❌ Cancel Order'
      }
    }
  ];
  
  await sendInteractiveButtons(
    phoneNumberId,
    token,
    waId,
    '📦 Pending Order',
    `You have an incomplete order:

📦 Order: ${orderRef}
⏱️ Status: ${statusText}

${nextAction}`,
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
  
  // Check for existing pending orders
  const existingOrders = await getPendingOrdersByUser(waId);
  if (existingOrders && existingOrders.length > 0) {
    const pendingOrder = existingOrders[0];
    const orderAge = Date.now() - pendingOrder.timestamp;
    const thirtyMinutes = 30 * 60 * 1000;
    
    // If order is older than 30 minutes, auto-cancel it
    if (orderAge > thirtyMinutes) {
      await updatePendingOrder(pendingOrder.orderRef, pendingOrder.timestamp, {
        status: 'cancelled_timeout',
        cancelledAt: Date.now(),
        cancelReason: 'timeout'
      });
      // Clear pending order reference since it's cancelled
      await updateContact(waId, profileName, {
        pendingOrderRef: null
      });
      console.log(`Auto-cancelled order ${pendingOrder.orderRef} due to timeout`);
    } else {
      // Store new order temporarily and ask user what to do with existing order
      await updateContact(waId, profileName, {
        conversationState: 'existing_order_conflict',
        pendingNewOrder: {
          order: order,
          items: items,
          timestamp: Date.now()
        }
      });
      
      await sendExistingOrderButtons(waId, pendingOrder.orderRef, pendingOrder.status);
      return;
    }
  }
  
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
    // NO ADDRESS - Send Flow for address collection
    console.log(`No address found for ${waId}, sending address collection flow`);
    
    // Update conversation state
    await updateContact(waId, profileName, { 
      conversationState: 'awaiting_address',
      pendingOrderRef: orderRef
    });
    
    // Send WhatsApp Flow for address collection
    const flowId = '2029105360982410';
    const flowToken = `address_${orderRef}_${Date.now()}`;
    
    await sendWhatsAppFlow(
      phoneNumberId, token, waId,
      flowId,
      flowToken,
      '📍 Delivery Address',
      'Please provide your complete delivery address. We\'ll save this for faster checkout next time!',
      'Powered by iPOS',
      'Enter Address'
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
  await sendPaymentOptionButtons(waId, orderRef, 'takeaway');
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
    // Keep previous order and discard new one
    else if (buttonId.startsWith('keep_previous:')) {
      const orderRef = buttonId.split(':')[1];
      await handleKeepPreviousOrder(orderRef, waId, profileName);
    }
    // Cancel previous order and continue with new one
    else if (buttonId.startsWith('cancel_previous:')) {
      const orderRef = buttonId.split(':')[1];
      await handleCancelPreviousOrder(orderRef, waId, profileName);
    }
    // Continue with pending order
    else if (buttonId.startsWith('continue_order:')) {
      const orderRef = buttonId.split(':')[1];
      await handleContinueOrder(orderRef, waId, profileName);
    }
    // Cancel pending order
    else if (buttonId.startsWith('cancel_order:')) {
      const orderRef = buttonId.split(':')[1];
      await handleCancelOrder(orderRef, waId, profileName);
    }
  }
  
  // Handle flow responses (nfm_reply) - address collection
  else if (interactive.type === 'nfm_reply') {
    await handleAddressFlowResponse(message, waId, profileName);
  }
}

// User chose to keep previous order and discard new one
async function handleKeepPreviousOrder(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} chose to keep previous order ${orderRef}`);
  
  // Get the previous order to restore proper state
  const pendingOrders = await getPendingOrdersByUser(waId);
  const previousOrder = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (!previousOrder) {
    // If we can't find the order, just clear the conflict
    await updateContact(waId, profileName, {
      conversationState: 'idle',
      pendingNewOrder: null
    });
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `❌ Sorry, I couldn't find your previous order. Please place a new order.`
    );
    return;
  }
  
  // Restore conversation state to match the previous order's status
  const conversationStateMap = {
    'awaiting_order_type': 'awaiting_order_type',
    'awaiting_address_type': 'awaiting_address_type',
    'awaiting_payment_method': 'awaiting_payment_method',
    'awaiting_payment': 'awaiting_payment'
  };
  
  const restoredState = conversationStateMap[previousOrder.status] || 'idle';
  
  // Clear the pending new order and restore to previous order's state
  await updateContact(waId, profileName, {
    conversationState: restoredState,
    pendingOrderRef: orderRef,
    pendingNewOrder: null
  });
  
  // Send appropriate message based on where they were
  let nextStepMessage = '';
  if (previousOrder.status === 'awaiting_order_type') {
    nextStepMessage = '\n\nPlease select delivery or takeaway to continue.';
  } else if (previousOrder.status === 'awaiting_address_type') {
    nextStepMessage = '\n\nPlease provide your delivery address to continue.';
  } else if (previousOrder.status === 'awaiting_payment_method') {
    nextStepMessage = '\n\nPlease select your payment method to continue.';
  } else if (previousOrder.status === 'awaiting_payment') {
    nextStepMessage = '\n\nPlease complete your payment to continue.';
  }
  
  await sendWhatsAppMessage(
    phoneNumberId, token, waId,
    `✅ Your previous order (${orderRef}) will continue. The new order has been discarded.${nextStepMessage}`
  );
}

// User chose to cancel previous order and continue with new one
async function handleCancelPreviousOrder(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} chose to cancel previous order ${orderRef} and continue with new one`);
  
  // Get the contact to retrieve the new order data
  const contact = await getContact(waId);
  const newOrderData = contact?.pendingNewOrder;
  
  if (!newOrderData || !newOrderData.order) {
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `❌ Sorry, I couldn't find the new order data. Please try placing your order again.`
    );
    return;
  }
  
  // Get the pending orders to find the one to cancel
  const pendingOrders = await getPendingOrdersByUser(waId);
  const orderToCancel = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (orderToCancel) {
    // Cancel the previous order
    await updatePendingOrder(orderRef, orderToCancel.timestamp, {
      status: 'cancelled_by_user',
      cancelledAt: Date.now(),
      cancelReason: 'user_started_new_order'
    });
    console.log(`Cancelled previous order ${orderRef}`);
  }
  
  // Now process the new order
  const newOrderRef = `ORD-${Date.now()}-${waId.slice(-4)}`;
  const items = newOrderData.order?.product_items || [];
  
  // Save pending order
  await savePendingOrder(newOrderRef, waId, profileName, newOrderData.order, 'awaiting_order_type');
  
  // Update contact
  await updateContact(waId, profileName, {
    conversationState: 'awaiting_order_type',
    pendingOrderRef: newOrderRef,
    pendingNewOrder: null
  });
  
  // Send acknowledgment and ask for order type
  await sendWhatsAppMessage(
    phoneNumberId, token, waId,
    `✅ Previous order cancelled. Processing your new order! 🎉`
  );
  
  await delay(1000);
  await sendOrderTypeButtons(waId, newOrderRef);
}

// User chose to continue with pending order
async function handleContinueOrder(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} chose to continue order ${orderRef}`);
  
  // Get the pending order
  const pendingOrders = await getPendingOrdersByUser(waId);
  const order = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (!order) {
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `❌ Sorry, I couldn't find your order. Please place a new order.`
    );
    return;
  }
  
  // Just send the appropriate prompt based on current order status
  // State is already correct, just need to prompt user for next step
  if (order.status === 'awaiting_order_type') {
    await sendOrderTypeButtons(waId, orderRef);
  } else if (order.status === 'awaiting_address_confirmation' && order.existingAddress) {
    await sendAddressConfirmationButtons(waId, orderRef, order.existingAddress.addressText);
  } else if (order.status === 'awaiting_address') {
    await sendAddressFlow(waId, orderRef);
  } else if (order.status === 'awaiting_payment_method') {
    await sendPaymentOptionButtons(waId, orderRef, order.orderType || 'delivery');
  } else if (order.status === 'awaiting_payment') {
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `💳 Please complete your payment using the link sent earlier to complete your order ${orderRef}.`
    );
  } else {
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `✅ Order ${orderRef} is being processed!`
    );
  }
}

// User chose to cancel pending order
async function handleCancelOrder(orderRef, waId, profileName) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  console.log(`User ${waId} chose to cancel order ${orderRef}`);
  
  // Get the pending order
  const pendingOrders = await getPendingOrdersByUser(waId);
  const order = pendingOrders.find(o => o.orderRef === orderRef);
  
  if (!order) {
    await sendWhatsAppMessage(
      phoneNumberId, token, waId,
      `❌ Sorry, I couldn't find your order.`
    );
    return;
  }
  
  // Cancel the order
  await updatePendingOrder(orderRef, order.timestamp, {
    status: 'cancelled_by_user',
    cancelledAt: Date.now(),
    cancelReason: 'user_requested'
  });
  
  // Clear pending order reference and reset state
  await updateContact(waId, profileName, {
    conversationState: 'idle',
    pendingOrderRef: null
  });
  
  await sendWhatsAppMessage(
    phoneNumberId, token, waId,
    `✅ Your order ${orderRef} has been cancelled. You can place a new order anytime by browsing our catalog!`
  );
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
    await sendPaymentOptionButtons(waId, orderRef, 'delivery');
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
    
    // Send WhatsApp Flow for address collection
    const flowId = '2029105360982410';
    const flowToken = `address_${orderRef}_${Date.now()}`;
    
    await sendWhatsAppFlow(
      phoneNumberId, token, waId,
      flowId,
      flowToken,
      '📍 Delivery Address',
      'Please provide your complete delivery address. We\'ll save this for faster checkout next time!',
      'Powered by iPOS',
      'Enter Address'
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
      
      console.log('Flow response received:', JSON.stringify(responseJson, null, 2));
      
      // Extract fields from your Flow structure
      const apartment = responseJson.screen_0_Appartment_Building_0 || '';
      const street = responseJson.screen_0_Street_1 || '';
      const landmark = responseJson.screen_0_Landmark_2 || '';
      const city = responseJson.screen_0_City_3 || '';
      const emirateId = responseJson.screen_0_Emirate_4 || '';
      
      // Extract emirate name from ID (format: "0_Dubai" -> "Dubai")
      const emirate = emirateId ? emirateId.split('_').slice(1).join(' ') : '';
      
      // Build formatted address text
      const addressParts = [
        apartment,
        street,
        landmark,
        city,
        emirate
      ].filter(part => part && part.trim() !== '');
      
      const formattedAddress = addressParts.join(', ');
      
      addressData = {
        addressText: formattedAddress,
        apartment,
        street,
        landmark,
        city,
        emirate,
        flowResponse: responseJson,
        updatedAt: Date.now()
      };
    }
    
    console.log(`Address received from ${waId}: ${addressData.addressText}`);
    
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
      await sendPaymentOptionButtons(waId, pendingOrders[0].orderRef, pendingOrders[0].orderType || 'delivery');
      
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
    
    // Send payment link as button
    const paymentMessage = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: waId,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: {
          text: `💳 *Complete Your Payment*\n\nTotal: AED ${totalAmount.toFixed(2)}\n\n✅ Click the button below to pay securely with your card.\n⏱️ Link expires in 30 minutes.`
        },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: 'Pay Now',
            url: session.url
          }
        }
      }
    };
    
    await makeWhatsAppRequest(phoneNumberId, token, JSON.stringify(paymentMessage));
    
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
  
  console.log(`User ${waId} selected cash payment for order ${orderRef}`);
  
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
    addressData: order.confirmedAddress || order.addressData || null,
    addressMethod: order.addressMethod || 'not_required',
    paymentMethod: 'cod',
    isPrepaid: false,
    timestamp: Date.now()
  });
  
  // Update order status
  await updatePendingOrder(orderRef, order.timestamp, {
    status: 'queued_for_processing',
    paymentMethod: 'cod',
    queuedAt: Date.now()
  });
  
  // Update conversation state and clear pending order reference
  await updateContact(waId, profileName, { 
    conversationState: 'order_processing',
    pendingOrderRef: null
  });
  
  // Send confirmation based on order type
  const confirmationMessage = order.orderType === 'takeaway' 
    ? `Perfect! 💵 Your order is confirmed. Pay at counter when picking up.\n\n✅ Processing your order now...`
    : `Perfect! 💵 Your order is confirmed with Cash on Delivery.\n\n✅ Processing your order now...`;
  
  await sendWhatsAppMessage(
    phoneNumberId, token, waId,
    confirmationMessage
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

      // Regular text message handling
      const lowerText = text.toLowerCase().trim();
      
      // Check for cancel command
      if (lowerText === 'cancel') {
        const pendingOrders = await getPendingOrdersByUser(waId);
        if (pendingOrders && pendingOrders.length > 0) {
          // Cancel ALL pending orders, not just the first one
          for (const order of pendingOrders) {
            await updatePendingOrder(order.orderRef, order.timestamp, {
              status: 'cancelled_by_user',
              cancelledAt: Date.now(),
              cancelReason: 'user_requested'
            });
          }
          
          await updateContact(waId, profileName, { 
            conversationState: 'idle',
            pendingOrderRef: null
          });
          
          const orderCount = pendingOrders.length;
          const message = orderCount === 1 
            ? `✅ Your order ${pendingOrders[0].orderRef} has been cancelled. You can place a new order anytime!`
            : `✅ All ${orderCount} pending orders have been cancelled. You can place a new order anytime!`;
          
          await sendWhatsAppMessage(
            phoneNumberId, token, waId,
            message
          );
        } else {
          await sendWhatsAppMessage(
            phoneNumberId, token, waId,
            `You don't have any pending orders to cancel.`
          );
        }
        return;
      }
      
      // Check for existing pending orders when user sends any message
      const existingOrders = await getPendingOrdersByUser(waId);
      if (existingOrders && existingOrders.length > 0) {
        const order = existingOrders[0];
        const orderAge = Date.now() - order.timestamp;
        const thirtyMinutes = 30 * 60 * 1000;
        
        // Auto-cancel if older than 30 minutes
        if (orderAge > thirtyMinutes) {
          await updatePendingOrder(order.orderRef, order.timestamp, {
            status: 'cancelled_timeout',
            cancelledAt: Date.now(),
            cancelReason: 'timeout'
          });
          // Clear pending order reference and reset state
          await updateContact(waId, profileName, {
            conversationState: 'idle',
            pendingOrderRef: null
          });
          await sendWhatsAppMessage(
            phoneNumberId, token, waId,
            `⚠️ Your previous order ${order.orderRef} has been cancelled due to timeout (30 minutes). Please place a new order.`
          );
          // Don't return here - allow the message to be processed normally
        } else {
          // Send buttons instead of text message
          await sendPendingOrderReminder(waId, order.orderRef, order.status);
          return;
        }
      }
      
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
      // Process payment before returning response
      try {
        await handleStripePaymentSuccess(sessionId);
      } catch (err) {
        console.error('Error processing payment success:', err);
      }
    }
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Successful - iPOS</title>
            <style>
              * { margin: 0; padding: 0; box-sizing: border-box; }
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 50%, #0f0f0f 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
              }
              .container {
                background: rgba(255, 255, 255, 0.05);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 20px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                padding: 50px 40px;
                max-width: 500px;
                width: 100%;
                text-align: center;
                animation: slideUp 0.6s ease;
              }
              @keyframes slideUp {
                from { opacity: 0; transform: translateY(30px); }
                to { opacity: 1; transform: translateY(0); }
              }
              .logo {
                margin-bottom: 30px;
                animation: fadeIn 0.8s ease;
              }
              .logo img {
                max-width: 180px;
                height: auto;
              }
              .success-icon {
                width: 80px;
                height: 80px;
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 25px;
                animation: scaleIn 0.5s ease 0.3s both;
              }
              @keyframes scaleIn {
                from { transform: scale(0); }
                to { transform: scale(1); }
              }
              .success-icon svg {
                width: 45px;
                height: 45px;
                stroke: white;
                stroke-width: 3;
                fill: none;
                stroke-linecap: round;
                stroke-linejoin: round;
              }
              .checkmark {
                stroke-dasharray: 50;
                stroke-dashoffset: 50;
                animation: drawCheck 0.5s ease 0.8s forwards;
              }
              @keyframes drawCheck {
                to { stroke-dashoffset: 0; }
              }
              h1 {
                color: #10b981;
                font-size: 32px;
                font-weight: 700;
                margin-bottom: 15px;
                animation: fadeIn 0.8s ease 0.4s both;
              }
              @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
              }
              .message {
                color: #d1d5db;
                font-size: 16px;
                line-height: 1.6;
                margin-bottom: 12px;
                animation: fadeIn 0.8s ease 0.6s both;
              }
              .highlight {
                color: #10b981;
                font-weight: 600;
              }
              .whatsapp-note {
                background: rgba(16, 185, 129, 0.1);
                border-left: 4px solid #10b981;
                padding: 15px;
                border-radius: 8px;
                margin: 25px 0;
                animation: fadeIn 0.8s ease 0.8s both;
              }
              .whatsapp-note p {
                color: #e5e7eb;
                font-size: 14px;
                margin: 0;
              }
              .auto-close {
                color: #6b7280;
                font-size: 13px;
                margin-top: 20px;
                animation: fadeIn 0.8s ease 1s both;
              }
              @media (max-width: 480px) {
                .container { padding: 40px 25px; }
                h1 { font-size: 26px; }
                .logo img { max-width: 150px; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="logo">
                <img src="https://ipossoft.com/wp-content/uploads/2024/11/ipos-soft-logo.png" alt="iPOS">
              </div>
              <div class="success-icon">
                <svg viewBox="0 0 52 52">
                  <path class="checkmark" d="M14 27l7 7 16-16"/>
                </svg>
              </div>
              <h1>Payment Successful!</h1>
              <p class="message">Thank you for your payment. Your order is now <span class="highlight">being processed</span>.</p>
              <div class="whatsapp-note">
                <p>📱 You will receive a <strong>confirmation message</strong> on WhatsApp shortly with your order details.</p>
              </div>
              <p class="message">This window will close automatically in a few seconds.</p>
              <p class="auto-close">Powered by iPOS</p>
            </div>
            <script>
              setTimeout(function() { window.close(); }, 5000);
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
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Payment Cancelled - iPOS</title>
            <style>
              * { margin: 0; padding: 0; box-sizing: border-box; }
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 50%, #0f0f0f 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
              }
              .container {
                background: rgba(255, 255, 255, 0.05);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 20px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.5);
                padding: 50px 40px;
                max-width: 500px;
                width: 100%;
                text-align: center;
                animation: slideUp 0.6s ease;
              }
              @keyframes slideUp {
                from { opacity: 0; transform: translateY(30px); }
                to { opacity: 1; transform: translateY(0); }
              }
              .logo {
                margin-bottom: 30px;
              }
              .logo img {
                max-width: 180px;
                height: auto;
              }
              .cancel-icon {
                width: 80px;
                height: 80px;
                background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                margin: 0 auto 25px;
                animation: scaleIn 0.5s ease 0.3s both;
              }
              @keyframes scaleIn {
                from { transform: scale(0); }
                to { transform: scale(1); }
              }
              .cancel-icon svg {
                width: 45px;
                height: 45px;
                stroke: white;
                stroke-width: 3;
                fill: none;
                stroke-linecap: round;
                stroke-linejoin: round;
              }
              h1 {
                color: #ef4444;
                font-size: 32px;
                font-weight: 700;
                margin-bottom: 15px;
              }
              .message {
                color: #d1d5db;
                font-size: 16px;
                line-height: 1.6;
                margin-bottom: 12px;
              }
              .options-box {
                background: rgba(239, 68, 68, 0.1);
                border-left: 4px solid #ef4444;
                padding: 20px;
                border-radius: 8px;
                margin: 25px 0;
              }
              .options-box p {
                color: #e5e7eb;
                font-size: 14px;
                margin: 8px 0;
              }
              .options-box strong {
                color: #ef4444;
              }
              .footer {
                color: #6b7280;
                font-size: 13px;
                margin-top: 20px;
              }
              @media (max-width: 480px) {
                .container { padding: 40px 25px; }
                h1 { font-size: 26px; }
                .logo img { max-width: 150px; }
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="logo">
                <img src="https://ipossoft.com/wp-content/uploads/2024/11/ipos-soft-logo.png" alt="iPOS">
              </div>
              <div class="cancel-icon">
                <svg viewBox="0 0 52 52">
                  <line x1="16" y1="16" x2="36" y2="36"/>
                  <line x1="36" y1="16" x2="16" y2="36"/>
                </svg>
              </div>
              <h1>Payment Cancelled</h1>
              <p class="message">Your payment was not completed and no charges were made.</p>
              <div class="options-box">
                <p><strong>What's next?</strong></p>
                <p>📱 Return to <strong>WhatsApp</strong> to:</p>
                <p>• Try payment again</p>
                <p>• Select <strong>Cash on Delivery</strong> option</p>
              </div>
              <p class="message">You can safely close this window now.</p>
              <p class="footer">Powered by iPOS</p>
            </div>
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
