const { SmartAPI } = require('smartapi-javascript'); 
const WebSocket = require('ws');

// ====================================================================
// --- 🔑 USER CREDENTIALS & CONFIGURATION ---
// IMPORTANT: Replace these dummy values with your actual data.
// ====================================================================
const apiKey = 'dCsmvZgs';
const clientCode = 'AAAN050094';
const password = '7777';    
const totp = '376044';     

// Configuration for Live Market Data API
const MARKET_DATA_TOKENS = {
    "mode": "FULL", 
    "exchangeTokens": {
        "NSE": ["46470", "49057"], // SBIN, DRREDDY
        "NFO": ["49057", "46470"] // NIFTY Option
    }
};

// ====================================================================
// --- 🚀 MAIN EXECUTION FLOW ---
// ====================================================================

async function executeSmartAPIActions() {
    console.log('Starting SmartAPI process...');
    
    // 1. Initialize SmartAPI object
    const smart_api = new SmartAPI({ api_key: apiKey });

    // 2. Generate Session (Login)
    const sessionData = await smart_api.generateSession(clientCode, password, totp);

    if (!sessionData.status || !sessionData.data || !sessionData.data.feedToken) {
        console.error('❌ Session generation failed:', sessionData.message, sessionData.errorcode);
        return;
    }

    const { feedToken, jwtToken } = sessionData.data;
    console.log('✅ Session generated successfully. JWT Token acquired.');
    
    // --- REST API CALLS ---
    await getLiveMarketData(smart_api); // Fetches general market data & checks alerts
    

    // --- WEBSOCKET CONNECTION ---
    // Disabled startWebSocket(apiKey, clientCode, feedToken, jwtToken);
}

// ====================================================================
// --- CORE ALERT LOGIC ---
// ====================================================================

/**
 * Checks the current candle status (LTP vs Open) and prints an alert.
 * @param {string} symbol The trading symbol (e.g., 'SBIN-EQ').
 * @param {number} open The day's Open price.
 * @param {number} ltp The Last Traded Price (current Close price).
 */
function checkCandleStatusAndAlert(symbol, open, ltp) {
    const diff = (ltp - open).toFixed(2);

    if (ltp > open) {
        // BULLISH ALERT (Green/White Candle)
        console.log(`\n🚨 ALERT: 🟢 BULLISH CANDLE for ${symbol}! Price is UP ${diff}.`);
        console.log(`> Close (${ltp}) > Open (${open})`);
        // *** Implement your external alert (SMS/Email) here ***
    } else if (ltp < open) {
        // BEARISH ALERT (Red/Black Candle)
        console.log(`\n🚨 ALERT: 🔴 BEARISH CANDLE for ${symbol}! Price is DOWN ${diff}.`);
        console.log(`> Close (${ltp}) < Open (${open})`);
        // *** Implement your external alert (SMS/Email) here ***
    } else {
        // INDECISION ALERT (Doji/Equal State)
        console.log(`\n🚨 ALERT: ⚫ INDECISION CANDLE for ${symbol}! Close equals Open.`);
        console.log(`> Close (${ltp}) = Open (${open})`);
        // *** Implement your external alert (SMS/Email) here ***
    }
}


// ====================================================================
// --- REST API FUNCTIONS ---
// ====================================================================

/**
 * Calls the Live Market Data API in FULL mode and displays comprehensive details.
 * NOW INCLUDES CANDLE ALERT LOGIC.
 */
async function getLiveMarketData(smart_api) {
    console.log('\n--- 📊 Live Market Data (FULL Mode) ---');
    try {
        const quoteParams = MARKET_DATA_TOKENS;
        const response = await smart_api.marketData(quoteParams); 
        
        if (response.status && response.data && response.data.fetched && response.data.fetched.length > 0) {
            console.log(`✅ Fetched ${response.data.fetched.length} symbols successfully.`);
            
            // Loop through all fetched symbols
            response.data.fetched.forEach(data => {
                console.log('\n--- 📝 Symbol Details: ' + data.tradingSymbol + ' ---');
                
                // 1. Core Price and Status
                console.log(`- Last Traded Price (LTP): ${data.ltp}`);
                console.log(`- % Change: ${data.percentChange}% (Net Change: ${data.netChange})`);
                console.log(`- Open/High/Low/Close: ${data.open} / ${data.high} / ${data.low} / ${data.close}`);
                console.log(`- 52 Week Range: L:${data['52WeekLow']} | H:${data['52WeekHigh']}`);
                
                // 🚨 NEW: CHECK CANDLE STATUS AND ALERT
                checkCandleStatusAndAlert(data.tradingSymbol, data.open, data.ltp);

                // 2. Volume and Limits
                console.log(`\n- Volume: ${data.tradeVolume} | Open Interest (OI): ${data.opnInterest}`);
                console.log(`- Circuit Limits: Lower: ${data.lowerCircuit} | Upper: ${data.upperCircuit}`);
                console.log(`- Total Buy/Sell Qty: B:${data.totBuyQuan} | S:${data.totSellQuan}`);

                // 3. Exchange Time
                console.log(`- Exchange Time: ${data.exchFeedTime}`);

                // 4. Market Depth (The 'Full' detail)
                if (data.depth) {
                    console.log('--- 🛒 Market Depth (Best 5 Orders) ---');
                    
                    const depthInfo = data.depth.buy.map((buy, index) => ({
                        'Buy Price': buy.price,
                        'Buy Qty': buy.quantity,
                        'Sell Price': data.depth.sell[index]?.price,
                        'Sell Qty': data.depth.sell[index]?.quantity,
                    }));

                    console.log(`| Buy Price | Buy Qty | Sell Price | Sell Qty |`);
                    console.log(`|---|---|---|---|`);
                    depthInfo.forEach(item => {
                        console.log(`| ${item['Buy Price']} | ${item['Buy Qty']} | ${item['Sell Price']} | ${item['Sell Qty']} |`);
                    });
                }
            });
            
        } else {
            console.error('❌ Error fetching Live Market Data:', response.message || 'No data fetched.');
        }
    } catch (error) {
        console.error('❌ Exception fetching Live Market Data:', error.message);
    }
}

