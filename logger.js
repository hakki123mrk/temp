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
  const orderItems = order.product_items.map(item => ({
    name: item.name,
    quantity: item.quantity,
    price: `${item.price} ${item.currency}`
  }));
  
  const totalAmount = order.product_items.reduce((total, item) => {
    return total + (item.price * item.quantity);
  }, 0);
  
  this.info(`New order received from ${waId}`, {
    waId,
    catalogId: order.catalog_id,
    items: orderItems,
    totalAmount: `${totalAmount} ${order.product_items[0].currency}`,
    timestamp: new Date().toISOString()
  });
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