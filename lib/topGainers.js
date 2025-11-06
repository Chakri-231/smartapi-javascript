const { SmartAPI } = require('smartapi-javascript'); 
const WebSocket = require('ws');

// ====================================================================
// --- 🔑 CONFIGURATION & GLOBAL STATE ---
// ====================================================================
const apiKey = 'dCsmvZgs';
const clientCode = 'AAAN050094';
const password = '7777';    
const totp = '767727';     

let smart_api = null;
// Stores { token: { exchange, tradingSymbol } } - Note: LTP is no longer stored here for the candle check, 
// as we fetch the latest LTP from the candle data.
let topGainersCache = new Map(); 

const GAINERS_POLL_INTERVAL_MS = 2 * 60 * 1000; // 3 minutes: List refresh interval
const CANDLE_POLL_INTERVAL_MS = 1 * 60 * 1000; // 1 minute: Alert check interval

// ====================================================================
// --- CORE ALERT LOGIC (REFINED) ---
// ====================================================================

/**
 * Compares the current price (LTP/Close) against the Day's Open price 
 * to determine if the stock is currently making a bullish or bearish candle relative to the start of the day.
 * * @param {string} symbol The trading symbol (e.g., RELIANCE)
 * @param {number} open The Day's Open price (extracted from the first candle)
 * @param {number} ltp The Latest Traded Price (extracted from the last candle's close)
 */
function checkCandleStatusAndAlert(symbol, open, ltp) {
    if (open === undefined || open === null) {
        console.log(`⚠️ ALERT: Cannot determine trend for ${symbol}. Day's Open price is missing.`);
        return;
    }
    
    const diff = (ltp - open).toFixed(2);
    const percentDiff = ((diff / open) * 100).toFixed(2);

    if (ltp > open) {
        console.log(`\n🚨 ALERT: 🟢 **BULLISH CANDLE** for ${symbol}! Price is UP ${diff} (${percentDiff}%).`);
        console.log(`> Close (${ltp}) > Day's Open (${open})`);
    } else if (ltp < open) {
        console.log(`\n🚨 ALERT: 🔴 **BEARISH CANDLE** for ${symbol}! Price is DOWN ${diff} (${percentDiff}%).`);
        console.log(`> Close (${ltp}) < Day's Open (${open})`);
    } else {
        console.log(`\n🚨 ALERT: ⚫ **INDECISION CANDLE** for ${symbol}! Close equals Day's Open.`);
        console.log(`> Close (${ltp}) = Day's Open (${open})`);
    }
}

// ====================================================================
// --- 3-MINUTE POLLING FUNCTION ---
// ====================================================================

/**
 * Fetches Top 10 Price Gainers and updates the global cache.
 */
async function pollTopGainers() {
    console.log(`\n[${new Date().toLocaleTimeString()}] --- 🥇 POLLING: Refreshing Top 10 Price Gainers ---`);
    if (!smart_api) return;

    try {
        const params = { "datatype": "PercPriceGainers", "expirytype": "NEAR" };
        const response = await smart_api.gainersLosers(params); 
        
        if (!response.status || !response.data || response.data.length === 0) {
            console.log('No Top Gainers data available in API response.');
            return;
        }

        const topGainers = response.data.slice(0, 3);
        
        // Clear old cache and populate with new top gainers (We only store metadata needed for the candle call)
        topGainersCache.clear();
        topGainers.forEach(gainer => {
            topGainersCache.set(gainer.symbolToken, {
                exchange: gainer.exchange,
                tradingSymbol: gainer.tradingSymbol,
            });
        });

        console.log(`✅ CACHE UPDATED: ${topGainersCache.size} top gainer tokens stored.`);

    } catch (error) {
        console.error('❌ Error fetching Top Gainers:', error.message);
    }
}

// ====================================================================
// --- 1-MINUTE POLLING FUNCTION ---
// ====================================================================

/**
 * Fetches the candle data for all cached tokens and sends alerts.
 */