/**
 * Calls Top Gainers/Losers, PCR, and OI BuildUp APIs (Updated OI function call).
 * Returns the symbolToken of the top OI Long Built Up gainer.
 */
async function getDerivativesMarketData(smart_api) {
    console.log('\n--- 📈 Derivatives Data (Gainers/PCR/OI) ---');
    
    // 1. Top OI Gainers (General)
    try {
        const params = { "datatype": "PercOIGainers", "expirytype": "NEAR" };
        const response = await smart_api.gainersLosers(params); 
        console.log(`✅ Top OI Gainers: ${response.data[0].tradingSymbol} at ${response.data[0].percentChange}%`);
    } catch (error) {
        console.error('❌ Error fetching Top Gainers/Losers (PercOIGainers):', error.message);
    }

    // 2. PCR Volume
    try {
        const response = await smart_api.putCallRatio(); 
        const niftyPCR = response.data.find(d => d.tradingSymbol.includes('NIFTY'));
        console.log(`✅ NIFTY PCR: ${niftyPCR ? niftyPCR.pcr : 'N/A'}`);
    } catch (error) {
        console.error('❌ Error fetching PCR:', error.message);
    }

    // 3. OI BuildUp (Long Built Up) - Target for next step
    try {
        const params = { "expirytype": "NEAR", "datatype": "Long Built Up" };
        // FIX: Using 'getOIBuildup' (the last logical function name attempt)
        const response = await smart_api.getOIBuildup(params); 
        
        if (response.data && response.data.length > 0) {
            const topOIGainer = response.data[0];
            console.log(`✅ Top Long Built Up: ${topOIGainer.tradingSymbol} (LTP: ${topOIGainer.ltp})`);
            return topOIGainer.symbolToken; // RETURN THE TOKEN
        } else if(response.status === false) {
            console.error('❌ Error fetching OI BuildUp (Long Built Up):', response.message);
        }
    } catch (error) {
        console.error('❌ Exception fetching OI BuildUp (Long Built Up):', error.message);
    }
    return null;
}

/**
 * Fetches the 1-minute candle data for a given token (the Top Gainer).
 */
async function getTopGainerCandleData(smart_api, token) {
    console.log(`\n--- 🕯️ Fetching 1-Minute Candle Data for Token ${token} ---`);
    
    // Calculate dynamic dates for the last few hours of trading
    // Set start time to today 09:15 for the start of market
    const today = new Date();
    const startTime = new Date(today);
    startTime.setHours(9, 15, 0, 0); 
    
    const endTime = new Date(today);
    
    // Format dates as required: YYYY-MM-DD HH:MM
    const formatDate = (date) => 
        date.toISOString().slice(0, 10) + ' ' + 
        date.toTimeString().slice(0, 5);

    const fromdate = formatDate(startTime);
    const todate = formatDate(endTime);
    
    try {
        const candleParams = {
            "exchange": "NFO", // Derivatives (Futures/Options) are on NFO or NSE. We assume NFO here.
            "symboltoken": token,
            "interval": "ONE_MINUTE",
            "fromdate": fromdate, 
            "todate": todate 
        };
        
        // The SDK method for the historical API is typically 'getCandleData'
        const response = await smart_api.getCandleData(candleParams);
        
        if (response.status && response.data && response.data.length > 0) {
            console.log(`✅ Latest Candle Data (1 Min):`);
            // The response data is an array of arrays: [timestamp, open, high, low, close, volume]
            const latestCandle = response.data.slice(-1)[0];
            console.log(`> Candle Time: ${latestCandle[0]}`);
            console.log(`> OHLCV: [O:${latestCandle[1]}, H:${latestCandle[2]}, L:${latestCandle[3]}, C:${latestCandle[4]}, V:${latestCandle[5]}]`);
        } else {
            console.log('No candle data found for the top gainer in the specified range.');
        }
        
    } catch (error) {
        console.error('❌ Error fetching candle data:', error.message);
    }
}


// Execute the main process
executeSmartAPIActions();