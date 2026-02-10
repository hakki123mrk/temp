// Live development server for payment pages
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const LAMBDA_FILE = path.join(__dirname, 'cdk/lambda/index.js');

function extractPaymentHTML(pageName) {
  // Read Lambda function code fresh each time
  delete require.cache[require.resolve('./cdk/lambda/index.js')];
  const lambdaCode = fs.readFileSync(LAMBDA_FILE, 'utf8');
  
  const pattern = new RegExp(`if \\(path\\.includes\\('${pageName}'\\)\\) \\{[\\s\\S]*?body: \`([\\s\\S]*?)\`\\s*\\}`, 'm');
  const match = lambdaCode.match(pattern);
  
  if (match) {
    return match[1].trim();
  }
  return `<html><body><h1>Error: Could not extract ${pageName} page</h1></body></html>`;
}

const server = http.createServer((req, res) => {
  console.log(`${new Date().toLocaleTimeString()} - ${req.url}`);
  
  if (req.url === '/payment-success' || req.url.startsWith('/payment-success?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(extractPaymentHTML('payment-success'));
  } 
  else if (req.url === '/payment-cancel' || req.url.startsWith('/payment-cancel?')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(extractPaymentHTML('payment-cancel'));
  }
  else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <title>Payment Pages - Live Preview</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              max-width: 800px;
              margin: 50px auto;
              padding: 20px;
              background: #f5f5f5;
            }
            h1 { color: #333; }
            .links {
              display: grid;
              gap: 15px;
              margin-top: 30px;
            }
            a {
              display: block;
              padding: 20px;
              background: white;
              border-radius: 10px;
              text-decoration: none;
              color: #667eea;
              font-size: 18px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              transition: transform 0.2s;
            }
            a:hover {
              transform: translateY(-2px);
              box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            }
            .note {
              background: #fffbea;
              padding: 15px;
              border-radius: 8px;
              border-left: 4px solid #f59e0b;
              margin-top: 20px;
            }
          </style>
        </head>
        <body>
          <h1>🎨 Payment Pages - Live Preview</h1>
          <p>Edit <code>cdk/lambda/index.js</code> and refresh to see changes instantly!</p>
          <div class="links">
            <a href="/payment-success?session_id=test123" target="_blank">
              ✅ Payment Success Page →
            </a>
            <a href="/payment-cancel" target="_blank">
              ❌ Payment Cancel Page →
            </a>
          </div>
          <div class="note">
            <strong>💡 Tip:</strong> Keep this page open. Edit the payment page HTML in 
            <code>cdk/lambda/index.js</code> (lines ~1315-1340), save, and refresh 
            the payment page to see changes live!
          </div>
        </body>
      </html>
    `);
  }
  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log('\n🚀 Live Development Server Running!\n');
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`\n📝 Edit cdk/lambda/index.js and refresh to see changes\n`);
  console.log('Press Ctrl+C to stop\n');
});
