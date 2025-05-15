require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const logger = require('./logger');
const eventLogger = require('./event-logger');
const fs = require('fs');
const path = require('path');
const iposService = require('./simple-ipos');
const productMapper = require('./product-mapper');
const admin = require('firebase-admin');
const cors = require('cors');

// Initialize Firebase Admin SDK
let db; // Define db in wider scope to access across functions

try {
  // Check if service account key is provided via environment variable
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountPath) {
    // Initialize with service account file if path is provided
    admin.initializeApp({
      credential: admin.credential.cert(require(serviceAccountPath))
    });
    logger.info('Firebase initialized with service account file');
  } else {
    // Try to initialize with application default credentials
    admin.initializeApp();
    logger.info('Firebase initialized with application default credentials');
  }

  // Get Firestore instance
  db = admin.firestore();
  logger.info('Firestore initialized successfully');
} catch (error) {
  logger.error('Firebase initialization error:', error);
}

// Helper function to save message to Firestore
async function saveMessageToFirestore(message, waId, profileName = 'Unknown') {
  if (!db) {
    logger.error('Cannot save message to Firestore: Firebase not initialized');
    return;
  }

  try {
    // Prepare message data for Firestore
    const messageData = {
      from: waId,
      timestamp: admin.firestore.Timestamp.now(),
      messageId: message.id,
      type: message.type,
      senderName: profileName,
      // Store message content based on type
      text: message.type === 'text' ? message.text?.body || '' : '',
      // Store raw data for reference
      rawData: message
    };

    // Add to Firestore messages collection
    const result = await db.collection('messages').add(messageData);
    logger.info(`Message from ${waId} saved to Firestore with ID: ${result.id}`);

    // Update contact's last message time
    await updateContactInFirestore(waId, profileName);

    return result.id;
  } catch (error) {
    logger.error('Error saving message to Firestore:', error);
  }
}

// Helper function to update contact in Firestore
async function updateContactInFirestore(waId, profileName = 'Unknown') {
  if (!db) {
    logger.error('Cannot update contact in Firestore: Firebase not initialized');
    return;
  }

  try {
    // Calculate 24-hour window information
    const now = admin.firestore.Timestamp.now();

    // Save/update contact in Firestore
    await db.collection('contacts').doc(waId).set({
      phoneNumber: waId,
      profileName: profileName !== 'Unknown' ? profileName : '',
      lastMessageTime: now
    }, { merge: true });

    logger.info(`Contact ${waId} updated in Firestore`);
  } catch (error) {
    logger.error('Error updating contact in Firestore:', error);
  }
}

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

// Enable CORS for the API (especially important for the dashboard)
app.use(cors({
  origin: process.env.CORS_ALLOW_ORIGIN || '*', // Allow all origins by default or specify in .env
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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
  
  // Log the webhook event with the regular logger (basic info only)
  logger.logWebhookEvent(body);

  // Save detailed event data to Firebase first, with file storage as fallback
  eventLogger.logWebhookEvent(body, req.headers)
    .catch(error => logger.error('Error in event logging workflow:', error));

  // Store critical webhook payloads to disk only if Firebase is unavailable and event logging is disabled
  if (process.env.ENABLE_FULL_EVENT_LOGGING !== 'true' && process.env.FIREBASE_FALLBACK === 'true') {
    // Only store critical events like orders
    const isOrderEvent = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.type === 'order' ||
                         body.entry?.[0]?.changes?.[0]?.value?.shopping?.order !== undefined;

    if (isOrderEvent) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `order-${timestamp}.json`;
      fs.writeFileSync(
        path.join(dataDir, filename),
        JSON.stringify(body, null, 2)
      );
      logger.debug(`Stored order payload in ${filename} (Firebase unavailable)`);
    }
  }

  // Check if this is a WhatsApp Business Account Message
  if (body.object) {
    // Check for message status updates
    if (body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0] &&
        body.entry[0].changes[0].value &&
        body.entry[0].changes[0].value.statuses) {

      const statuses = body.entry[0].changes[0].value.statuses;

      // Process each status update
      Promise.all(statuses.map(status => processMessageStatus(status)))
        .catch(error => {
          logger.error('Error processing message statuses:', error);
        });
    }
    // Check for incoming messages
    else if (body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0] &&
        body.entry[0].changes[0].value &&
        body.entry[0].changes[0].value.messages) {

      const messages = body.entry[0].changes[0].value.messages;
      const waId = body.entry[0].changes[0].value.contacts[0].wa_id;
      const metadata = body.entry[0].changes[0].value.metadata;

      // Extract user profile name if available
      let profileName = 'Unknown';
      if (body.entry[0].changes[0].value.contacts &&
          body.entry[0].changes[0].value.contacts[0].profile &&
          body.entry[0].changes[0].value.contacts[0].profile.name) {
        profileName = body.entry[0].changes[0].value.contacts[0].profile.name;
      }

      logger.info(`Received ${messages.length} message(s) from ${profileName} (${waId})`, { metadata });

      // Process each message (need to handle async for orders)
      // Use Promise.all to process messages in parallel
      Promise.all(messages.map(message => processMessage(message, waId, profileName)))
        .catch(error => {
          logger.error('Error processing messages:', error);
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
      // Extract profile name for shopping events
  let profileName = 'Unknown';
  if (body.entry[0].changes[0].value.contacts &&
      body.entry[0].changes[0].value.contacts[0].profile &&
      body.entry[0].changes[0].value.contacts[0].profile.name) {
    profileName = body.entry[0].changes[0].value.contacts[0].profile.name;
  }

  processShoppingEvent(shoppingData, waId, metadata, profileName);
    } else {
      // Log other event types
      logger.debug('Received other webhook event type', { body });
    }
  }
});

