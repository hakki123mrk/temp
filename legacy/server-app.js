require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const logger = require('./logger');
const eventLogger = require('./event-logger');
const fs = require('fs');
const path = require('path');
const iposService = require('./simple-ipos');
const productMapper = require('./product-mapper');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();

// Initialize Firebase Admin SDK
let db;

try {
  const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (serviceAccountPath) {
    admin.initializeApp({
      credential: admin.credential.cert(require(serviceAccountPath))
    });
    logger.info('Firebase initialized with service account file');
  } else {
    admin.initializeApp();
    logger.info('Firebase initialized with application default credentials');
  }

  db = admin.firestore();
  logger.info('Firestore initialized successfully');
} catch (error) {
  logger.error('Firebase initialization error:', error);
}

// Export db for use in other modules
module.exports.db = db;

// CORS
app.use(cors({
  origin: process.env.CORS_ALLOW_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(bodyParser.json());

// Logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.http(`${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Import routes from server.js (we'll extract the route handlers)
// For now, keeping minimal structure

// Webhook verification
app.get('/webhook', (req, res) => {
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      logger.info('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logger.warn(`Webhook verification failed - token mismatch, received: ${token}`);
      res.sendStatus(403);
    }
  } else {
    logger.warn('Webhook verification failed - missing parameters');
    res.sendStatus(404);
  }
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: 'lambda'
  });
});

// Export app for Lambda
module.exports = app;
