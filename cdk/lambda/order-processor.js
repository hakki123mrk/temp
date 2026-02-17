const https = require('https');
const fs = require('fs');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TABLE_NAME = process.env.MESSAGES_TABLE_NAME;
const CONTACTS_TABLE = process.env.CONTACTS_TABLE_NAME;
const PENDING_ORDERS_TABLE = process.env.PENDING_ORDERS_TABLE_NAME;

// Load product catalog from CSV
let productCatalog = new Map();

function loadProductCatalog() {
  try {
    const csvPath = path.join(__dirname, 'facebook_catalog.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const lines = csvContent.split('\n');
    
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
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

loadProductCatalog();

function getProductName(productId) {
  return productCatalog.get(productId) || `Product #${productId}`;
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
          resolve({ success: true, statusCode: res.statusCode, data: body });
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

// Send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_API_TOKEN;
  
  const data = JSON.stringify({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'text',
    text: { body: message }
  });

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

// Update pending order status
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
    throw error;
  }
}

// Update contact conversation state
async function updateContactState(waId, state) {
  try {
    await docClient.send(new UpdateCommand({
      TableName: CONTACTS_TABLE,
      Key: { waId },
      UpdateExpression: 'SET conversationState = :state, stateUpdatedAt = :time',
      ExpressionAttributeValues: {
        ':state': state,
        ':time': Date.now()
      }
    }));
  } catch (error) {
    console.error('Error updating contact state:', error);
  }
}

// Save confirmation message
async function saveOutboundMessage(waId, profileName, messageText) {
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        waId,
        timestamp: Date.now(),
        messageId: `out_${Date.now()}`,
        messageType: 'text',
        direction: 'outbound',
        profileName,
        text: messageText,
        sentAt: new Date().toISOString()
      }
    }));
  } catch (error) {
    console.error('Error saving outbound message:', error);
  }
}

// Process order from queue
async function processOrder(orderMessage) {
  const { orderRef, waId, profileName, orderData, addressData, addressMethod, orderType, timestamp } = orderMessage;
  
  console.log(`Processing order ${orderRef} for ${profileName} (${waId})`);
  console.log(`Order type: ${orderType}, Address method: ${addressMethod}`);
  
  const items = orderData?.product_items || [];
  
  // Calculate totals and build item list
  let totalAmount = 0;
  const itemsList = items.map(item => {
    const itemTotal = (item.item_price || 0) * (item.quantity || 1);
    totalAmount += itemTotal;
    const productName = getProductName(item.product_retailer_id);
    return `• ${item.quantity}x ${productName} - AED ${item.item_price.toFixed(2)}`;
  }).join('\n');
  
  let middlewareOrderId = orderRef;
  let orderSuccess = false;
  let errorMessage = '';
  
  try {
    // Update order status to processing
    await updatePendingOrder(orderRef, timestamp, {
      status: 'processing',
      processingStartedAt: Date.now()
    });
    
    // Prepare middleware payload
    const middlewarePayload = {
      channelOrderId: orderRef,
      customerName: profileName,
      customerPhone: waId,
      customerAddress: addressData?.addressText || (orderType === 'takeaway' ? 'Pickup from store' : 'No address provided'),
      orderType: orderType || 'delivery',
      tableNo: null,
      totalAmount: totalAmount,
      items: items.map(item => ({
        itemCode: item.product_retailer_id,
        itemName: getProductName(item.product_retailer_id),
        quantity: item.quantity,
        price: item.item_price
      })),
      notes: `Address collected via: ${addressMethod}`
    };
    
    console.log('Forwarding to middleware:', JSON.stringify(middlewarePayload));
    
    // Forward to middleware
    const middlewareResponse = await forwardOrderToMiddleware(middlewarePayload);
    
    // Try to parse response to get order ID
    try {
      const responseData = JSON.parse(middlewareResponse.data);
      if (responseData.orderReferenceId) {
        middlewareOrderId = responseData.orderReferenceId;
      }
    } catch (parseError) {
      console.log('Could not parse middleware response for order ID');
    }
    
    orderSuccess = true;
    console.log(`Order successfully forwarded to middleware: ${middlewareOrderId}`);
    
    // Update order status to completed
    await updatePendingOrder(orderRef, timestamp, {
      status: 'completed',
      processingCompletedAt: Date.now(),
      middlewareOrderId,
      middlewareResponse: middlewareResponse.data
    });
    
  } catch (error) {
    console.error(`Error processing order ${orderRef}:`, error);
    errorMessage = error.message;
    
    // Update order status to failed
    await updatePendingOrder(orderRef, timestamp, {
      status: 'failed',
      processingFailedAt: Date.now(),
      error: errorMessage
    });
  }
  
  // Send confirmation to customer
  try {
    let confirmationMessage;
    
    if (orderSuccess) {
      if (orderType === 'takeaway') {
        confirmationMessage = `✅ Order Confirmed! (${middlewareOrderId})\n\n` +
          `📦 Your Order:\n${itemsList}\n\n` +
          `💰 Total: AED ${totalAmount.toFixed(2)}\n\n` +
          `🏪 Pickup: Ready in 15-20 minutes\n\n` +
          `Your order is being prepared for pickup! 🎉`;
      } else {
        confirmationMessage = `✅ Order Confirmed! (${middlewareOrderId})\n\n` +
          `📦 Your Order:\n${itemsList}\n\n` +
          `💰 Total: AED ${totalAmount.toFixed(2)}\n\n` +
          `📍 Delivery Address:\n${addressData?.addressText || 'Address on file'}\n\n` +
          `Your order is being prepared and will be delivered soon! 🚚`;
      }
    } else {
      confirmationMessage = `❌ Sorry, there was an issue processing your order (${orderRef}).\n\n` +
        `Error: ${errorMessage}\n\n` +
        `Please contact support or try again.`;
    }
    
    await sendWhatsAppMessage(waId, confirmationMessage);
    await saveOutboundMessage(waId, profileName, confirmationMessage);
    
    console.log(`Confirmation sent to ${waId}`);
    
  } catch (error) {
    console.error(`Failed to send confirmation to ${waId}:`, error);
  }
  
  // Update conversation state
  await updateContactState(waId, orderSuccess ? 'order_completed' : 'order_failed');
  
  return {
    orderRef,
    success: orderSuccess,
    middlewareOrderId
  };
}

// Lambda handler for SQS events
exports.handler = async (event) => {
  console.log('Order processor triggered:', JSON.stringify(event));
  
  const results = [];
  
  for (const record of event.Records) {
    try {
      const orderMessage = JSON.parse(record.body);
      console.log('Processing order from queue:', orderMessage.orderRef);
      
      const result = await processOrder(orderMessage);
      results.push(result);
      
    } catch (error) {
      console.error('Error processing SQS record:', error);
      // Don't throw - let other records process
      results.push({
        error: error.message,
        record: record.messageId
      });
    }
  }
  
  console.log('Order processing complete:', results);
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      processed: results.length,
      results
    })
  };
};