/**
 * Process Message Status Updates
 *
 * This function handles status updates from WhatsApp for sent messages.
 * WhatsApp will send status updates (sent, delivered, read) for each message,
 * and this function processes those updates and stores them in Firestore.
 *
 * The status flow is typically:
 * 1. Message is sent by our system -> status "sent"
 * 2. Message is delivered to recipient's device -> status "delivered"
 * 3. Message is read by the recipient -> status "read"
 *
 * We use a priority system to ensure that statuses only move forward
 * (e.g., a "read" message doesn't go back to "delivered").
 *
 * The UI reads these status updates to display read receipts and delivery confirmations.
 */
async function processMessageStatus(status) {
  try {
    // Extract status information
    const messageId = status.id;
    const statusType = status.status; // sent, delivered, read, etc.
    const timestamp = status.timestamp ? new Date(parseInt(status.timestamp) * 1000) : new Date();
    const recipientId = status.recipient_id;

    logger.info(`Processing message status update: ${statusType} for message ${messageId} to ${recipientId}`);

    // Skip processing if Firestore is not initialized
    if (!db) {
      logger.warn('Skipping status update: Firestore not initialized');
      return;
    }

    // Find the message in Firestore
    const messagesRef = db.collection('messages');
    const query = messagesRef.where('messageId', '==', messageId);
    const snapshot = await query.get();

    if (snapshot.empty) {
      logger.warn(`No message found with ID ${messageId} for status update`);
      return;
    }

    // Update status in all matching messages (should typically be just one)
    const batch = db.batch();

    snapshot.forEach(doc => {
      const messageData = doc.data();

      // Only update if this is a newer status than what's recorded
      const currentStatusPriority = getStatusPriority(messageData.status || 'unknown');
      const newStatusPriority = getStatusPriority(statusType);

      if (newStatusPriority > currentStatusPriority) {
        logger.debug(`Updating message ${messageId} status from ${messageData.status || 'unknown'} to ${statusType}`);

        batch.update(doc.ref, {
          status: statusType,
          statusTimestamp: admin.firestore.Timestamp.fromDate(timestamp),
          statusDetails: status
        });
      }
    });

    // Commit the batch update
    await batch.commit();
    logger.debug(`Status update for message ${messageId} completed`);
  } catch (error) {
    logger.error('Error processing message status:', error);
  }
}

// Helper function to determine status priority
function getStatusPriority(status) {
  const priorities = {
    'unknown': 0,
    'queued': 1,
    'sent': 2,
    'delivered': 3,
    'read': 4,
    'failed': 5
  };

  return priorities[status.toLowerCase()] || 0;
}