async function pollCandlesAndAlerts() {
    if (topGainersCache.size === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] --- 🕯️ IDLE: Waiting for Top Gainers list...`);
        return;
    }

    console.log(`\n[${new Date().toLocaleTimeString()}] --- 🕯️ POLLING: Fetching candles for ${topGainersCache.size} stocks...`);

    // Iterate through all tokens in the cache
    for (const [token, data] of topGainersCache.entries()) {
        // Only pass the metadata needed to fetch the candle data
        await getCandleDataAndAlert(token, data.exchange, data.tradingSymbol);
    }
}


/**
 * Core function to fetch candle data, extract Day's Open, and run the alert.
 * * @param {string} token The symbol token for the API call
 * @param {string} exchange The exchange (e.g., NSE)
 * @param {string} tradingSymbol The trading symbol (e.g., RELIANCE)
 */
async function getCandleDataAndAlert(token, exchange, tradingSymbol) {
    // Helper to format date as YYYY-MM-DD HH:MM:SS (API requirement)
    const formatDate = (date) => 
        date.toISOString().slice(0, 19).replace('T', ' ');

    const today = new Date();
    const endTime = formatDate(today);

    // Set start time to today 09:15 IST (Market Open)
    const startTime = new Date(today);
    startTime.setHours(9, 15, 0, 0); 
    const fromdate = formatDate(startTime);
    
    try {
        const candleParams = {
            "exchange": exchange, 
            "symboltoken": token,
            "interval": "ONE_MINUTE",
            "fromdate": fromdate, 
            "todate": endTime 
        };
        
        const response = await smart_api.getCandleData(candleParams);
        console.log(`Fetched candle data for ${tradingSymbol}:`, response);
        
        if (response.status && response.data && response.data.length > 0) {
            // Candle data array structure: [timestamp, open, high, low, close, volume]
            const dayOpen = response.data[0][1]; // Index 1 of the first candle is the Day's Open price
            
            const latestCandle = response.data.slice(-1)[0];
            // *** FIX: Use the close price (Index 4) of the latest candle as the current LTP ***
            const latestLTP = latestCandle[4]; 
            
            console.log(`--- **${tradingSymbol}** (LTP: ${latestLTP}) ---`);
            console.log(`> Day's Open: ${dayOpen} | Latest Candle Time: ${latestCandle[0]}`);
            
            // Run the alert logic with the reliable 'dayOpen' value and the fresh 'latestLTP'
            checkCandleStatusAndAlert(tradingSymbol, dayOpen, latestLTP);

        } else {
            console.log(`--- **${tradingSymbol}** ---`);
            console.log(`❌ No candle data found for historical range. Cannot determine Day's Open or LTP.`);
        }
        
    } catch (error) {
        // You might still get errors if the token/exchange combo is bad or if the time is outside market hours
        console.error(`❌ Exception fetching candle data for ${tradingSymbol}:`, error.message);
    }
}

// ====================================================================
// --- 🚀 MAIN EXECUTION FLOW ---
// ====================================================================

async function executeSmartAPIActions() {
    console.log('Starting SmartAPI process...');
    
    // 1. Initialize SmartAPI object
    smart_api = new SmartAPI({ api_key: apiKey });

    // 2. Generate Session (Login)
    const sessionData = await smart_api.generateSession(clientCode, password, totp);

    if (!sessionData.status || !sessionData.data || !sessionData.data.feedToken) {
        console.error('❌ Session generation failed. Please check credentials or TOTP.');
        return;
    }

    console.log('✅ Session generated successfully. JWT Token acquired.');
    
    // 3. Initial fetch immediately for both list and alerts
    await pollTopGainers();
    await pollCandlesAndAlerts(); // Run initial alert check after the list is populated

    // 4. Set up the timed intervals
    console.log('\n--- ⏱️ STRATEGY ACTIVATED ---');
    console.log(`> Top Gainers List: Refreshed every ${GAINERS_POLL_INTERVAL_MS / 1000 / 60} minutes.`);
    console.log(`> Candle/Alert Check: Refreshed every ${CANDLE_POLL_INTERVAL_MS / 1000 / 60} minute.`);

    // Start 3-minute poll for gainers list
    setInterval(pollTopGainers, GAINERS_POLL_INTERVAL_MS);

    // Start 1-minute poll for candle data and alerts
    setInterval(pollCandlesAndAlerts, CANDLE_POLL_INTERVAL_MS);
}

// Execute the main process
executeSmartAPIActions();