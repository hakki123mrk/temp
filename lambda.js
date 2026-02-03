const serverless = require('serverless-http');
const app = require('./server-app');

// Wrap Express app for Lambda
module.exports.handler = serverless(app);
