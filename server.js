require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const logger = require('./logger');
const eventLogger = require('./event-logger');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Create data directory for storing raw webhook payloads
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// Middleware to parse JSON
app.use(bodyParser.json());

// Middleware to log all requests
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.http(`${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
  });
  
  next();
});

// WhatsApp Webhook Verification
app.get('/webhook', (req, res) => {
  // Parse the query params
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];

  // Check if a token and mode is in the query string
  if (mode && token) {
    // Check the mode and token
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      // Respond with the challenge token
      logger.info('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      // Respond with '403 Forbidden' if verify tokens do not match
      logger.warn(`Webhook verification failed - token mismatch, received: ${token}`);
      res.sendStatus(403);
    }
  } else {
    // Return a '404 Not Found' if event is not from a page subscription
    logger.warn('Webhook verification failed - missing parameters');
    res.sendStatus(404);
  }
});

// WhatsApp Webhook Event Handler
app.post('/webhook', (req, res) => {
  // Return a '200 OK' response to acknowledge receipt of the event
  res.status(200).send('EVENT_RECEIVED');

  const body = req.body;
  
  // Log all webhook events to a separate file with headers if enabled
  eventLogger.logWebhookEvent(body, req.headers);
  
  // Log the webhook event with the regular logger
  logger.logWebhookEvent(body);
  
  // Store raw webhook payload for debugging if event logging is not enabled
  if (process.env.ENABLE_FULL_EVENT_LOGGING !== 'true') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `webhook-${timestamp}.json`;
    fs.writeFileSync(
      path.join(dataDir, filename),
      JSON.stringify(body, null, 2)
    );
    logger.debug(`Stored webhook payload in ${filename}`);
  }

  // Check if this is a WhatsApp Business Account Message
  if (body.object) {
    if (body.entry && 
        body.entry[0].changes && 
        body.entry[0].changes[0] && 
        body.entry[0].changes[0].value &&
        body.entry[0].changes[0].value.messages) {
      
      const messages = body.entry[0].changes[0].value.messages;
      const waId = body.entry[0].changes[0].value.contacts[0].wa_id;
      const metadata = body.entry[0].changes[0].value.metadata;
      
      logger.info(`Received ${messages.length} message(s) from ${waId}`, { metadata });
      
      // Process each message
      messages.forEach(message => {
        processMessage(message, waId);
      });
    } 
    // Check for shopping events (catalog, product inquiries, cart actions)
    else if (body.entry && 
             body.entry[0].changes && 
             body.entry[0].changes[0] && 
             body.entry[0].changes[0].value &&
             body.entry[0].changes[0].value.shopping) {
      
      const shoppingData = body.entry[0].changes[0].value.shopping;
      const metadata = body.entry[0].changes[0].value.metadata;
      let waId = ''; 
      
      // Extract waId if contacts is available
      if (body.entry[0].changes[0].value.contacts && 
          body.entry[0].changes[0].value.contacts.length > 0) {
        waId = body.entry[0].changes[0].value.contacts[0].wa_id;
      }
      
      logger.info(`Received shopping event from ${waId || 'unknown user'}`, { 
        eventType: Object.keys(shoppingData)[0],
        metadata 
      });
      
      // Process shopping event
      processShoppingEvent(shoppingData, waId, metadata);
    } else {
      // Log other event types
      logger.debug('Received other webhook event type', { body });
    }
  }
});

// Process Message Handler
function processMessage(message, waId) {
  const messageType = message.type;
  
  if (messageType === 'text') {
    logger.info(`Text message from ${waId}:`, { 
      text: message.text.body,
      messageId: message.id,
      timestamp: message.timestamp
    });
    // Here you could check for keywords like "menu", "order", etc.
    
  } else if (messageType === 'interactive') {
    logger.info(`Interactive message from ${waId}:`, { 
      interactiveType: message.interactive.type,
      messageId: message.id,
      timestamp: message.timestamp
    });
    // Handle button responses and list selections
    
    if (message.interactive.type === 'button_reply') {
      // Handle button replies
      const buttonId = message.interactive.button_reply.id;
      const buttonText = message.interactive.button_reply.title;
      logger.info(`Button reply from ${waId}:`, { buttonId, buttonText });
      
      // Process different button actions here
      
    } else if (message.interactive.type === 'list_reply') {
      // Handle list selections
      const listId = message.interactive.list_reply.id;
      const listTitle = message.interactive.list_reply.title;
      logger.info(`List selection from ${waId}:`, { listId, listTitle });
      
      // Process different list selections here
    }
  }
}

// Process Shopping Event Handler
function processShoppingEvent(shopping, waId, metadata) {
  const shoppingEventType = Object.keys(shopping)[0]; // can be 'catalog_message', 'product_inquiry', 'order'
  
  logger.info(`Processing ${shoppingEventType} from ${waId}`);
  
  if (shoppingEventType === 'catalog_message') {
    // User interacted with the catalog
    logger.logCatalogInteraction(shopping.catalog_message, waId);
    
  } else if (shoppingEventType === 'product_inquiry') {
    // User is inquiring about a specific product
    const product = shopping.product_inquiry.product;
    logger.logProductInquiry(product, waId);
    
    // Here you might send back product availability, variations, etc.
    
  } else if (shoppingEventType === 'order') {
    // User placed an order
    const order = shopping.order;
    logger.logOrder(order, waId);
    
    // Process the order
    processOrderToiPOS(order, waId);
    
    // Send order confirmation message
    sendOrderConfirmation(order, waId);
  }
}

// Process Order to iPOS
async function processOrderToiPOS(order, waId) {
  try {
    // Here you would implement the logic to push the order to your iPOS system
    // This is a placeholder implementation
    
    logger.info(`Processing order from ${waId} to iPOS system`);
    
    // Format the order to match iPOS API requirements
    // Get authentication token
    // Post the order to iPOS
    
    // Example structure - this would need to be customized for your iPOS API
    const totalAmount = order.product_items.reduce((total, item) => {
      return total + (item.price * item.quantity);
    }, 0);
    
    logger.info(`Order total: ${totalAmount} ${order.product_items[0].currency}`);
    
    // Return true if successful
    return true;
  } catch (error) {
    logger.error('Error processing order to iPOS:', error);
    return false;
  }
}

// Send Order Confirmation
async function sendOrderConfirmation(order, waId) {
  try {
    // Generate order summary
    const orderItems = order.product_items.map(item => 
      `• ${item.name} x${item.quantity} - ${item.price} ${item.currency}`
    ).join('\n');
    
    const totalAmount = order.product_items.reduce((total, item) => {
      return total + (item.price * item.quantity);
    }, 0);
    
    const message = `Thank you for your order!\n\n*Order Summary:*\n${orderItems}\n\n*Total:* ${totalAmount} ${order.product_items[0].currency}\n\nYour order is being processed and we'll notify you when it's ready.`;
    
    // Send message using WhatsApp API
    logger.info(`Sending order confirmation to ${waId}`);
    
    // In a real implementation, you would call the WhatsApp API here
    sendWhatsAppMessage(waId, message);
    
  } catch (error) {
    logger.error('Error sending order confirmation:', error);
  }
}

// Send WhatsApp Message Helper
async function sendWhatsAppMessage(to, message) {
  try {
    logger.debug(`Sending WhatsApp message to ${to}`, { messageLength: message.length });
    
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
        to: to,
        type: 'text',
        text: {
          body: message
        }
      }
    });
    
    logger.info('Message sent successfully', { 
      recipient: to, 
      messageId: response.data.messages?.[0]?.id
    });
    return response.data;
  } catch (error) {
    logger.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

// Event log viewer endpoint - for debugging use only in non-production environments
app.get('/events', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Forbidden in production environment' });
  }
  
  const eventId = req.query.id;
  const limit = parseInt(req.query.limit || '50', 10);
  
  const events = eventLogger.readEvents(eventId, limit);
  res.json(events);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    eventLoggingEnabled: eventLogger.isEventLoggingEnabled()
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Start server
app.listen(PORT, () => {
  logger.info(`WhatsApp Webhook server running on port ${PORT}`);
  logger.info(`Full event logging is ${eventLogger.isEventLoggingEnabled() ? 'enabled' : 'disabled'}`);
});