// Process Message Handler
async function processMessage(message, waId, profileName = 'Unknown') {
  const messageType = message.type;

  // Get profile name from the message context if not provided
  if (profileName === 'Unknown' && message.context && message.context.from) {
    profileName = message.context.from;
  }

  // Save message to Firestore for dashboard display
  try {
    await saveMessageToFirestore(message, waId, profileName);
  } catch (error) {
    logger.error('Error saving message to Firestore in process handler:', error);
  }

  // Process message based on type
  if (messageType === 'order') {
    // Special handling for order messages
    logger.info(`Order message from ${profileName} (${waId}):`, {
      orderId: message.id,
      timestamp: message.timestamp
    });

    const order = message.order;
    // Log order details
    const orderReference = logger.logOrder(order, waId);

    try {
      // Process the order using the iPOS service - pass the profile name to iPOS
      logger.info(`Processing order ${orderReference} from message handler...`);
      const orderResult = await iposService.processOrderToiPOS(order, waId, orderReference, profileName);

      // Send order confirmation message with the result info
      sendOrderConfirmation(order, waId, orderResult, orderReference, profileName);
    } catch (error) {
      logger.error(`Error processing order workflow for ${orderReference}:`, error);

      // Send a basic confirmation even if processing failed
      sendOrderConfirmation(order, waId, { success: false, error: error.message }, orderReference, profileName);
    }
  } else {
    // Handle all non-order message types with appropriate messages and catalog

    // Log the message based on type
    if (messageType === 'text') {
      logger.info(`Text message from ${profileName} (${waId}):`, {
        text: message.text.body,
        messageId: message.id,
        timestamp: message.timestamp
      });

      const messageText = message.text.body.toLowerCase();

      // Check for common keywords related to ordering
      if (messageText.includes('menu') ||
          messageText.includes('order') ||
          messageText.includes('food') ||
          messageText.includes('catalog') ||
          messageText.includes('products')) {
        // For menu or ordering keywords, send catalog message directly
        sendCatalogMessage(waId);
      } else {
        // For all other text messages, send welcome + catalog
        sendWelcomeMessage(waId, profileName);

        // Send catalog after a short delay
        setTimeout(() => {
          sendCatalogMessage(waId);
        }, 2000);
      }
    } else if (messageType === 'interactive') {
      logger.info(`Interactive message from ${profileName} (${waId}):`, {
        interactiveType: message.interactive.type,
        messageId: message.id,
        timestamp: message.timestamp
      });

      // For interactive messages, send catalog after handling the specific type

      if (message.interactive.type === 'button_reply') {
        // Handle button replies
        const buttonId = message.interactive.button_reply.id;
        const buttonText = message.interactive.button_reply.title;
        logger.info(`Button reply from ${waId}:`, { buttonId, buttonText });
      } else if (message.interactive.type === 'list_reply') {
        // Handle list selections
        const listId = message.interactive.list_reply.id;
        const listTitle = message.interactive.list_reply.title;
        logger.info(`List selection from ${waId}:`, { listId, listTitle });
      }

      // For all interactive messages, send catalog after a short delay
      setTimeout(() => {
        sendCatalogMessage(waId);
      }, 1500);

    } else if (messageType === 'location') {
      // Process location messages
      logger.info(`Location received from ${profileName} (${waId}):`, {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
        name: message.location.name || 'Unknown location',
        address: message.location.address || 'No address provided'
      });

      // Send a response acknowledging receipt of location
      const response = `Thank you for sharing your location!\n\nWould you like to see our menu and place an order?`;
      await sendWhatsAppMessage(waId, response);

      // Send catalog after a short delay
      setTimeout(() => {
        sendCatalogMessage(waId);
      }, 2000);
    } else if (messageType === 'image' || messageType === 'video' || messageType === 'document') {
      // Handle media messages
      logger.info(`Media message (${messageType}) received from ${profileName} (${waId}):`, {
        mediaId: message[messageType].id,
        mimeType: message[messageType].mime_type || 'unknown'
      });

      // Send a friendly response
      const response = `Thanks for the ${messageType}! If you'd like to place an order, please check our menu.`;
      await sendWhatsAppMessage(waId, response);

      // Send catalog after a short delay
      setTimeout(() => {
        sendCatalogMessage(waId);
      }, 2000);
    } else {
      // Handle any other message type
      logger.info(`Unspecified message type (${messageType}) from ${profileName} (${waId})`);

      // For unrecognized message types, send a general response
      const response = `Thanks for your message! Would you like to see our menu and place an order?`;
      await sendWhatsAppMessage(waId, response);

      // Send catalog after a short delay
      setTimeout(() => {
        sendCatalogMessage(waId);
      }, 2000);
    }
  }
}

// Process Shopping Event Handler
async function processShoppingEvent(shopping, waId, metadata, profileName = 'Unknown') {
  const shoppingEventType = Object.keys(shopping)[0]; // can be 'catalog_message', 'product_inquiry', 'order'

  logger.info(`Processing ${shoppingEventType} from ${profileName} (${waId})`);

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
      // Process the order and get the result - pass the order reference and profile name for tracking
      const orderResult = await iposService.processOrderToiPOS(order, waId, orderReference, profileName);

      // Send order confirmation message with the result info
      sendOrderConfirmation(order, waId, orderResult, orderReference, profileName);
    } catch (error) {
      logger.error(`Error processing order workflow for ${orderReference}:`, error);

      // Send a basic confirmation even if processing failed
      sendOrderConfirmation(order, waId, { success: false, error: error.message }, orderReference, profileName);
    }
  }
}

