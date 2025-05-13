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
    meta = JSON.stringify(metadata, null, 2);
  }
  
  return `${timestamp} [${level}]: ${message} ${meta}`;
});

// Create daily rotate file transport
const fileRotateTransport = new transports.DailyRotateFile({
  filename: path.join(logDir, 'whatsapp-webhook-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  format: combine(
    timestamp(),
    logFormat
  )
});

// Create a separate transport for error logs
const errorFileRotateTransport = new transports.DailyRotateFile({
  filename: path.join(logDir, 'whatsapp-webhook-error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxFiles: '14d',
  maxSize: '20m',
  level: 'error',
  format: combine(
    timestamp(),
    logFormat
  )
});

// Create combined logger with console and file transports
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
    }),
    fileRotateTransport,
    errorFileRotateTransport
  ]
});

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