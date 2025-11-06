const { SmartAPI } = require('./index');
const WebSocket = require('ws');

// --- Set your credentials here ---
const apiKey = 'dCsmvZgs';
const clientCode = 'AAAN050094';
const password = '7777';
const totp = '634212'; // Get this from your authenticator app

async function startWebSocket() {
    // Step 1: Generate session and get tokens
    const smart_api = new SmartAPI({ api_key: apiKey, client_code: clientCode });
    const sessionData = await smart_api.generateSession(clientCode, password, totp);

    if (!sessionData.status || !sessionData.data || !sessionData.data.feedToken) {
        console.error('Session generation failed:', sessionData.message);
        return;
    }

    const feedToken = sessionData.data.feedToken;
    const jwtToken = sessionData.data.jwtToken;

    // Step 2: Connect to WebSocket with authentication headers
    const ws = new WebSocket('wss://smartapisocket.angelone.in/smart-stream', {
        headers: {
            'x-api-key': apiKey,
            'x-client-code': clientCode,
            'x-feed-token': feedToken,
            'Authorization': `Bearer ${jwtToken}`
        }
    });

    ws.on('open', () => {
        console.log('WebSocket connection opened.');

        // Heartbeat every 30 seconds
        setInterval(() => {
            ws.send('ping');
        }, 30000);

        // Subscribe to LTP for NSE token 3045 (SBIN-EQ)
        const subscribeMsg = {
            correlationID: "abcde12345",
            action: 1, // 1 = Subscribe
            params: {
                mode: 1, // 1 = LTP, 2 = Quote, 3 = Snap Quote
                tokenList: [
                    {
                        exchangeType: 1, // 1 = NSE
                        tokens: ["3045"]  // Replace with your token(s)
                    }
                ]
            }
        };
        ws.send(JSON.stringify(subscribeMsg));
    });

    ws.on('message', (data) => {
        // Data is binary, you may need to decode it as per Angel One docs
        console.log('Received message:', data);
    });

    ws.on('pong', () => {
        console.log('Received pong (heartbeat response)');
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed.');
    });
}

startWebSocket();