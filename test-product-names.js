/**
 * Test script for product name mapping
 * 
 * This script tests the product mapper with sample data to verify
 * that it correctly replaces "Item [product_id]" with proper product names.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const productMapper = require('./product-mapper');

// Test data - items that would be in a WhatsApp order
const testProductIds = [
  '200096', // Tea bag Earl grey
  '200098', // Tea Bag Roi Soleil
  'A001044', // Luxury Thai Beef Salad
  'A001046', // Butter Chicken
  '503406', // MAC MINI VANILLA
  '502006', // Saffron risotto chicken
  'NON_EXISTENT_PRODUCT' // Test missing product
];

// Main test function
async function testProductMapper() {
  console.log('Starting product mapper test...');
  
  // First test: Test synchronous fallback before loading catalog
  console.log('\n=== Test 1: Synchronous Fallback (Before Loading Catalog) ===');
  
  for (const productId of testProductIds) {
    const name = productMapper.getProductName(productId);
    console.log(`Product ${productId} => ${name}`);
  }
  
  // Second test: Load catalog and test mapping
  console.log('\n=== Test 2: After Loading Catalog ===');
  
  try {
    await productMapper.loadProductCatalog();
    console.log('Catalog loaded successfully with', 
      productMapper.getAllProducts().size, 'products');
      
    for (const productId of testProductIds) {
      const name = productMapper.getProductName(productId);
      console.log(`Product ${productId} => ${name}`);
    }
  } catch (error) {
    console.error('Error loading catalog:', error.message);
  }
  
  // Third test: Simulate order confirmation formatting
  console.log('\n=== Test 3: Order Confirmation Formatting ===');
  
  // Sample WhatsApp order data with missing names
  const sampleOrder = {
    product_items: [
      {
        product_retailer_id: '200096',
        name: 'Item 200096', // WhatsApp placeholder name 
        quantity: 1,
        price: 105,
        currency: 'AED'
      },
      {
        product_retailer_id: '200098',
        name: 'Item 200098', // WhatsApp placeholder name
        quantity: 1,
        price: 105, 
        currency: 'AED'
      },
      {
        product_retailer_id: 'A001044',
        name: 'Luxury Thai Beef Salad', // This one has name already
        quantity: 2,
        price: 60,
        currency: 'AED'
      }
    ]
  };
  
  // Format like the order confirmation
  const orderItems = sampleOrder.product_items.map(item => {
    const price = item.price || item.item_price || 0;
    const productId = item.product_retailer_id;
    
    // Get product name from catalog
    const mappedName = productMapper.getProductName(productId, item.name);
    
    // Original line format
    const originalLine = `• ${item.name} x${item.quantity} - ${price} ${item.currency}`;
    
    // New line format with mapped name
    const newLine = `• ${mappedName} x${item.quantity} - ${price} ${item.currency}`;
    
    console.log(`Original: ${originalLine}`);
    console.log(`New:      ${newLine}`);
    console.log('-'.repeat(50));
    
    return newLine;
  }).join('\n');
  
  console.log('\nOrder summary would look like:');
  console.log(orderItems);
}

// Run the test
testProductMapper()
  .then(() => console.log('\nTest completed successfully!'))
  .catch(error => console.error('\nTest failed:', error));