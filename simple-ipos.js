/**
 * Simple iPOS integration for WhatsApp orders
 * This module handles authentication, order submission, and logging for iPOS integration
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('./logger');

// Create data directory for storing order logs if it doesn't exist
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

/**
 * Authenticate with iPOS API
 * @returns {Promise<string>} The access token for iPOS API
 */
async function authenticateWithIPOS() {
  try {
    // Message log
    logger.info('Authenticating with iPOS API');
    
    const response = await axios({
      method: 'POST',
      url: `${process.env.IPOS_API_URL}/Token`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: `username=${process.env.IPOS_USERNAME}&password=${process.env.IPOS_PASSWORD}&grant_type=password`
    });
    
    if (response.data && response.data.access_token) {
      // Message log
      logger.info('Successfully authenticated with iPOS API');
      return response.data.access_token;
    } else {
      throw new Error('Invalid authentication response from iPOS API');
    }
  } catch (error) {
    // Message log
    logger.error(`Error authenticating with iPOS API: ${error.message}`);
    throw error;
  }
}

/**
 * Format a WhatsApp order for iPOS API
 * @param {Object} order The WhatsApp order object
 * @param {string} waId The WhatsApp ID
 * @param {string} orderReference The order reference
 * @returns {Object} The formatted order for iPOS API
 */
function formatOrderForIPOS(order, waId, orderReference) {
  // Calculate total amount including all items
  // Handle both price formats (price or item_price)
  const totalAmount = order.product_items.reduce((total, item) => {
    const price = item.price || item.item_price || 0;
    return total + (price * item.quantity);
  }, 0);

  // Calculate VAT amount (5% in UAE)
  const vatRate = 0.05;
  const vatAmount = totalAmount * vatRate;
  const roundedVatAmount = Math.round(vatAmount * 100) / 100;

  // Get current date and time
  const now = new Date();
  const formattedDate = now.toISOString();

  // Create sales details array from order items - match Angular App format
  const salesDetails = order.product_items.map((item, index) => {
    // Handle both price formats (price or item_price)
    const price = item.price || item.item_price || 0;
    const name = item.name || `Item ${item.product_retailer_id}`;

    return {
      "SlNo": index,
      "InvNo": 0,
      "Barcode": item.id || item.product_retailer_id || `item_${index}`, // Barcode format from catalog
      "Qty": item.quantity,
      "UnitId": 0,
      "Rate": price,
      "Discount": 0,
      "BatchNo": "",
      "KitchenNote": "",
      "KotStatus": 0,
      "KotOrderTime": formattedDate,
      "TypeCaption": name,
      "LocId": process.env.IPOS_LOCATION_ID || 2,
      "ActualRate": price,
      "SeatNo": 0,
      "KitchenNotes": [{
        "Barcode": "",
        "Remarks": "",
        "LocId": 0,
        "UserId": 0
      }],
      "TaxDetails": [{
        "TaxPercent": 5,
        "Description": "TAX",
        "TaxAmt": (5 * price * item.quantity / 100), // 5% VAT
        "SlNo": 0,
        "InvNo": 0,
        "TaxId": 1,
        "TaxName": "TAX"
      }],
      "DiscountCode": ""
    };
  });

  // Create payment list for WhatsApp orders
  const paymentList = [
    {
      "PaymentId": 2, // Using card payment ID like Angular app
      "PaymentType": "Card",
      "Name": "WhatsApp Order",
      "Description": "WhatsApp Payment",
      "ReferenceNo": `WA_${orderReference}`,
      "Amount": totalAmount + roundedVatAmount
    }
  ];

  // Format matches Angular app
  return {
    "InvNo": 0,
    "InvDate": formattedDate,
    "InvTime": formattedDate,
    "CounterId": 1,
    "CashierId": 1,
    "CounterOpId": 0,
    "TotAmount": totalAmount + roundedVatAmount,
    "TotCash": 0,
    "TotCredit": 0,
    "TotCreditCard": totalAmount + roundedVatAmount, // Use card payment for WhatsApp
    "CreditCardNo": `WHATSAPP_${waId}`,
    "TotAltCurrency": 0,
    "AltCurrencyId": 0,
    "TransNo": 0,
    "Discount": 0,
    "ConvRate": 0,
    "AmountReceived": totalAmount + roundedVatAmount,
    "ExchangeRate": 0,
    "HoldFlag": true, // Not holding the order
    "SalesType": true,
    "CustomerId": 0,
    "ResetNo": 0,
    "Balance": 0,
    "DayOpenId": 0,
    "TotalCredit": 0,
    "CustomerCode": 0,
    "TotalGiftVoucher": 0,
    "GiftVoucherNo": "",
    "NationalityCode": 0,
    "TableNo": 0,
    "TakeAway": 1, // WhatsApp orders are takeaway
    "Delivery": 0,
    "Name": `WhatsApp-${waId}`,
    "Address": "",
    "PhoneNo": waId,
    "Merged": 0,
    "Split": 0,
    "CupType": 0,
    "Company": "",
    "IdNo": `WA_${orderReference}`,
    "PAX": 1,
    "TableSubNo": 0,
    "AirmilesCardNo": "",
    "TotOnlinePayment": 0,
    "ProviderId": 0,
    "Status": 0,
    "VatAmt": roundedVatAmount,
    "LocId": process.env.IPOS_LOCATION_ID || 2,
    "RoomType": 1,
    "TicketNo": "",
    "DeliveryCharges": 0,
    "PaymentMode": 0,
    "AreaId": 0,
    "AddressId": 0,
    "Source": "WhatsApp",
    "TotPayLater": 0,
    "TotSecurityDeposit": 0,
    "DeliveryDate": "",
    "ReminderBefore": 0,
    "IsOrderTaken": true,
    "ReservationId": 0,
    "TipsAmount": 0,
    "TipsPercentage": 0,
    "PredefinedDiscId": 0,
    "DiscountNarration": "",
    "MaxNoofPax": 1,
    "TotCreditNote": 0,
    "CreditNoteRefNo": "",
    "ExtraDiscount": 0,
    "OrderNote": `WhatsApp Order: ${orderReference}`,
    "DeliveryType": "",
    "DeliveryRemark": "",
    "PaymentList": paymentList,
    "SalesDetails": salesDetails
  };
}

