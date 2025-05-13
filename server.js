require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const logger = require('./logger');
const eventLogger = require('./event-logger');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

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
async function processShoppingEvent(shopping, waId, metadata) {
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
    const orderReference = logger.logOrder(order, waId);

    try {
      // Process the order and get the result - pass the order reference for tracking
      const orderResult = await processOrderToiPOS(order, waId, orderReference);

      // Send order confirmation message with the result info
      sendOrderConfirmation(order, waId, orderResult, orderReference);
    } catch (error) {
      logger.error(`Error processing order workflow for ${orderReference}:`, error);

      // Send a basic confirmation even if processing failed
      sendOrderConfirmation(order, waId, { success: false, error: error.message }, orderReference);
    }
  }
}

// Authenticate with iPOS API
async function authenticateWithIPOS() {
  try {
    logger.info('Authenticating with iPOS API');

    const response = await axios({
      method: 'POST',
      url: `${process.env.IPOS_API_URL}/Token`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `username=${process.env.IPOS_USERNAME}&password=${process.env.IPOS_PASSWORD}&grant_type=password`
    });

    if (response.data && response.data.access_token) {
      logger.info('Successfully authenticated with iPOS API');
      return response.data.access_token;
    } else {
      throw new Error('Invalid authentication response from iPOS API');
    }
  } catch (error) {
    logger.error('Error authenticating with iPOS API:', error.response?.data || error.message);
    throw error;
  }
}

// Format WhatsApp order for iPOS API
function formatOrderForIPOS(order, waId, orderReference) {
  // Calculate total amount including all items
  const totalAmount = order.product_items.reduce((total, item) => {
    return total + (item.price * item.quantity);
  }, 0);

  // Calculate VAT amount (5% in UAE)
  const vatRate = 0.05;
  const vatAmount = totalAmount * vatRate;
  const roundedVatAmount = Math.round(vatAmount * 100) / 100;

  // Get current date and time
  const now = new Date();
  const formattedDate = now.toISOString();

  // Create sales details array from order items
  const salesDetails = order.product_items.map((item, index) => {
    return {
      "SlNo": index + 1,
      "InvNo": 0,
      "Barcode": item.product_retailer_id, // Using retailer ID as barcode
      "Qty": item.quantity,
      "UnitId": 0,
      "Rate": item.price,
      "Discount": 0,
      "BatchNo": "",
      "KitchenNote": item.description || "",
      "KotStatus": 0,
      "KotOrderTime": formattedDate,
      "TypeCaption": item.name,
      "LocId": process.env.IPOS_LOCATION_ID || 2,
      "ActualRate": item.price,
      "SeatNo": 1,
      "KitchenNotes": [],
      "TaxDetails": [],
      "DiscountCode": "",
      "PrinterName": "80 Printer" // Default printer, can be configured
    };
  });

  // Create payment list
  const paymentList = [
    {
      "PaymentId": 9, // WhatsApp payment identifier
      "PaymentType": "WhatsApp",
      "Name": "WhatsApp Order",
      "Description": `Order from WhatsApp: ${waId}`,
      "ReferenceNo": `WA-${now.getTime()}`,
      "Amount": totalAmount + roundedVatAmount
    }
  ];

  // Create the full order object
  return {
    "InvNo": 0,
    "InvDate": formattedDate,
    "InvTime": formattedDate,
    "CounterId": 25, // Default counter ID, can be configured
    "CashierId": 1,
    "CounterOpId": 0,
    "TotAmount": totalAmount + roundedVatAmount,
    "TotCash": 0,
    "TotCredit": 0,
    "TotCreditCard": 0,
    "CreditCardNo": "",
    "TotAltCurrency": 0,
    "AltCurrencyId": 0,
    "TransNo": 0,
    "Discount": 0,
    "ConvRate": 0,
    "AmountReceived": totalAmount + roundedVatAmount,
    "ExchangeRate": 0,
    "HoldFlag": false,
    "SalesType": true,
    "CustomerId": 0,
    "ResetNo": 0,
    "Balance": 0,
    "DayOpenId": 0,
    "TotalCredit": 0,
    "CustomerCode": 0,
    "TotalGiftVoucher": 0,
    "GiftVoucherNo": "",
    "NationalityCode": 1,
    "TableNo": 1,
    "TakeAway": 1,
    "Delivery": 1, // Mark as delivery order for WhatsApp
    "Name": `WhatsApp Order: ${orderReference}`,
    "Address": "",
    "PhoneNo": waId,
    "Merged": 0,
    "Split": 0,
    "CupType": 0,
    "Company": "",
    "IdNo": "",
    "PAX": 1,
    "TableSubNo": 0,
    "AirmilesCardNo": "",
    "TotOnlinePayment": totalAmount + roundedVatAmount,
    "ProviderId": 0,
    "Status": 0,
    "VatAmt": roundedVatAmount,
    "LocId": process.env.IPOS_LOCATION_ID || 2,
    "RoomType": 3,
    "TicketNo": "",
    "DeliveryCharges": 0,
    "PaymentMode": 0,
    "AreaId": 0,
    "AddressId": 0,
    "Source": `WhatsApp-${orderReference}`,
    "TotPayLater": 0,
    "TotSecurityDeposit": 0,
    "DeliveryDate": "",
    "ReminderBefore": 0,
    "SalesDetails": salesDetails,
    "PaymentList": paymentList
  };
}

