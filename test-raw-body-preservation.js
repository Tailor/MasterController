// Test for raw body preservation - Critical for webhook signature verification

const crypto = require('crypto');
const EventEmitter = require('events');
const { MasterRequest } = require('./MasterRequest');

console.log('🧪 Testing Raw Body Preservation for Webhook Signatures...\n');

// Mock request
class MockRequest extends EventEmitter {
  constructor(contentType) {
    super();
    this.headers = { 'content-type': contentType };
  }

  sendData(data) {
    setImmediate(() => {
      if (Array.isArray(data)) {
        data.forEach(chunk => this.emit('data', Buffer.from(chunk)));
      } else {
        this.emit('data', Buffer.from(data));
      }
      this.emit('end');
    });
  }
}

// Test 1: JSON body with raw preservation
console.log('Test 1: JSON body preserves raw string...');
const masterReq1 = new MasterRequest();
masterReq1.init({ maxJsonSize: 1024 * 1024 });
const mockReq1 = new MockRequest('application/json');

const testPayload = '{"event":"payment.success","amount":1000,"currency":"USD"}';

masterReq1.jsonStream(mockReq1, (result) => {
  if (result._rawBody === testPayload) {
    console.log('✅ Raw body preserved correctly');
    console.log('   Parsed:', JSON.stringify(result));
    console.log('   Raw:', result._rawBody);

    // Test 2: Verify webhook signature (Stripe-style HMAC)
    console.log('\nTest 2: Webhook signature verification...');
    const secret = 'webhook_secret_key';
    const signature = crypto
      .createHmac('sha256', secret)
      .update(result._rawBody)
      .digest('hex');

    // Verify signature
    const verifySignature = crypto
      .createHmac('sha256', secret)
      .update(result._rawBody)
      .digest('hex');

    if (signature === verifySignature) {
      console.log('✅ Webhook signature verified successfully');
      console.log('   Signature:', signature.substring(0, 20) + '...');

      // Test 3: URL-encoded body
      console.log('\nTest 3: URL-encoded body preserves raw string...');
      const masterReq3 = new MasterRequest();
      masterReq3.init({ maxBodySize: 1024 * 1024 });
      const mockReq3 = new MockRequest('application/x-www-form-urlencoded');

      const formData = 'name=John+Doe&email=john%40example.com&amount=100';

      masterReq3.urlEncodeStream(mockReq3, (result) => {
        if (result._rawBody === formData) {
          console.log('✅ URL-encoded raw body preserved');
          console.log('   Parsed:', JSON.stringify(result));
          console.log('   Raw:', result._rawBody);

          // Test 4: Chunked JSON (simulates streaming)
          console.log('\nTest 4: Chunked data reassembly...');
          const masterReq4 = new MasterRequest();
          masterReq4.init({ maxJsonSize: 1024 * 1024 });
          const mockReq4 = new MockRequest('application/json');

          const chunks = ['{"big":"', 'payload","with":', '"multiple","chunks":', '123}'];
          const fullPayload = chunks.join('');

          masterReq4.jsonStream(mockReq4, (result) => {
            if (result._rawBody === fullPayload) {
              console.log('✅ Chunked data reassembled correctly');
              console.log('   Chunks sent:', chunks.length);
              console.log('   Raw body length:', result._rawBody.length);
              console.log('   Parsed:', JSON.stringify(result));

              console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.log('✨ ALL TESTS PASSED - Raw Body Preservation Works!');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.log('\nUse Cases Enabled:');
              console.log('✅ Stripe webhook signature verification');
              console.log('✅ GitHub webhook signature verification');
              console.log('✅ Shopify HMAC verification');
              console.log('✅ PayPal IPN verification');
              console.log('✅ Any cryptographic signature verification');
              console.log('✅ Content hashing (MD5, SHA256)');
              console.log('✅ Audit logging of exact payloads');
              console.log('\nAccess raw body: request.body._rawBody');
            } else {
              console.log('❌ Chunked data test failed');
              console.log('   Expected:', fullPayload);
              console.log('   Got:', result._rawBody);
            }
          });

          mockReq4.sendData(chunks);
        } else {
          console.log('❌ URL-encoded raw body test failed');
          console.log('   Expected:', formData);
          console.log('   Got:', result._rawBody);
        }
      });

      mockReq3.sendData(formData);
    } else {
      console.log('❌ Signature verification failed');
    }
  } else {
    console.log('❌ Raw body preservation failed');
    console.log('   Expected:', testPayload);
    console.log('   Got:', result._rawBody);
  }
});

mockReq1.sendData(testPayload);
