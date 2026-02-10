# Firebase Setup for WhatsApp Dashboard

This guide explains how to set up Firebase for the WhatsApp message dashboard.

## Create a Firebase Project

1. Go to the [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project" and follow the setup instructions
3. Choose a project name and continue through the setup

## Set Up Firebase Authentication (Optional)

If you want to secure your dashboard:

1. In the Firebase Console, go to "Authentication"
2. Click "Get started"
3. Enable the Email/Password provider
4. Create test users as needed

## Create a Firestore Database

1. In the Firebase Console, go to "Firestore Database"
2. Click "Create database"
3. Choose "Start in production mode" or "Start in test mode" (choose production for real deployments)
4. Select a database location close to your users
5. Click "Enable"

## Set Up Security Rules

Update your Firestore security rules to secure your data:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Allow read access to messages and contacts
    match /messages/{messageId} {
      allow read: if request.auth != null;
      allow write: if false; // Only the webhook server can write messages
    }
    
    match /contacts/{phoneNumber} {
      allow read: if request.auth != null;
      allow write: if false; // Only the webhook server can write contacts
    }
  }
}
```

## Generate Service Account Key

1. In the Firebase Console, go to "Project settings" (gear icon)
2. Go to the "Service accounts" tab
3. Click "Generate new private key"
4. Save the JSON file securely

## Configure Webhook to Use Firebase

1. Rename the downloaded service account key to `firebase-service-account.json`
2. Move it to your webhook project directory
3. Update your `.env` file to include:

```
# Firebase Configuration
GOOGLE_APPLICATION_CREDENTIALS=./firebase-service-account.json
```

## Firebase Collections Used

The webhook is configured to use these Firestore collections:

1. **messages** - Stores all WhatsApp messages with:
   - `from`: Sender's phone number
   - `timestamp`: Message timestamp 
   - `messageId`: Original message ID
   - `type`: Message type (text, interactive, etc.)
   - `text`: Message text content (for text messages)
   - `senderName`: Name of the sender if available
   - `rawData`: Complete message data

2. **contacts** - Stores contact information with:
   - `phoneNumber`: Contact's phone number (document ID)
   - `profileName`: Contact's name if available
   - `lastMessageTime`: Timestamp of their last message (for 24-hour window tracking)

## Testing Your Integration

1. Start your webhook server
2. Send a test message to your WhatsApp Business number
3. Check the Firestore console to see if the message was saved
4. Run your dashboard application to view the messages

## Troubleshooting

- Check webhook server logs for Firebase initialization errors
- Verify the service account has proper permissions
- Ensure the service account path in your .env file is correct