// Authenticate with iPOS API
async function authenticateWithIPOS() {
  try {
    logger.info('Authenticating with iPOS API');

    const requestStartTime = Date.now();

    const response = await axios({
      method: 'POST',
      url: `${process.env.IPOS_API_URL}/Token`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `username=${process.env.IPOS_USERNAME}&password=${process.env.IPOS_PASSWORD}&grant_type=password`
    });

    const requestDuration = Date.now() - requestStartTime;

    if (response.data && response.data.access_token) {
      logger.info(`Successfully authenticated with iPOS API in ${requestDuration}ms`);

      // Log successful authentication
      const authLogEntry = {
        timestamp: new Date().toISOString(),
        event: 'AUTH_SUCCESS',
        duration: requestDuration,
        expiresAt: response.data['.expires'],
        username: response.data.userName
      };

      // Save authentication log entry
      const authLogFilename = 'ipos-auth.log';
      fs.appendFileSync(
        path.join(dataDir, authLogFilename),
        JSON.stringify(authLogEntry) + '\n'
      );

      return response.data.access_token;
    } else {
      throw new Error('Invalid authentication response from iPOS API');
    }
  } catch (error) {
    const errorDetails = error.response?.data || { error: error.message };
    logger.error('Error authenticating with iPOS API:', errorDetails);

    // Log authentication failure
    const authLogEntry = {
      timestamp: new Date().toISOString(),
      event: 'AUTH_FAILURE',
      error: error.message,
      errorDetails: error.response?.data || {},
      status: error.response?.status || 'NETWORK_ERROR'
    };

    // Save authentication log entry
    const authLogFilename = 'ipos-auth.log';
    fs.appendFileSync(
      path.join(dataDir, authLogFilename),
      JSON.stringify(authLogEntry) + '\n'
    );

    // Create an error file for detailed debugging
    const errorFilename = `auth-error-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(dataDir, errorFilename),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code,
          response: error.response ? {
            status: error.response.status,
            data: error.response.data,
            headers: error.response.headers
          } : null
        }
      }, null, 2)
    );

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
    "Name": `${orderReference}`,
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
      const invoiceNumber = response.data.data;
      logger.info(`Order ${orderReference} successfully submitted to iPOS. Invoice number: ${invoiceNumber}`);

      // Save the invoice data for reference
      const invoiceData = response.data;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `invoice-${invoiceNumber}-${orderReference}-${timestamp}.json`;

      fs.writeFileSync(
        path.join(dataDir, filename),
        JSON.stringify(invoiceData, null, 2)
      );

      logger.debug(`Saved invoice data to ${filename}`);

      // Create a separate iPOS transaction log for easier tracking
      const txLogEntry = {
        timestamp: new Date().toISOString(),
        orderReference,
        waId,
        invoiceNumber,
        totalAmount: totalAmount,
        vatAmount: roundedVatAmount,
        grandTotal: totalAmount + roundedVatAmount,
        currency: order.product_items[0].currency,
        items: order.product_items.length,
        success: true
      };

      // Save transaction log entry in a dedicated file with append mode
      const txLogFilename = 'ipos-transactions.log';
      fs.appendFileSync(
        path.join(dataDir, txLogFilename),
        JSON.stringify(txLogEntry) + '\n'
      );

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
      logger.error(`Order ${orderReference} failed to submit to iPOS:`, response.data);

      // Log the failure in the transaction log
      const txLogEntry = {
        timestamp: new Date().toISOString(),
        orderReference,
        waId,
        success: false,
        errorMessage: response.data?.message || 'Failed to submit order to iPOS',
        totalAmount: totalAmount,
        currency: order.product_items[0].currency
      };

      // Save transaction log entry in a dedicated file with append mode
      const txLogFilename = 'ipos-transactions.log';
      fs.appendFileSync(
        path.join(dataDir, txLogFilename),
        JSON.stringify(txLogEntry) + '\n'
      );

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
      logger.error(`Error from iPOS API for order ${orderReference}:`, {
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers
      });
    } else if (error.request) {
      // The request was made but no response was received
      logger.error(`No response received from iPOS API for order ${orderReference}:`, error.request);
    } else {
      // Something happened in setting up the request
      logger.error(`Error setting up iPOS API request for order ${orderReference}:`, error.message);
    }

    // Log the failure in the transaction log
    const errorType = error.response ? 'API_ERROR' :
                     error.request ? 'CONNECTION_ERROR' : 'REQUEST_SETUP_ERROR';

    const txLogEntry = {
      timestamp: new Date().toISOString(),
      orderReference,
      waId,
      success: false,
      errorType,
      errorMessage: error.message,
      errorCode: error.response?.status || 'UNKNOWN',
      totalAmount: totalAmount
    };

    // Save transaction log entry in a dedicated file with append mode
    const txLogFilename = 'ipos-transactions.log';
    fs.appendFileSync(
      path.join(dataDir, txLogFilename),
      JSON.stringify(txLogEntry) + '\n'
    );

    // Save raw error data for debugging
    const errorFilename = `error-${orderReference}-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(dataDir, errorFilename),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orderReference,
        waId,
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code,
          response: error.response ? {
            status: error.response.status,
            data: error.response.data,
            headers: error.response.headers
          } : null,
          request: error.request ? {
            method: 'POST',
            url: `${process.env.IPOS_API_URL}/services/api/rest/v1/Save_Sales`
          } : null
        }
      }, null, 2)
    );

    return {
      success: false,
      error: error.message
    };
  }
}

