const fs = require('fs');
const path = require('path');

// Create events directory if it doesn't exist
const eventsDir = path.join(__dirname, 'events');
if (!fs.existsSync(eventsDir)) {
  fs.mkdirSync(eventsDir);
}

/**
 * Logs all webhook events to a separate file
 * @param {Object} data - The webhook event data
 * @param {Object} headers - HTTP headers from the request
 */
function logWebhookEvent(data, headers = {}) {
  // Check if full event logging is enabled
  if (process.env.ENABLE_FULL_EVENT_LOGGING !== 'true') {
    return false;
  }
  
  try {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      meta: {
        receivedAt: timestamp,
        environment: process.env.NODE_ENV || 'development'
      }
    };

    // Include headers if specified
    if (process.env.EVENT_LOG_HEADERS === 'true' && Object.keys(headers).length > 0) {
      logEntry.headers = headers;
    }
    
    // Include the full data payload
    logEntry.data = data;

    // Generate a unique ID for this event
    const eventId = generateEventId();
    logEntry.id = eventId;
    
    // Format the log entry with nice indentation
    const formattedEntry = JSON.stringify(logEntry, null, 2);
    
    // Create a line separator for better readability
    const separator = '\n' + '-'.repeat(80) + '\n';
    
    // Append to the all events log file with a separator
    fs.appendFileSync(
      path.join(eventsDir, 'all-events.log'),
      formattedEntry + separator
    );
    
    // Also save this event as an individual JSON file for easier analysis
    const eventTimestamp = timestamp.replace(/[:.]/g, '-');
    const eventType = getEventType(data);
    const filename = `event-${eventType}-${eventId}-${eventTimestamp}.json`;
    
    fs.writeFileSync(
      path.join(eventsDir, filename),
      formattedEntry
    );
    
    console.log(`Event logged to all-events.log and ${filename}`);
    
    return true;
  } catch (error) {
    console.error('Error logging event:', error);
    return false;
  }
}

/**
 * Generate a random event ID
 * @returns {string} - A random alphanumeric ID
 */
function generateEventId() {
  return Math.random().toString(36).substring(2, 10) + 
         Math.random().toString(36).substring(2, 10);
}

/**
 * Determine the event type from the webhook data
 * @param {Object} data - The webhook event data
 * @returns {string} - The determined event type
 */
function getEventType(data) {
  try {
    if (!data || !data.entry || !data.entry[0] || !data.entry[0].changes || !data.entry[0].changes[0]) {
      return 'unknown';
    }
    
    const value = data.entry[0].changes[0].value;
    
    if (value.messages) {
      if (value.messages[0]) {
        const messageType = value.messages[0].type || 'text';
        return `message-${messageType}`;
      }
      return 'message-unknown';
    }
    
    if (value.statuses) {
      if (value.statuses[0]) {
        return `status-${value.statuses[0].status || 'unknown'}`;
      }
      return 'status-unknown';
    }
    
    if (value.shopping) {
      const shoppingType = Object.keys(value.shopping)[0] || 'unknown';
      return `shopping-${shoppingType}`;
    }
    
    return 'other';
  } catch (error) {
    console.error('Error determining event type:', error);
    return 'error';
  }
}

/**
 * Returns whether full event logging is enabled
 * @returns {boolean} - Whether full event logging is enabled
 */
function isEventLoggingEnabled() {
  return process.env.ENABLE_FULL_EVENT_LOGGING === 'true';
}

/**
 * Utility function to read events
 * @param {string} eventId - Optional event ID to read a specific event
 * @param {number} limit - Optional limit for number of events to read from the log
 * @returns {Array|Object} - Array of events or specific event
 */
function readEvents(eventId, limit = 50) {
  try {
    if (eventId) {
      // Find event by ID from individual files
      const files = fs.readdirSync(eventsDir);
      const eventFile = files.find(file => file.includes(eventId));
      
      if (eventFile) {
        const eventData = fs.readFileSync(path.join(eventsDir, eventFile), 'utf8');
        return JSON.parse(eventData);
      }
      
      return null;
    } else {
      // Read the last 'limit' events from all-events.log
      const allEventsPath = path.join(eventsDir, 'all-events.log');
      
      if (!fs.existsSync(allEventsPath)) {
        return [];
      }
      
      const content = fs.readFileSync(allEventsPath, 'utf8');
      const eventStrings = content.split('-'.repeat(80)).filter(Boolean);
      
      // Take the most recent events up to the limit
      return eventStrings.slice(-limit).map(eventString => {
        try {
          return JSON.parse(eventString.trim());
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
    }
  } catch (error) {
    console.error('Error reading events:', error);
    return [];
  }
}

module.exports = {
  logWebhookEvent,
  isEventLoggingEnabled,
  readEvents
};