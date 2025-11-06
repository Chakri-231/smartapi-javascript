const { SmartAPI } = require('smartapi-javascript'); 
const WebSocket = require('ws'); // Required by the SDK

// ====================================================================
// --- 🔑 USER CREDENTIALS & CONFIGURATION ---
// IMPORTANT: Replace these dummy values with your actual data.
// ====================================================================
const apiKey = 'dCsmvZgs';
const clientCode = 'AAAN050094';
const password = '7777';    
// TOTP value has been updated
const totp = '808906';    
const MAX_SYMBOLS = 3; // Monitoring the top 3 gainers

// Global state variables
let smart_api = null;
// Stores { token: { exchange, tradingSymbol } } for all symbols to track
let tokenCache = new Map(); 

// Polling intervals
const GAINERS_POLL_INTERVAL_MS = 1 * 60 * 1000; // 3 minutes: List refresh interval
// CRITICAL: The alert check is now based on a 1-minute interval
const MARKET_DATA_POLL_INTERVAL_MS = 0.01 * 60 * 1000; // 1 minute: Alert check interval

// --- CANDLE ANALYSIS CONFIGURATION ---
// Define what a "thick" candle body means: 
// 0.05% move from Open price to LTP is considered strong momentum.
// This threshold is set lower for better sensitivity across different stocks.
const CANDLE_THICKNESS_PERCENT_THRESHOLD = 0.05; 

// ====================================================================
// --- CORE ALERT LOGIC: CANDLE BODY ANALYSIS (LTP vs OPEN) ---
// ====================================================================

/**
 * Compares the current LTP against the current candle's Open Price 
 * to identify "thick" bullish or bearish candle formation.
 * @param {string} symbol The trading symbol (e.g., RELIANCE-EQ)
 * @param {string} exchange The exchange (NSE or NFO)
 * @param {number} openPrice The open price of the current 1-minute candle
 * @param {number} ltp The Latest Traded Price (live data, effectively the candle's current price)
 */
function checkCandleBodyAndAlert(symbol, exchange, openPrice, ltp) {
    const parsedOpen = parseFloat(openPrice);
    const parsedLtp = parseFloat(ltp);

    if (isNaN(parsedOpen) || parsedOpen <= 0) {
        console.log(`⚠️ WARNING: Cannot check candle body for ${symbol}. Open price is invalid or missing.`);
        return;
    }
    
    // Calculate the raw price difference (Candle Body Size)
    const diff = parsedLtp - parsedOpen;
    
    // Calculate the percentage move relative to the Open price
    const percentDiff = (diff / parsedOpen) * 100;

    // Check if the candle body is "thick" (meets the minimum percentage move)
    if (Math.abs(percentDiff) >= CANDLE_THICKNESS_PERCENT_THRESHOLD) {
        
        if (diff > 0) {
            // Thick Green Bullish Candle (LTP > Open)
            console.log(`\n🔥🔥🚨 CANDLE ALERT: [${exchange}] 🟢 **THICK BULLISH CANDLE** for ${symbol}!`);
            console.log(`> Body Size: +${diff.toFixed(2)} (${percentDiff.toFixed(2)}%). LTP: ${parsedLtp} | Open: ${parsedOpen}`);
            
        } else {
            // Thick Red Bearish Candle (LTP < Open)
            // This is the condition for a thick bearish candle!
            console.log(`\n🔥🔥🚨 CANDLE ALERT: [${exchange}] 🔴 **THICK BEARISH CANDLE** for ${symbol}!`);
            console.log(`> Body Size: ${diff.toFixed(2)} (${percentDiff.toFixed(2)}%). LTP: ${parsedLtp} | Open: ${parsedOpen}`);
        }
        
    } else {
        // Candle body is too thin to trigger an alert, but logging for reference
        // console.log(`\n[${symbol}] Momentum Check: Body too thin (${percentDiff.toFixed(2)}% < ${CANDLE_THICKNESS_PERCENT_THRESHOLD}% threshold).`);
    }
}


// ====================================================================
// --- TOKEN LOOKUP AND LIST REFRESH (3-MINUTE POLLING) ---
// ====================================================================

/**
 * Extracts the root symbol (e.g., 'TATASTEEL') from an F&O trading symbol.
 */
function getRootSymbol(foSymbol) {
    // Splits the symbol at the first occurrence of a number (to handle dates like 25NOV25)
    return foSymbol.split(/[0-9]/)[0]; 
}


/**
 * Searches for the NSE Equity token corresponding to an F&O symbol.
 */
async function findNSEEquityToken(foSymbol) {
    const rootSymbol = getRootSymbol(foSymbol);
    
    try {
        const response = await smart_api.searchScrip({
            "exchange": "NSE", 
            "searchScrip": rootSymbol
        });

        if (response.data && response.data.length > 0) {
            // Find the exact NSE Equity scrip
            const equityScrip = response.data.find(
                scrip => scrip.instrumenttype === 'EQ' && scrip.tradingsymbol.startsWith(rootSymbol)
            );

            if (equityScrip) {
                return { 
                    token: equityScrip.symboltoken, 
                    tradingSymbol: equityScrip.tradingsymbol, 
                    exchange: 'NSE' 
                };
            }
        }
    } catch (error) {
        console.error(`      -> Error searching for NSE Equity token for ${rootSymbol}:`, error.message);
    }
    return null;
}

/**
 * Fetches Top N Price Gainers, finds their NSE equivalents, and updates the global cache.
 */
