# WhatsApp Webhook Event Handling

This document describes how events are processed in the WhatsApp webhook and displayed in the dashboard.

## Message and Event Types

The webhook now differentiates between two types of data:

### 1. Content Messages
- Actual communication content (text, images, orders, etc.)
- Stored in the Firestore `messages` collection
- Used for displaying chat history in the UI

### 2. System Events
- Status updates and indicators that don't contain actual message content
- Stored in the Firestore `systemEvents` collection
- Used for UI features like typing indicators and read statuses

## Event Categories

The system handles these specific event types:

### Typing Indicators
- When a user starts typing, WhatsApp sends a typing indicator
- These are processed by the `processTypingEvent` function
- Typing indicators expire automatically after 30 seconds if no follow-up is received
- UI shows "Contact is typing..." with animated dots

### Read Receipts
- When a user reads a message, WhatsApp sends a status update
- These are processed by the `processMessageStatus` function
- Messages are marked as "read" in the UI with blue checkmarks

### Delivery Status
- Updates on message delivery status (sent, delivered, failed)
- Also processed by the `processMessageStatus` function
- Shows gray checkmarks in the UI for delivered messages

## Data Structure

### System Events Collection
System events use this data structure in Firestore:

```typescript
interface SystemEvent {
  id: string;               // Firestore document ID
  type: string;             // Event category (typing, status, etc.)
  eventType: string;        // Specific event type (typing, read_receipt, etc.)
  timestamp: Timestamp;     // When the event occurred
  messageId?: string;       // Related message ID if applicable
  from?: string;            // Sender ID
  to?: string;              // Recipient ID
  data: any;                // Event specific data
  relatedEventId?: string;  // For events that reference other events
}
```

## Implementation

The system is built to:

1. **Filter at Database Level**: Queries filter by message type rather than loading all data
2. **Process Incrementally**: Only loads new events since last timestamp
3. **Handle Auto-Expiration**: Some events (like typing) auto-expire
4. **Maintain Compatibility**: Updates both new and old data structures for backward compatibility

## Frontend Integration

The dashboard connects to this system through the `FirestoreContext` which:

1. Maintains separate arrays for messages and events
2. Provides helper methods to access each data type
3. Implements real-time listeners for each collection
4. Includes utility functions to check message/event types

## Performance Benefits

This separation provides:

- Reduced data transfer (only loading what's needed)
- Fewer UI reloads (content vs status updates)
- Better user experience with real-time indicators
- Lower Firebase costs by optimizing queries