/**
 * Process an order and submit it to iPOS
 * @param {Object} order The WhatsApp order object
 * @param {string} waId The WhatsApp ID
 * @param {string} orderReference The order reference
 * @returns {Promise<Object>} The result of the order processing
 */
async function processOrderToiPOS(order, waId, orderReference) {
  try {
    // Message log: Log start of processing
    logger.info(`Processing order ${orderReference} from ${waId} to iPOS system`);

    // Calculate total order amount
    const totalAmount = order.product_items.reduce((total, item) => {
      return total + (item.price * item.quantity);
    }, 0);

    // Calculate VAT (5% in UAE)
    const vatRate = 0.05;
    const vatAmount = totalAmount * vatRate;
    const roundedVatAmount = Math.round(vatAmount * 100) / 100;
    const grandTotal = totalAmount + roundedVatAmount;

    // Using v2 endpoint like the Angular app - no authentication needed
    // We'll keep the code below for reference but skip token retrieval

    // Step 2: Format the order for iPOS
    const formattedOrder = formatOrderForIPOS(order, waId, orderReference);

    // Step 3: Submit the order to iPOS
    logger.info(`Submitting order ${orderReference} to iPOS API...`);

    // Log the request payload
    logger.debug(`iPOS API Request Payload:`, {
      url: `${process.env.IPOS_API_URL}/services/api/rest/v2/SaveSalesOrder`,
      headers: {
        'Content-Type': 'application/json'
        // No Authorization header for v2 endpoint
      },
      data: formattedOrder
    });

    // Save detailed request to file for debugging
    fs.writeFileSync(
      path.join(dataDir, `ipos-request-${orderReference}.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orderReference,
        url: `${process.env.IPOS_API_URL}/services/api/rest/v2/SaveSalesOrder`,
        method: 'POST',
        data: formattedOrder
      }, null, 2)
    );

    const response = await axios({
      method: 'POST',
      url: `${process.env.IPOS_API_URL}/services/api/rest/v2/SaveSalesOrder`,
      headers: {
        'Content-Type': 'application/json'
        // No Authorization header for v2 endpoint
      },
      data: formattedOrder
    });

    // Log the response
    logger.debug(`iPOS API Response:`, {
      status: response.status,
      statusText: response.statusText,
      data: response.data
    });

    // Save detailed response to file
    fs.writeFileSync(
      path.join(dataDir, `ipos-response-${orderReference}.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        orderReference,
        status: response.status,
        statusText: response.statusText,
        data: response.data
      }, null, 2)
    );

    // Step 4: Process the response and handle success/failure
    if (response.data && response.data.Success) {
      const invoiceNumber = response.data.data.InvNo;
      
      // Message log for success
      logger.info(`Order ${orderReference} from ${waId} successfully submitted to iPOS. Invoice #${invoiceNumber} created.`);
      
      // System log (single file per order)
      fs.writeFileSync(
        path.join(dataDir, `order-${orderReference}.json`),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "SUCCESS",
          orderReference,
          waId,
          invoiceNumber,
          totalAmount,
          vatAmount: roundedVatAmount,
          grandTotal,
          currency: order.product_items[0].currency,
          items: order.product_items.map(item => ({
            id: item.product_retailer_id,
            name: item.name,
            quantity: item.quantity,
            price: item.price
          }))
        }, null, 2)
      );

      return {
        success: true,
        invoiceNumber: invoiceNumber,
        invoiceData: response.data.data
      };
    } else {
      // Message log for failure
      logger.error(`Order ${orderReference} failed to submit to iPOS: ${response.data?.message || 'Unknown error'}`);
      
      // System log
      fs.writeFileSync(
        path.join(dataDir, `order-${orderReference}.json`),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "FAILURE",
          orderReference,
          waId,
          error: response.data?.message || 'Unknown error',
          response: response.data
        }, null, 2)
      );
      
      return {
        success: false,
        error: 'Failed to submit order to iPOS',
        details: response.data
      };
    }
  } catch (error) {
    // Message log for error
    logger.error(`Error processing order ${orderReference}: ${error.message}`);
    
    // System log
    fs.writeFileSync(
      path.join(dataDir, `order-${orderReference}.json`),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "ERROR",
        orderReference,
        waId,
        errorMessage: error.message,
        errorType: error.response ? 'API_ERROR' : 
                   error.request ? 'CONNECTION_ERROR' : 'REQUEST_SETUP_ERROR',
        errorDetails: {
          status: error.response?.status,
          message: error.message
        }
      }, null, 2)
    );
    
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  authenticateWithIPOS,
  formatOrderForIPOS,
  processOrderToiPOS
};