// Process Order to iPOS
async function processOrderToiPOS(order, waId, orderReference) {
  try {
    logger.info(`Processing order ${orderReference} from ${waId} to iPOS system`);

    // Calculate total order amount for logging
    const totalAmount = order.product_items.reduce((total, item) => {
      return total + (item.price * item.quantity);
    }, 0);

    logger.info(`Order ${orderReference} total: ${totalAmount} ${order.product_items[0].currency}`);

    // Log order details with order reference
    logger.debug(`Order ${orderReference} details:`, {
      orderReference,
      waId,
      products: order.product_items.map(item => ({
        id: item.product_retailer_id,
        name: item.name,
        quantity: item.quantity,
        price: item.price
      }))
    });

    // Step 1: Authenticate with iPOS API
    const token = await authenticateWithIPOS();

    // Step 2: Format the order for iPOS
    const formattedOrder = formatOrderForIPOS(order, waId, orderReference);
    logger.debug('Formatted order for iPOS:', { formattedOrder });

    // Step 3: Submit the order to iPOS
    const response = await axios({
      method: 'POST',
      url: `${process.env.IPOS_API_URL}/services/api/rest/v1/Save_Sales`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      data: formattedOrder
    });

    // Step 4: Process the response and handle success
    if (response.data && response.data.Success) {
      const invoiceNumber = response.data.data.InvNo;
      logger.info(`Order successfully submitted to iPOS. Invoice number: ${invoiceNumber}`);

      // Save the invoice data for reference
      const invoiceData = response.data.data;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `invoice-${invoiceNumber}-${timestamp}.json`;

      fs.writeFileSync(
        path.join(dataDir, filename),
        JSON.stringify(invoiceData, null, 2)
      );

      logger.debug(`Saved invoice data to ${filename}`);

      // Step 5 (optional): Send invoice for printing if needed
      // This would involve calling the text print and print endpoints
      // For now, we'll just return the invoice information

      return {
        success: true,
        invoiceNumber: invoiceNumber,
        invoiceData: invoiceData
      };
    } else {
      // Handle unsuccessful response
      logger.error('Failed to submit order to iPOS:', response.data);
      return {
        success: false,
        error: 'Failed to submit order to iPOS',
        details: response.data
      };
    }
  } catch (error) {
    // Detailed error logging
    if (error.response) {
      // The server responded with a status code outside the 2xx range
      logger.error('Error from iPOS API:', {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else if (error.request) {
      // The request was made but no response was received
      logger.error('No response received from iPOS API:', error.request);
    } else {
      // Something happened in setting up the request
      logger.error('Error setting up iPOS API request:', error.message);
    }

    return {
      success: false,
      error: error.message
    };
  }
}

// Send Order Confirmation
async function sendOrderConfirmation(order, waId, orderResult = null, orderReference = null) {
  try {
    // Generate order summary
    const orderItems = order.product_items.map(item =>
      `• ${item.name} x${item.quantity} - ${item.price} ${item.currency}`
    ).join('\n');

    const totalAmount = order.product_items.reduce((total, item) => {
      return total + (item.price * item.quantity);
    }, 0);

    // Calculate VAT amount (5% in UAE)
    const vatRate = 0.05;
    const vatAmount = totalAmount * vatRate;
    const roundedVatAmount = Math.round(vatAmount * 100) / 100;
    const grandTotal = totalAmount + roundedVatAmount;

    let message = '';

    // Format the message based on order result
    if (orderResult && orderResult.success) {
      // Order was successfully processed in iPOS
      const invoiceNumber = orderResult.invoiceNumber;
      const estimatedTime = 20; // minutes - can be configured or calculated

      message = `🎉 *Order Confirmed!* 🎉\n\n` +
        `Thank you for your order! We've received it and it's being prepared.\n\n` +
        `*Order Reference:* ${orderReference}\n` +
        `*Invoice Number:* #${invoiceNumber}\n` +
        `*Estimated Time:* ${estimatedTime} minutes\n\n` +
        `*Your Order:*\n${orderItems}\n\n` +
        `*Subtotal:* ${totalAmount.toFixed(2)} ${order.product_items[0].currency}\n` +
        `*VAT (5%):* ${roundedVatAmount.toFixed(2)} ${order.product_items[0].currency}\n` +
        `*Total:* ${grandTotal.toFixed(2)} ${order.product_items[0].currency}\n\n` +
        `We'll notify you when your order is ready. Thank you for choosing us!`;
    } else {
      // Order processing failed or no result available
      message = `🛍️ *Order Received* 🛍️\n\n` +
        `Thank you for your order! We've received it and it will be processed shortly.\n\n` +
        `*Order Reference:* ${orderReference}\n\n` +
        `*Your Order:*\n${orderItems}\n\n` +
        `*Subtotal:* ${totalAmount.toFixed(2)} ${order.product_items[0].currency}\n` +
        `*VAT (5%):* ${roundedVatAmount.toFixed(2)} ${order.product_items[0].currency}\n` +
        `*Total:* ${grandTotal.toFixed(2)} ${order.product_items[0].currency}\n\n` +
        `Our team will contact you shortly to confirm your order details.`;

      // If there's a specific error that's safe to share with customer
      if (orderResult && orderResult.error) {
        logger.debug('Order processing error:', orderResult.error);
      }
    }

    // Send message using WhatsApp API
    logger.info(`Sending order confirmation for ${orderReference} to ${waId}`);
    sendWhatsAppMessage(waId, message);

    // Send follow-up message with additional information after a short delay
    setTimeout(() => {
      const followUpMessage = "If you have any questions about your order, " +
        "please reply to this message and our team will assist you.";

      sendWhatsAppMessage(waId, followUpMessage);
    }, 2000); // 2-second delay between messages

  } catch (error) {
    logger.error('Error sending order confirmation:', error);

    // Try to send a basic confirmation if the formatted message fails
    try {
      sendWhatsAppMessage(waId, "Thank you for your order! We've received it and will process it shortly.");
    } catch (secondError) {
      logger.error('Failed to send fallback order confirmation:', secondError);
    }
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