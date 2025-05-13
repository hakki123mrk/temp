/**
 * Product Name Mapper
 * 
 * This module loads product data from the Facebook catalog CSV file
 * and provides functions to map product IDs to their proper names.
 * Used to replace generic "Item [ID]" names in WhatsApp orders with proper product names.
 */

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const logger = require('./logger');

// Look for the catalog file in multiple locations
const CATALOG_FILE_PATHS = [
  path.join(__dirname, 'facebook_catalog.csv'), // Local directory (preferred)
  path.join(__dirname, '..', 'facebook_catalog.csv'), // Parent directory (fallback)
];

// In-memory product mapping cache
let productNameMap = null;
let productDetailsMap = null;
let isLoaded = false;

/**
 * Load the product catalog data from the CSV file
 * @returns {Promise<boolean>} True if loading was successful
 */
async function loadProductCatalog() {
  return new Promise((resolve, reject) => {
    // Initialize maps
    productNameMap = new Map();
    productDetailsMap = new Map();

    // Find the first existing catalog file
    let catalogFilePath = null;
    for (const filePath of CATALOG_FILE_PATHS) {
      if (fs.existsSync(filePath)) {
        catalogFilePath = filePath;
        break;
      }
    }

    // Return error if no catalog file found
    if (!catalogFilePath) {
      const errorMsg = `Product catalog file not found in any of the search paths: ${CATALOG_FILE_PATHS.join(', ')}`;
      logger.error(errorMsg);
      isLoaded = false;
      reject(new Error(errorMsg));
      return;
    }

    // Parse CSV file
    logger.info(`Loading product catalog from: ${catalogFilePath}`);

    const results = [];
    fs.createReadStream(catalogFilePath)
      .pipe(csv())
      .on('data', (data) => {
        results.push(data);
      })
      .on('end', () => {
        let count = 0;

        // Process each product
        results.forEach(product => {
          // Extract product ID and title
          const productId = product.id;
          const productTitle = product.title;

          if (productId && productTitle) {
            // Add to name mapping
            productNameMap.set(productId, productTitle);

            // Store all product details
            productDetailsMap.set(productId, {
              id: productId,
              title: productTitle,
              description: product.description,
              price: product.price ? parseFloat(product.price.split(' ')[0]) : null,
              currency: product.price ? product.price.split(' ')[1] : 'AED',
              image: product.image_link
            });

            count++;
          }
        });

        isLoaded = true;
        logger.info(`Successfully loaded ${count} products from catalog`);
        resolve(true);
      })
      .on('error', (error) => {
        logger.error(`Error loading product catalog: ${error.message}`);
        isLoaded = false;
        reject(error);
      });
  });
}

/**
 * Get the product name for a given product ID
 * @param {string} productId The product ID
 * @param {string} defaultName Default name to use if not found (optional)
 * @returns {string} The product name or default name
 */
function getProductName(productId, defaultName = null) {
  // If catalog not loaded, try to load it synchronously
  if (!isLoaded) {
    try {
      // Find the first existing catalog file
      let catalogFilePath = null;
      for (const filePath of CATALOG_FILE_PATHS) {
        if (fs.existsSync(filePath)) {
          catalogFilePath = filePath;
          break;
        }
      }

      if (!catalogFilePath) {
        logger.warn(`Product catalog file not found in any of the search paths`);
        return defaultName || `Item ${productId}`;
      }

      // Simple synchronous loading for fallback
      const fileContent = fs.readFileSync(catalogFilePath, 'utf8');
      const lines = fileContent.split('\n');

      // Skip header
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        const columns = line.split(',');
        if (columns.length >= 2) {
          const id = columns[0];
          const title = columns[1];

          if (id === productId && title) {
            return title;
          }
        }
      }

      return defaultName || `Item ${productId}`;
    } catch (error) {
      logger.error(`Error in synchronous catalog loading: ${error.message}`);
      return defaultName || `Item ${productId}`;
    }
  }

  // Normal case: catalog is loaded
  if (productNameMap.has(productId)) {
    return productNameMap.get(productId);
  }
  
  return defaultName || `Item ${productId}`;
}

/**
 * Get full product details for a given product ID
 * @param {string} productId The product ID
 * @returns {Object|null} The product details or null if not found
 */
function getProductDetails(productId) {
  if (!isLoaded) {
    logger.warn('Product catalog not loaded yet. Call loadProductCatalog() first.');
    return null;
  }
  
  if (productDetailsMap.has(productId)) {
    return productDetailsMap.get(productId);
  }
  
  return null;
}

/**
 * Get all product details
 * @returns {Map} Map of product details indexed by product ID
 */
function getAllProducts() {
  if (!isLoaded) {
    logger.warn('Product catalog not loaded yet. Call loadProductCatalog() first.');
    return new Map();
  }
  
  return productDetailsMap;
}

/**
 * Check if the product catalog is loaded
 * @returns {boolean} True if catalog is loaded
 */
function isProductCatalogLoaded() {
  return isLoaded;
}

/**
 * Copy the catalog file from parent directory to local directory if needed
 * This ensures the catalog file is included when deploying the webhook server
 * @returns {Promise<boolean>} True if successful or not needed
 */
async function ensureLocalCatalogFile() {
  const localCatalogPath = path.join(__dirname, 'facebook_catalog.csv');
  const parentCatalogPath = path.join(__dirname, '..', 'facebook_catalog.csv');

  // If local file already exists, no need to copy
  if (fs.existsSync(localCatalogPath)) {
    return true;
  }

  // Check if parent catalog exists
  if (!fs.existsSync(parentCatalogPath)) {
    logger.warn(`Parent catalog file not found: ${parentCatalogPath}`);
    return false;
  }

  try {
    // Copy file from parent to local directory
    fs.copyFileSync(parentCatalogPath, localCatalogPath);
    logger.info(`Copied catalog file from ${parentCatalogPath} to ${localCatalogPath}`);
    return true;
  } catch (error) {
    logger.error(`Error copying catalog file: ${error.message}`);
    return false;
  }
}

module.exports = {
  loadProductCatalog,
  getProductName,
  getProductDetails,
  getAllProducts,
  isProductCatalogLoaded,
  ensureLocalCatalogFile
};