async function pollTopGainersAndTokens() {
    console.log(`\n[${new Date().toLocaleTimeString()}] --- 🥇 POLLING: Refreshing Top ${MAX_SYMBOLS} Gainers List ---`);
    if (!smart_api) return;

    try {
        // Fetch top gainers (F&O segment, Price Gainers)
        const params = { "datatype": "PercPriceGainers", "expirytype": "NEAR" };
        const response = await smart_api.gainersLosers(params); 
        
        if (!response.status || !response.data || response.data.length === 0) {
            console.log('No Top Gainers data available in API response.');
            return;
        }

        const newTopGainers = response.data.slice(0, MAX_SYMBOLS);
        const newCache = new Map();

        for (const gainer of newTopGainers) {
            // 1. Store NFO Token
            newCache.set(gainer.symbolToken, {
                exchange: 'NFO', 
                tradingSymbol: gainer.tradingSymbol,
            });

            // 2. Find and store NSE Equity Token
            const nseScrip = await findNSEEquityToken(gainer.tradingSymbol);
            if (nseScrip) {
                newCache.set(nseScrip.token, {
                    ...nseScrip,
                });
            }
        }

        // Update global cache
        tokenCache = newCache;
        console.log(`✅ CACHE UPDATED: ${tokenCache.size} total tokens (NFO Futures + NSE Equity) stored.`);

    } catch (error) {
        console.error('❌ Error fetching Top Gainers and tokens:', error.message);
    }
}

// ====================================================================
// --- MARKET DATA FETCH AND ALERT (1-MINUTE POLLING) ---
// ====================================================================

/**
 * Prepares the token configuration, fetches live market data, and triggers alerts.
 */
async function pollMarketDataAndAlerts() {
    if (tokenCache.size === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] --- 🕯️ IDLE: Waiting for Top Gainers list to be populated...`);
        return;
    }

    console.log(`\n[${new Date().toLocaleTimeString()}] --- 📊 POLLING: Fetching live data for ${tokenCache.size} stocks and checking 1-minute candle body...`);

    const tokensByExchange = { NSE: [], NFO: [] }; 
    const symbolLookup = {};

    for (const [token, data] of tokenCache.entries()) {
        const exchange = data?.exchange; 
        
        if (exchange === 'NSE' || exchange === 'NFO') {
            tokensByExchange[exchange].push(token);
            symbolLookup[token] = { exchange: exchange, tradingSymbol: data.tradingSymbol };
        } else {
            console.warn(`[CACHE WARNING] Skipping token ${token} due to invalid or unexpected exchange value: ${exchange}`);
        }
    }

    const exchangeTokens = {};
    if (tokensByExchange.NSE.length > 0) exchangeTokens.NSE = tokensByExchange.NSE;
    // --- FIX APPLIED HERE: Changed tokensTokensByExchange to tokensByExchange ---
    if (tokensByExchange.NFO.length > 0) exchangeTokens.NFO = tokensByExchange.NFO;
    
    if (Object.keys(exchangeTokens).length === 0) {
        console.log("No valid tokens to monitor after filtering.");
        return;
    }
    
    try {
        // 1. Fetch all Live Market Data (LTP and OPEN price are required) in one bulk call
        const quoteParams = { 
            "mode": "FULL", 
            "exchangeTokens": exchangeTokens 
        };
        const response = await smart_api.marketData(quoteParams); 
        
        if (response.status && response.data && response.data.fetched && response.data.fetched.length > 0) {
            console.log(`✅ Fetched live data for ${response.data.fetched.length} symbols. Running candle body analysis...`);
            
            // 2. Process data and run the alert for each symbol concurrently
            await Promise.all(response.data.fetched.map(async (data) => {
                const metadata = symbolLookup[data.symbolToken];
                
                // We need both open and ltp to determine the candle's body size and color
                if (metadata && data.open && data.ltp) {
                    
                    // 🚨 RUN CANDLE BODY ALERT LOGIC (LTP vs. Open Price)
                    checkCandleBodyAndAlert(
                        data.tradingSymbol, 
                        metadata.exchange,
                        data.open, // The Open price of the current candle
                        data.ltp   // The current price (LTP)
                    );
                } else {
                     console.log(`[${metadata.tradingSymbol}] Skipping candle check due to missing Open or LTP data.`);
                }
            }));
            
        } else {
            console.error('❌ Error fetching Live Market Data:', response.message || 'No data fetched.');
        }
    } catch (error) {
        console.error('❌ Exception during Market Data Polling:', error.message);
    }
}


// ====================================================================
// --- 🚀 MAIN EXECUTION FLOW ---
// ====================================================================

async function executeSmartAPIActions() {
    console.log('Starting SmartAPI Dynamic Market Scanner...');
    
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
    await pollTopGainersAndTokens();
    await pollMarketDataAndAlerts(); 

    // 4. Set up the timed intervals
    console.log('\n--- ⏱️ STRATEGY ACTIVATED ---');
    console.log(`> Top Gainers List: Refreshed every ${GAINERS_POLL_INTERVAL_MS / 60000} minutes.`);
    console.log(`> Live Data/Alert Check: Refreshed every ${MARKET_DATA_POLL_INTERVAL_MS / 60000} minute (Thick Candle Check).`);

    // Start 3-minute poll for gainers list (which also finds NSE tokens)
    setInterval(pollTopGainersAndTokens, GAINERS_POLL_INTERVAL_MS);

    // Start 1-minute poll for market data and alerts
    setInterval(pollMarketDataAndAlerts, MARKET_DATA_POLL_INTERVAL_MS);
}

// Execute the main process
executeSmartAPIActions();