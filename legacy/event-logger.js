const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Create events directory if it doesn't exist
const eventsDir = path.join(__dirname, 'events');
if (!fs.existsSync(eventsDir)) {
  fs.mkdirSync(eventsDir);
}

// Helper function to clean an object for storage
function sanitizeDataForStorage(obj) {
  try {
    // Create a clean version of the object
    const cleanData = JSON.parse(JSON.stringify(obj, (key, value) => {
      // Skip binary data and large objects
      if (Buffer.isBuffer(value) ||
          (typeof value === 'string' && value.length > 5000) ||
          (key === 'rawData' || key === 'response' || key === 'headers')) {
        return '[Large data not stored]';
      }
      return value;
    }));
    return cleanData;
  } catch (error) {
    console.error('Error sanitizing data for storage:', error);
    return { error: 'Data could not be sanitized', partial: String(obj).substring(0, 100) };
  }
}

// Helper to clean up old events (older than 12 hours)
function cleanupOldEvents() {
  try {
    const files = fs.readdirSync(eventsDir);
    const now = Date.now();
    const retentionPeriod = parseInt(process.env.EVENT_RETENTION_HOURS || '12', 10) * 60 * 60 * 1000; // Convert hours to ms

    let deletedCount = 0;
    files.forEach(file => {
      // Skip special files
      if (file === 'all-events.log' || file === '.gitkeep') {
        return;
      }

      const filePath = path.join(eventsDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtime.getTime();

      if (fileAge > retentionPeriod) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    });

    // Also clean up the main log file if it's too large (>10MB)
    const allEventsPath = path.join(eventsDir, 'all-events.log');
    if (fs.existsSync(allEventsPath)) {
      const stats = fs.statSync(allEventsPath);
      if (stats.size > 10 * 1024 * 1024) { // 10MB
        // Truncate file by keeping only the last ~5MB
        const data = fs.readFileSync(allEventsPath, 'utf8');
        const truncated = data.substring(Math.max(0, data.length - 5 * 1024 * 1024));
        // Find the first separator and start from there
        const firstSeparatorIndex = truncated.indexOf('-'.repeat(80));
        const cleanData = firstSeparatorIndex > 0 ? truncated.substring(firstSeparatorIndex) : truncated;
        fs.writeFileSync(allEventsPath, cleanData);
      }
    }

    if (deletedCount > 0) {
      console.log(`Cleaned up ${deletedCount} old event files`);
    }
  } catch (error) {
    console.error('Error cleaning up old events:', error);
  }
}

/**
 * Logs webhook events to Firebase (with local file fallback)
 * @param {Object} data - The webhook event data
 * @param {Object} headers - HTTP headers from the request
 */
async function logWebhookEvent(data, headers = {}) {
  // Check if event logging is enabled
  if (process.env.ENABLE_FULL_EVENT_LOGGING !== 'true') {
    return false;
  }

  try {
    // Run cleanup periodically (5% chance on each event)
    if (Math.random() < 0.05) {
      cleanupOldEvents();
    }

    const timestamp = new Date().toISOString();
    const eventId = generateEventId();
    const eventType = getEventType(data);

    // Create minimal log entry with essential data
    const logEntry = {
      id: eventId,
      timestamp,
      type: eventType,
      meta: {
        receivedAt: timestamp,
        environment: process.env.NODE_ENV || 'development'
      }
    };

    // Sanitize headers and data to avoid serialization issues
    if (process.env.EVENT_LOG_HEADERS === 'true' && Object.keys(headers).length > 0) {
      logEntry.headers = sanitizeDataForStorage(headers);
    }

    // Include minimal required data based on event type
    if (eventType.startsWith('message-')) {
      // For messages, store only essential info
      const messages = data.entry?.[0]?.changes?.[0]?.value?.messages || [];
      if (messages.length > 0) {
        const message = messages[0];
        logEntry.message = {
          id: message.id,
          type: message.type,
          from: data.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id,
          timestamp: message.timestamp,
          text: message.type === 'text' ? message.text?.body : undefined,
          interactive: message.type === 'interactive' ? message.interactive : undefined,
          order: message.type === 'order' ? sanitizeDataForStorage(message.order) : undefined
        };
      }
    } else if (eventType.startsWith('status-')) {
      // For statuses, store minimal data
      const statuses = data.entry?.[0]?.changes?.[0]?.value?.statuses || [];
      if (statuses.length > 0) {
        const status = statuses[0];
        logEntry.status = {
          id: status.id,
          status: status.status,
          timestamp: status.timestamp,
          recipient_id: status.recipient_id
        };
      }
    } else if (eventType.startsWith('shopping-')) {
      // For shopping events, sanitize the data
      const shopping = data.entry?.[0]?.changes?.[0]?.value?.shopping;
      if (shopping) {
        logEntry.shopping = sanitizeDataForStorage(shopping);
      }
    } else {
      // For other events, store minimal sanitized data
      logEntry.data = sanitizeDataForStorage(data);
    }

    // Try to save to Firebase first
    let savedToFirebase = false;
    const db = admin.firestore && admin.firestore();

    if (db) {
      try {
        await db.collection('events').doc(eventId).set(logEntry);
        savedToFirebase = true;
      } catch (fbError) {
        console.error('Failed to save event to Firebase:', fbError);
        process.env.FIREBASE_FALLBACK = 'true'; // Enable fallback mode
      }
    }

    // Fall back to file storage if needed or explicitly configured
    if (!savedToFirebase || process.env.EVENT_FILE_FALLBACK === 'true') {
      // Format the log entry with nice indentation
      const formattedEntry = JSON.stringify(logEntry, null, 2);

      // Create a line separator for better readability
      const separator = '\n' + '-'.repeat(80) + '\n';

      // Append to the all events log file with a separator
      fs.appendFileSync(
        path.join(eventsDir, 'all-events.log'),
        formattedEntry + separator
      );

      // Only save individual event files for specific important events or in debug mode
      const isImportantEvent = eventType.includes('order') ||
                              eventType === 'message-text' ||
                              process.env.NODE_ENV === 'development';

      if (isImportantEvent) {
        // Save as an individual JSON file
        const eventTimestamp = timestamp.replace(/[:.]/g, '-');
        const filename = `event-${eventType}-${eventId}-${eventTimestamp}.json`;

        fs.writeFileSync(
          path.join(eventsDir, filename),
          formattedEntry
        );
      }

      console.log(`Event ${eventId} logged${savedToFirebase ? ' (Firebase + local backup)' : ' (local only)'}`);
    } else {
      console.log(`Event ${eventId} logged to Firebase`);
    }

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
 * Utility function to read events (from Firebase first, then local files)
 * @param {string} eventId - Optional event ID to read a specific event
 * @param {number} limit - Optional limit for number of events to read from the log
 * @returns {Promise<Array|Object>} - Array of events or specific event
 */
async function readEvents(eventId, limit = 50) {
  try {
    // Try to read from Firebase first
    const db = admin.firestore && admin.firestore();

    if (db) {
      try {
        if (eventId) {
          // Get specific event by ID
          const docSnapshot = await db.collection('events').doc(eventId).get();
          if (docSnapshot.exists) {
            return docSnapshot.data();
          }
        } else {
          // Get latest events up to limit
          const querySnapshot = await db.collection('events')
            .orderBy('timestamp', 'desc')
            .limit(limit)
            .get();

          if (!querySnapshot.empty) {
            const events = [];
            querySnapshot.forEach(doc => {
              events.push(doc.data());
            });
            return events;
          }
        }
      } catch (fbError) {
        console.error('Error reading events from Firebase:', fbError);
        // Continue to local file fallback
      }
    }

    // If we reached here, either Firebase failed or returned no results
    // Fall back to local file storage
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