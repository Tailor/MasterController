// Test for JSON parsing bug fix - empty body on GET requests

const http = require('http');
const EventEmitter = require('events');

console.log('🧪 Testing MasterRequest jsonStream with empty body...\n');

// Load MasterRequest
const { MasterRequest } = require('./MasterRequest');

// Create mock request with empty body (simulates GET request)
class MockRequest extends EventEmitter {
  constructor() {
    super();
    this.headers = {
      'content-type': 'application/json'
    };
  }

  simulateEmptyBody() {
    // Simulate empty body - no data events, just end
    setImmediate(() => {
      this.emit('end');
    });
  }
}

// Test 1: Empty body should not throw error
console.log('Test 1: Empty body (GET request scenario)...');
const masterRequest1 = new MasterRequest();
masterRequest1.init({ maxJsonSize: 1024 * 1024 });
const mockReq1 = new MockRequest();

masterRequest1.jsonStream(mockReq1, (result) => {
  if (result && typeof result === 'object' && !result.error) {
    console.log('✅ Empty body handled correctly');
    console.log('   Result:', JSON.stringify(result));

    // Test 2: Valid JSON body
    console.log('\nTest 2: Valid JSON body...');
    const masterRequest2 = new MasterRequest();
    masterRequest2.init({ maxJsonSize: 1024 * 1024 });
    const mockReq2 = new MockRequest();

    masterRequest2.jsonStream(mockReq2, (result) => {
      if (result && result.name === 'test' && result.value === 123) {
        console.log('✅ Valid JSON parsed correctly');
        console.log('   Result:', JSON.stringify(result));

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✨ ALL TESTS PASSED');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('\nFix verified:');
        console.log('✅ Empty body returns {} instead of throwing error');
        console.log('✅ Valid JSON still parses correctly');
        console.log('✅ No more "Unexpected end of JSON input" errors on GET requests');
      } else {
        console.log('❌ Valid JSON parsing failed');
        console.log('   Result:', JSON.stringify(result));
      }
    });

    // Simulate valid JSON body
    setImmediate(() => {
      mockReq2.emit('data', Buffer.from('{"name":"test","value":123}'));
      mockReq2.emit('end');
    });

  } else {
    console.log('❌ Empty body test failed');
    console.log('   Result:', JSON.stringify(result));
  }
});

// Start test
mockReq1.simulateEmptyBody();
