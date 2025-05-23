# WhatsApp Commerce Webhook Server

This server handles commerce events from WhatsApp, including catalog interactions, product inquiries, and orders.

## Setup

1. Install dependencies:
```
npm install
```

2. Create a `.env` file based on the `.env.example` template:
```
cp .env.example .env
```

3. Edit the `.env` file with your credentials:
- WhatsApp API token
- Phone number ID
- Verification token (create your own secure string)
- iPOS credentials (if needed)

4. Start the server:
```
npm start
```

Or for development with auto-reload:
```
npm run dev
```

## Webhook Configuration

### Meta Developer Dashboard Setup

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Navigate to your app
3. Add the WhatsApp product if not already added
4. Go to WhatsApp > Configuration
5. In the Webhooks section, click "Edit"
6. Enter your webhook URL: `https://your-domain.com/webhook`
7. Enter your verification token (same as in `.env`)
8. Select the following webhook fields:
   - `messages`
   - `message_status`
   - `shopping`

### Testing Locally with ngrok

If testing locally, you'll need to expose your webhook:

1. Install [ngrok](https://ngrok.com/)
2. Run ngrok on port 3000:
```
ngrok http 3000
```
3. Copy the HTTPS URL (e.g., https://abc123.ngrok.io)
4. Use this URL + "/webhook" in your WhatsApp configuration

## Webhook Events

This server handles these WhatsApp events:

- **Text Messages**: Standard user messages
- **Interactive Messages**: Button clicks and list selections
- **Catalog Messages**: User browsing the catalog
- **Product Inquiries**: Questions about specific products
- **Orders**: Complete order submissions

When an order is received, the server:
1. Logs order details
2. Processes the order (ready to integrate with iPOS)
3. Sends an order confirmation to the customer

## Customization

To integrate with iPOS:
- Modify the `processOrderToiPOS` function
- Implement the necessary API calls to your iPOS system
- Format the order data as required by iPOS

## Production Deployment

For production:
1. Deploy to a server with HTTPS
2. Ensure environment variables are secured
3. Add proper error handling and logging
4. Consider adding a database to store orders

## Troubleshooting

If webhooks aren't being received:
- Verify your webhook URL is accessible
- Check the verification token matches
- Ensure the correct webhook fields are subscribed
- Review Meta Developers webhook logs#   t e m p  
 