// Send Order Confirmation
async function sendOrderConfirmation(order, waId, orderResult = null, orderReference = null, customerName = '') {
  try {
    // Generate order summary with proper product names from catalog
    const orderItems = order.product_items.map(item => {
      const price = item.price || item.item_price || 0;

      // Get product name from catalog if available, otherwise use item.name or fallback
      const productId = item.product_retailer_id;
      let name;

      if (productMapper.isProductCatalogLoaded()) {
        // Use catalog mapping when available
        name = productMapper.getProductName(productId, item.name);
      } else {
        // Fallback to item name or generic format
        name = item.name || `Item ${productId}`;
      }

      return `• ${name} x${item.quantity} - ${price} ${item.currency}`;
    }).join('\n');

    const totalAmount = order.product_items.reduce((total, item) => {
      const price = item.price || item.item_price || 0;
      return total + (price * item.quantity);
    }, 0);

    // Calculate VAT amount (5% in UAE)
    const vatRate = 0.05;
    const vatAmount = totalAmount * vatRate;
    const roundedVatAmount = Math.round(vatAmount * 100) / 100;
    const grandTotal = totalAmount + roundedVatAmount;

    // Personalize greeting if customer name is available
    const personalization = customerName ? `Dear ${customerName},\n\n` : '';
    let message = '';

    // Format the message based on order result
    if (orderResult && orderResult.success) {
      // Order was successfully processed in iPOS
      const invoiceNumber = orderResult.invoiceNumber;
      const estimatedTime = 20; // minutes - can be configured or calculated

      message = `🎉 *Order Confirmed!* 🎉\n\n${personalization}` +
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

/**
 * Send WhatsApp Message Helper
 *
 * Sends a message to a WhatsApp user with support for different message types:
 * - Text messages (default)
 * - Template messages (pre-approved templates)
 * - Interactive messages (buttons, lists, etc.)
 *
 * The function handles errors gracefully and logs information about the message
 * sending process. It also saves outbound messages to Firestore for tracking.
 *
 * @param {string} to - The WhatsApp phone number to send the message to
 * @param {string} message - The message text (for text messages)
 * @param {object} options - Additional options for the message
 * @param {string} [options.type] - Message type: 'text', 'template', or 'interactive'
 * @param {object} [options.template] - Template configuration for template messages
 * @param {object} [options.interactive] - Interactive message configuration
 * @param {boolean} [options.preview_url] - Whether to generate URL previews in text messages
 * @param {string} [options.context_message_id] - Message ID to reply to
 * @returns {Promise<object>} - The WhatsApp API response data
 */
async function sendWhatsAppMessage(to, message, options = {}) {
  try {
    // Validate phone number format (should contain only digits)
    if (!to || !to.match(/^\d+$/)) {
      throw new Error(`Invalid phone number format: ${to}`);
    }

    // For text messages, validate message content
    if (!options.type || options.type === 'text') {
      if (!message || typeof message !== 'string') {
        throw new Error('Message text is required for text messages');
      }
    }

    logger.debug(`Sending WhatsApp message to ${to}`, {
      messageType: options.type || 'text',
      messageLength: message ? message.length : 0,
      hasTemplate: !!options.template,
      hasInteractive: !!options.interactive,
      isReply: !!options.context_message_id
    });

    // Prepare the message payload based on message type
    let messageData = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to
    };

    // Handle different message types
    if (options.type === 'template' && options.template) {
      // Template message
      messageData.type = 'template';
      messageData.template = options.template;
    } else if (options.type === 'interactive' && options.interactive) {
      // Interactive message
      messageData.type = 'interactive';
      messageData.interactive = options.interactive;
    } else {
      // Default to text message
      messageData.type = 'text';
      messageData.text = {
        body: message,
        preview_url: options.preview_url === true
      };
    }

    // Add optional context for replies
    if (options.context_message_id) {
      messageData.context = {
        message_id: options.context_message_id
      };
    }

    // Make the API request with timeout and retry options
    const response = await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      data: messageData,
      timeout: 10000, // 10 second timeout
      validateStatus: status => status >= 200 && status < 300 // Only accept success status codes
    });

    // Extract message ID for better tracking
    const messageId = response.data.messages?.[0]?.id;

    // Save sent message to Firestore if Firebase is initialized
    if (db) {
      try {
        // Calculate a display text for non-text messages
        let displayText = '';
        if (messageData.type === 'text') {
          displayText = message;
        } else if (messageData.type === 'template') {
          displayText = `[Template: ${options.template?.name || 'unknown'}]`;
        } else if (messageData.type === 'interactive') {
          displayText = `[Interactive: ${options.interactive?.type || 'unknown'}]`;
        }

        const sentMessageData = {
          from: process.env.WHATSAPP_PHONE_NUMBER_ID || 'bot',
          to: to,
          timestamp: admin.firestore.Timestamp.now(),
          messageId: messageId,
          type: messageData.type,
          text: displayText,
          rawData: {
            ...messageData,
            response: response.data
          },
          direction: 'outbound',
          status: 'sent'
        };

        await db.collection('messages').add(sentMessageData);
        logger.debug('Sent message saved to Firestore', { messageId });
      } catch (firestoreErr) {
        // Log but don't fail the overall function if Firestore save fails
        logger.error('Error saving sent message to Firestore:', firestoreErr.message);
      }
    }

    logger.info('Message sent successfully', {
      recipient: to,
      messageId: messageId,
      messageType: messageData.type
    });

    return response.data;
  } catch (error) {
    // Enhanced error logging with more details about the attempted message
    const errorDetails = {
      recipient: to,
      messageType: options.type || 'text',
      errorCode: error.response?.status,
      errorMessage: error.response?.data?.error?.message || error.message,
      apiError: error.response?.data?.error
    };

    logger.error('Error sending WhatsApp message:', errorDetails);

    // For API errors, log the full response data for debugging
    if (error.response?.data) {
      logger.debug('WhatsApp API error details:', error.response.data);
    }

    throw error;
  }
}

