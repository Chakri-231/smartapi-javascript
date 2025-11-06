const { SmartAPI } = require('./index');
const axios = require('axios');
const address = require('address');
const publicIp = require('public-ip');

const api_key = 'dCsmvZgs ';
const client_code = 'AAAN050094';
const password = '7777';
const totp = '132889'; // Get this from your authenticator app

async function getNetworkInfo() {
    return new Promise((resolve) => {
        address(async (err, addrs) => {
            const local_ip = addrs?.ip || '192.168.1.1';
            const mac_addr = addrs?.mac || '00:00:00:00:00:00';
            const pub_ip = await publicIp.v4();
            resolve({ local_ip, mac_addr, pub_ip });
        });
    });
}

async function fetchHistoricalData() {
    try {
        // Step 1: Get network info
        const { local_ip, mac_addr, pub_ip } = await getNetworkInfo();

        // Step 2: Generate session and get JWT token
        const smart_api = new SmartAPI({ api_key, client_code });
        const sessionData = await smart_api.generateSession(client_code, password, totp);

        if (!sessionData.status || !sessionData.data || !sessionData.data.jwtToken) {
            throw new Error(sessionData.message || 'Session generation failed');
        }
        const jwt_token = sessionData.data.jwtToken;

        // Step 3: Prepare request bodies
        const candleBody = {
            exchange: "NSE",
            symboltoken: "3045", // Example: SBIN-EQ
            interval: "ONE_MINUTE",
            fromdate: "2021-02-08 09:00",
            todate: "2021-02-08 09:16"
        };

        const oiBody = {
            exchange: "NFO",
            symboltoken: "46823", // Example token
            interval: "THREE_MINUTE",
            fromdate: "2024-06-07 09:15",
            todate: "2024-06-07 15:30"
        };

        // Step 4: Set headers
        const headers = {
            'X-PrivateKey': api_key,
            'Accept': 'application/json',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': local_ip,
            'X-ClientPublicIP': pub_ip,
            'X-MACAddress': mac_addr,
            'X-UserType': 'USER',
            'Authorization': `Bearer ${jwt_token}`,
            'Content-Type': 'application/json'
        };

        // Step 5: Fetch candle data
        const candleRes = await axios.post(
            'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData',
            candleBody,
            { headers }
        );
        console.log('Candle Data:', JSON.stringify(candleRes.data, null, 2));

        // Step 6: Fetch OI data
        const oiRes = await axios.post(
            'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getOIData',
            oiBody,
            { headers }
        );
        console.log('OI Data:', JSON.stringify(oiRes.data, null, 2));

    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
    }
}

fetchHistoricalData();