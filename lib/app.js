const { SmartAPI, WebSocket, WebSocketClient, WebSocketV2, WSOrderUpdates } = require('./index'); // Imports from your index.js

const smart_api = new SmartAPI({
    api_key: "mgIvc18Y",
    client_code: "AAAN050094",
    // Optionally add: access_token, refresh_token, etc.
});

// Replace 'YOUR_PASSWORD' and 'YOUR_TOTP' with your actual password and current TOTP code from your authenticator app
smart_api.generateSession('AAAN050094', '7777', '298115')
    .then((data) => {
        console.log('Session Data:', data);
        if (data.status) {
            // Only fetch profile if session is successful
            return smart_api.getProfile();
        } else {
            throw new Error(data.message || 'Session generation failed');
        }
    })
    .then((profile) => {
        console.log('Profile:', profile);
    })
    .catch((err) => {
        console.error('Error:', err.message || err);
    });