/**
 * Send Catalog Message Helper
 *
 * Sends the product catalog to the specified WhatsApp number using a multi-level
 * fallback approach to maximize delivery success rate. The function tries multiple
 * methods in sequence until one succeeds:
 *
 * 1. Interactive button with catalog action
 * 2. Template-based catalog message
 * 3. Interactive catalog message
 * 4. Direct link to catalog URL
 * 5. Simple text message as final fallback
 *
 * @param {string} to - The WhatsApp phone number to send the catalog to
 * @returns {Promise<object>} - The API response data from the successful method
 */
async function sendCatalogMessage(to) {
  try {
    logger.debug(`Sending catalog message to ${to}`);

    // Initialize tracking for attempted methods
    const attemptedMethods = [];

    // Get catalog ID and thumbnail ID from environment or use defaults
    const catalogId = process.env.WHATSAPP_CATALOG_ID || '649587371247572';
    const thumbnailId = process.env.CATALOG_THUMBNAIL_ID || 'A001044';

    // Common API request configuration
    const apiConfig = {
      method: 'POST',
      url: `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    };

    // Method 1: Interactive button approach
    attemptedMethods.push('interactive_button');
    try {
      const response = await axios({
        ...apiConfig,
        data: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: {
              text: '🍽️ Check out our delicious menu! Tap the button below to browse and place your order.'
            },
            action: {
              buttons: [
                {
                  type: 'catalog',
                  name: 'catalog_button',
                  catalog_id: catalogId,
                  thumbnail_product_retailer_id: thumbnailId
                }
              ]
            }
          }
        }
      });

      logger.info('Interactive catalog button sent successfully', {
        recipient: to,
        messageId: response.data.messages?.[0]?.id
      });
      return response.data;

    } catch (buttonError) {
      // Log the error but continue to next approach
      logger.warn(`Method ${attemptedMethods[0]} failed:`,
        buttonError.response?.data?.error?.message || buttonError.message);

      // Method 2: Template-based approach
      attemptedMethods.push('template');
      try {
        const response = await axios({
          ...apiConfig,
          data: {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to,
            type: 'template',
            template: {
              name: 'catalog_display',
              language: {
                code: 'en_US'
              },
              components: [
                {
                  type: 'body',
                  parameters: [
                    {
                      type: 'text',
                      text: 'our delicious menu'
                    }
                  ]
                }
              ]
            }
          }
        });

        logger.info('Template catalog message sent successfully', {
          recipient: to,
          messageId: response.data.messages?.[0]?.id
        });
        return response.data;

      } catch (templateError) {
        // Log the error but continue to next approach
        logger.warn(`Method ${attemptedMethods[1]} failed:`,
          templateError.response?.data?.error?.message || templateError.message);

        // Method 3: Interactive catalog message approach
        attemptedMethods.push('catalog_message');
        try {
          const response = await axios({
            ...apiConfig,
            data: {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: to,
              type: 'interactive',
              interactive: {
                type: 'catalog_message',
                body: {
                  text: '🍽️ Browse our menu and place your order!'
                },
                action: {
                  name: 'catalog_message',
                  parameters: {
                    thumbnail_product_retailer_id: thumbnailId,
                    catalog_id: catalogId
                  }
                },
                footer: {
                  text: 'Tap to browse our delicious menu'
                }
              }
            }
          });

          logger.info('Interactive catalog message sent successfully', {
            recipient: to,
            messageId: response.data.messages?.[0]?.id
          });
          return response.data;

        } catch (interactiveError) {
          // Log the error but continue to next approach
          logger.warn(`Method ${attemptedMethods[2]} failed:`,
            interactiveError.response?.data?.error?.message || interactiveError.message);

          // Method 4: Direct catalog URL approach
          attemptedMethods.push('catalog_url');
          try {
            // Try direct catalog URL approach
            const catalogUrl = `https://wa.me/c/${process.env.WHATSAPP_PHONE_NUMBER_ID.replace(/\D/g, '')}`;
            const message = `🍽️ Check out our menu and place your order using this link: ${catalogUrl}`;

            const response = await sendWhatsAppMessage(to, message, {
              preview_url: true
            });

            logger.info('Catalog URL message sent successfully', {
              recipient: to,
              messageId: response.messages?.[0]?.id
            });
            return response;

          } catch (urlError) {
            // Log the error but continue to final fallback
            logger.warn(`Method ${attemptedMethods[3]} failed:`,
              urlError.message);

            // Method 5: Simple text fallback (last resort)
            attemptedMethods.push('simple_text');
            const fallbackMessage = 'Thank you for your message! You can browse our menu and place your order through WhatsApp. Just tap on the shopping icon in our chat.';

            const response = await sendWhatsAppMessage(to, fallbackMessage);
            logger.info('Simple fallback message sent successfully', {
              recipient: to,
              messageId: response.messages?.[0]?.id
            });
            return response;
          }
        }
      }
    }
  } catch (error) {
    // This catch block handles any unexpected errors in the main function flow
    logger.error('Critical error sending catalog (all methods failed):', error.message);

    // Create a simple fallback that doesn't rely on previous code
    try {
      // Absolute last resort fallback message
      const emergencyMessage = 'Thank you for your interest! Please contact us to place your order.';
      await axios({
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
            body: emergencyMessage
          }
        }
      });
      logger.info('Emergency fallback message sent');
    } catch (emergencyError) {
      logger.error('Emergency fallback message also failed:', emergencyError.message);
    }

    // For tracking purposes, we'll still throw the original error
    throw error;
  }
}

