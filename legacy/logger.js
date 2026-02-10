const { createLogger, format, transports } = require('winston');
const { combine, timestamp, printf, colorize } = format;
require('winston-daily-rotate-file');
const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Define log format
const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let meta = '';
  if (Object.keys(metadata).length > 0) {
    // Limit large metadata objects to prevent excessive logging
    const cleanMetadata = {};
    Object.keys(metadata).forEach(key => {
      // Skip large objects or those that might cause circular references
      if (key === 'rawData' || key === 'headers' || key === 'response') {
        cleanMetadata[key] = '[Large object - not serialized]';
      } else if (typeof metadata[key] === 'object' && metadata[key] !== null) {
        try {
          // Try to serialize, but limit size
          const serialized = JSON.stringify(metadata[key]);
          cleanMetadata[key] = serialized.length > 1000 ?
            serialized.substring(0, 997) + '...' :
            metadata[key];
        } catch (e) {
          cleanMetadata[key] = '[Unserializable object]';
        }
      } else {
        cleanMetadata[key] = metadata[key];
      }
    });

    try {
      meta = JSON.stringify(cleanMetadata, null, 2);
    } catch (e) {
      meta = '{ "error": "Could not serialize metadata" }';
    }
  }

  return `${timestamp} [${level}]: ${message} ${meta}`;
});

// Get retention period from environment or default to 12h
const retentionHours = parseInt(process.env.LOG_RETENTION_HOURS || '12', 10);
const retentionPeriod = `${retentionHours}h`;

// Create daily rotate file transport - only if Firebase fails or for critical messages
const fileRotateTransport = new transports.DailyRotateFile({
  filename: path.join(logDir, 'whatsapp-webhook-%DATE%.log'),
  datePattern: 'YYYY-MM-DD-HH',
  maxFiles: retentionPeriod,
  maxSize: '10m',
  format: combine(
    timestamp(),
    logFormat
  )
});

// Create a separate transport for error logs - always active
const errorFileRotateTransport = new transports.DailyRotateFile({
  filename: path.join(logDir, 'whatsapp-webhook-error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD-HH',
  maxFiles: retentionPeriod,
  maxSize: '10m',
  level: 'error',
  format: combine(
    timestamp(),
    logFormat
  )
});

// Create console-only logger by default
const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: combine(
    timestamp(),
    logFormat
  ),
  transports: [
    new transports.Console({
      format: combine(
        colorize(),
        timestamp(),
        logFormat
      )
    })
  ]
});

// Only add file transports if environment variable is set or we're in fallback mode
if (process.env.USE_FILE_LOGGING === 'true' || process.env.FIREBASE_FALLBACK === 'true') {
  logger.add(fileRotateTransport);
}

// Always add error logging to disk for troubleshooting
logger.add(errorFileRotateTransport);

// Add method to log order details
logger.logOrder = function(order, waId) {
  // Map each product item with more details, supporting both formats
  const orderItems = order.product_items.map(item => {
    // Handle both formats (price vs item_price)
    const price = item.price || item.item_price || 0;
    const name = item.name || `Item ${item.product_retailer_id}`;

    return {
      id: item.product_retailer_id, // iPOS product ID
      name: name,
      quantity: item.quantity,
      price: price,
      currency: item.currency,
      subtotal: price * item.quantity,
      description: item.description || ''
    };
  });

  // Calculate order totals using the correct price field
  const totalAmount = order.product_items.reduce((total, item) => {
    const price = item.price || item.item_price || 0;
    return total + (price * item.quantity);
  }, 0);

  // Calculate VAT amount (5% in UAE)
  const vatRate = 0.05;
  const vatAmount = totalAmount * vatRate;
  const roundedVatAmount = Math.round(vatAmount * 100) / 100;
  const grandTotal = totalAmount + roundedVatAmount;

  // Generate a unique order reference for tracking
  const orderReference = `WA-${waId.slice(-4)}-${Date.now().toString().slice(-6)}`;

  // Create a comprehensive order log
  this.info(`New order received from ${waId}`, {
    orderReference,
    waId,
    catalogId: order.catalog_id,
    items: orderItems,
    subtotal: totalAmount,
    vat: roundedVatAmount,
    vatRate: `${vatRate * 100}%`,
    total: grandTotal,
    currency: order.product_items[0].currency,
    timestamp: new Date().toISOString()
  });

  // Create a separate log entry specifically for financial reporting
  this.info(`ORDER_FINANCIAL: WhatsApp order ${orderReference}`, {
    orderReference,
    waId,
    subtotal: totalAmount.toFixed(2),
    vat: roundedVatAmount.toFixed(2),
    total: grandTotal.toFixed(2),
    currency: order.product_items[0].currency,
    itemCount: order.product_items.length,
    timestamp: new Date().toISOString()
  });

  return orderReference;
};

// Add method to log product inquiries
logger.logProductInquiry = function(product, waId) {
  this.info(`Product inquiry from ${waId}`, {
    waId,
    productId: product.id,
    productName: product.title,
    retailerId: product.retailer_id,
    timestamp: new Date().toISOString()
  });
};

// Add method to log catalog interactions
logger.logCatalogInteraction = function(catalogMessage, waId) {
  this.info(`Catalog interaction from ${waId}`, {
    waId,
    catalogMessage,
    timestamp: new Date().toISOString()
  });
};

// Add method to log webhook events
logger.logWebhookEvent = function(body) {
  this.debug('Webhook event received', {
    object: body.object,
    entry: body.entry.map(entry => ({
      id: entry.id,
      time: entry.time,
      changes: entry.changes.map(change => ({
        field: change.field,
        value: change.value ? 'Present' : 'Absent' // Don't log the full value to avoid sensitive data
      }))
    }))
  });
};

module.exports = logger;