// Send Welcome Message Helper
async function sendWelcomeMessage(to, customerName = '') {
  try {
    // Try to use a template for better deliverability
    try {
      // Use customer name if available, otherwise last 4 digits of phone number
      const nameParam = customerName || to.substring(to.length - 4);

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
          type: 'template',
          template: {
            name: 'welcome_message',
            language: {
              code: 'en_US'
            },
            components: [
              {
                type: 'body',
                parameters: [
                  {
                    type: 'text',
                    text: nameParam
                  }
                ]
              }
            ]
          }
        }
      });

      logger.info('Template welcome message sent successfully', {
        recipient: to,
        messageId: response.data.messages?.[0]?.id
      });

    } catch (templateError) {
      // If template fails, send a plain text welcome message
      logger.warn('Template welcome message failed, sending plain text:',
        templateError.response?.data?.error?.message || templateError.message);

      const welcomeMessage = `👋 Welcome to our self-checkout service!\n\nYou can place an order directly through WhatsApp. Our menu is available in our catalog.\n\nType "menu" to see our food options, or simply tap the catalog button in our chat.`;

      logger.debug(`Sending plain welcome message to ${to}`);
      await sendWhatsAppMessage(to, welcomeMessage);
    }

    // Send catalog message after a short delay
    setTimeout(async () => {
      try {
        await sendCatalogMessage(to);
      } catch (error) {
        logger.error('Error sending delayed catalog message:', error.message);
      }
    }, 2000);

  } catch (error) {
    logger.error('Error sending welcome message:', error.message);
  }
}

// Event log viewer endpoint - for debugging use only in non-production environments
app.get('/events', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Forbidden in production environment' });
  }

  try {
    const eventId = req.query.id;
    const limit = parseInt(req.query.limit || '50', 10);

    // Read events (now an async function that supports Firebase)
    const events = await eventLogger.readEvents(eventId, limit);
    res.json(events);
  } catch (error) {
    logger.error('Error fetching events:', error);
    res.status(500).json({
      error: 'Error fetching events',
      message: error.message,
      source: error.source || 'unknown'
    });
  }
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

// API health check endpoint for the frontend to test connectivity
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    apiVersion: '1.0',
    features: {
      messaging: true,
      fileAttachments: false
    },
    timestamp: new Date().toISOString()
  });
});

// API endpoint for sending message replies
// API endpoint to clear chats for a contact
app.delete('/api/messages/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    if (!db) {
      return res.status(500).json({
        success: false,
        error: 'Firebase not initialized'
      });
    }

    logger.info(`Clearing messages for ${phoneNumber}`);

    // Find all messages for this contact
    const messagesRef = db.collection('messages');
    const snapshot = await messagesRef
      .where('from', '==', phoneNumber)
      .get();

    const outboundSnapshot = await messagesRef
      .where('to', '==', phoneNumber)
      .get();

    // Batch delete all matching messages
    const batch = db.batch();

    // Delete inbound messages
    snapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete outbound messages
    outboundSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Commit the batch
    await batch.commit();

    res.status(200).json({
      success: true,
      deletedCount: snapshot.size + outboundSnapshot.size
    });
  } catch (error) {
    logger.error('Error clearing messages:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// API endpoint to delete a contact
app.delete('/api/contacts/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Phone number is required'
      });
    }

    if (!db) {
      return res.status(500).json({
        success: false,
        error: 'Firebase not initialized'
      });
    }

    logger.info(`Deleting contact ${phoneNumber}`);

    // Delete the contact from Firestore
    await db.collection('contacts').doc(phoneNumber).delete();

    // Delete all messages for this contact as well
    // Find all messages for this contact
    const messagesRef = db.collection('messages');
    const snapshot = await messagesRef
      .where('from', '==', phoneNumber)
      .get();

    const outboundSnapshot = await messagesRef
      .where('to', '==', phoneNumber)
      .get();

    // Batch delete all matching messages
    const batch = db.batch();

    // Delete inbound messages
    snapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Delete outbound messages
    outboundSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    // Commit the batch
    await batch.commit();

    res.status(200).json({
      success: true,
      deletedMessages: snapshot.size + outboundSnapshot.size
    });
  } catch (error) {
    logger.error('Error deleting contact:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/send-message', async (req, res) => {
  try {
    // Log the request body for debugging
    logger.info('Received send-message request:', { body: req.body });

    // Check for required fields and handle different types of messages
    const { to, message, context_message_id, type, interactive, template } = req.body;

    if (!to) {
      logger.error('Missing required field: to');
      return res.status(400).json({
        success: false,
        error: 'Missing required field: to is required'
      });
    }

    // Check phone number format
    if (!to.match(/^\d+$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format. Only digits allowed.'
      });
    }

    // Prepare options for sending message
    const options = {};

    // Add message context if provided (for replies)
    if (context_message_id) {
      options.context_message_id = context_message_id;
    }

    // Add preview URL capability if specified
    if (req.body.preview_url === true) {
      options.preview_url = true;
    }

    // Handle interactive and template messages
    if (type && ['template', 'interactive'].includes(type)) {
      options.type = type;

      if (type === 'template' && template) {
        options.template = template;
      } else if (type === 'interactive' && interactive) {
        options.interactive = interactive;
      }
    }

    // For text messages, ensure we have content
    if (type !== 'interactive' && type !== 'template' && !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: message is required for text messages'
      });
    }

    // Send the message
    let result;

    if (type === 'interactive' && interactive) {
      // For interactive messages, we need special handling
      logger.info('Sending interactive message to', to, { interactive });

      // Prepare message payload
      const messageData = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: interactive
      };

      // Add context for replies if needed
      if (context_message_id) {
        messageData.context = {
          message_id: context_message_id
        };
      }

      // Make API call
      const response = await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v17.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        data: messageData
      });

      result = response.data;

      // Save to Firestore if initialized
      if (db) {
        try {
          const sentMessageData = {
            from: process.env.WHATSAPP_PHONE_NUMBER_ID || 'bot',
            to: to,
            timestamp: admin.firestore.Timestamp.now(),
            messageId: result.messages?.[0]?.id,
            type: 'interactive',
            text: '[Interactive message]',
            rawData: {
              ...messageData,
              response: result
            },
            direction: 'outbound',
            status: 'sent'
          };

          await db.collection('messages').add(sentMessageData);
        } catch (firestoreErr) {
          logger.error('Error saving interactive message to Firestore:', firestoreErr);
        }
      }
    } else {
      // For regular messages
      result = await sendWhatsAppMessage(to, message || '', options);
    }

    // Return success response
    res.status(200).json({
      success: true,
      message_id: result.messages?.[0]?.id,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Error handling send-message request:', error);

    // Return error response
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || {}
    });
  }
});

// Enhanced error handling
process.on('uncaughtException', (error) => {
  logger.error('CRITICAL - Uncaught exception:', error);

  // Create an error log file for critical errors
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const errorFile = `critical-error-${timestamp}.json`;
    fs.writeFileSync(
      path.join(dataDir, errorFile),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'UncaughtException',
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code
        }
      }, null, 2)
    );
    logger.info(`Error details saved to ${errorFile}`);
  } catch (logError) {
    logger.error('Failed to write error log:', logError);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('CRITICAL - Unhandled promise rejection at:', promise);

  // Create an error log file for critical errors
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const errorFile = `critical-rejection-${timestamp}.json`;
    fs.writeFileSync(
      path.join(dataDir, errorFile),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'UnhandledRejection',
        error: {
          message: reason?.message || 'Unknown reason',
          stack: reason?.stack,
          details: reason
        },
        promise: String(promise)
      }, null, 2)
    );
    logger.info(`Rejection details saved to ${errorFile}`);
  } catch (logError) {
    logger.error('Failed to write rejection log:', logError);
  }
});

// Function to clean up old data files
async function cleanupOldDataFiles() {
  try {
    logger.info('Running data cleanup routine...');

    // Get retention period (default 12 hours)
    const retentionHours = parseInt(process.env.DATA_RETENTION_HOURS || '12', 10);
    const retentionMs = retentionHours * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    // Check if the data directory exists
    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir);

      // Process each file
      files.forEach(file => {
        // Skip special files and directories
        if (file === '.gitkeep' || file === 'firebase-service-account.json' || !file.includes('.json')) {
          return;
        }

        const filePath = path.join(dataDir, file);
        const stats = fs.statSync(filePath);

        // Only delete if it's a file and older than retention period
        if (stats.isFile() && (now - stats.mtime.getTime() > retentionMs)) {
          try {
            fs.unlinkSync(filePath);
            deletedCount++;
          } catch (delError) {
            logger.error(`Error deleting old file ${file}:`, delError);
          }
        }
      });
    }

    if (deletedCount > 0) {
      logger.info(`Cleaned up ${deletedCount} old data files`);
    }

    // Schedule next cleanup (every 6 hours)
    setTimeout(cleanupOldDataFiles, 6 * 60 * 60 * 1000);
  } catch (error) {
    logger.error('Error during data cleanup:', error);
  }
}

// Start server
app.listen(PORT, async () => {
  logger.info(`WhatsApp Webhook server running on port ${PORT}`);
  logger.info(`Full event logging is ${eventLogger.isEventLoggingEnabled() ? 'enabled' : 'disabled'}`);
  logger.info(`Data retention period is set to ${process.env.DATA_RETENTION_HOURS || '12'} hours`);

  // Ensure the catalog file is available locally
  await productMapper.ensureLocalCatalogFile();

  // Load product catalog for name mapping
  try {
    await productMapper.loadProductCatalog();
    logger.info('Product catalog loaded successfully for name mapping');
  } catch (error) {
    logger.warn(`Failed to load product catalog: ${error.message}`);
  }

  // Run initial data cleanup
  cleanupOldDataFiles();
});