const { SmartAPI } = require('smartapi-javascript'); 
const WebSocket = require('ws'); // Required by the SDK

// ====================================================================
// --- 🔑 USER CREDENTIALS & CONFIGURATION ---
// IMPORTANT: Replace these dummy values with your actual data.
// ====================================================================
const apiKey = 'dCsmvZgs';
const clientCode = 'AAAN050094';
const password = '7777';    
// NOTE: TOTP is the dynamic 2FA code, ensure it is up-to-date
const totp = '803327';    
const MAX_SYMBOLS = 5;

// Global state variables
let smart_api = null;
// Stores { token: { exchange, tradingSymbol } } for all symbols to track (NFO + NSE Equity)
let tokenCache = new Map(); 

// Polling intervals
const GAINERS_POLL_INTERVAL_MS = 0.1 * 60 * 1000; // 3 minutes: List refresh interval
const MARKET_DATA_POLL_INTERVAL_MS = 0.01 * 60 * 1000; // 1 minute: Alert check interval

// ====================================================================
// --- CORE ALERT LOGIC ---
// ====================================================================

/**
 * Compares the current price (LTP/Close) against the Day's Open price 
 * to determine if the stock is currently making a bullish or bearish candle relative to the start of the day.
 * @param {string} symbol The trading symbol (e.g., RELIANCE-EQ)
 * @param {string} exchange The exchange (NSE or NFO)
 * @param {number} open The Day's Open price (from marketData response)
 * @param {number} ltp The Latest Traded Price (from marketData response)
 */
function checkCandleStatusAndAlert(symbol, exchange, open, ltp) {
    const parsedOpen = parseFloat(open);
    const parsedLtp = parseFloat(ltp);

    if (isNaN(parsedOpen) || parsedOpen <= 0) {
        return;
    }
    
    const diff = (parsedLtp - parsedOpen).toFixed(2);
    const percentDiff = ((diff / parsedOpen) * 100).toFixed(2);

    if (parsedLtp > parsedOpen) {
        console.log(`\n🚨 ALERT: [${exchange}] 🟢 **BULLISH CANDLE** for ${symbol}! Price is UP ${diff} (${percentDiff}%).`);
        console.log(`> Current LTP (${parsedLtp}) vs Day's Open (${parsedOpen})`);
    } else if (parsedLtp < parsedOpen) {
        console.log(`\n🚨 ALERT: [${exchange}] 🔴 **BEARISH CANDLE** for ${symbol}! Price is DOWN ${diff} (${percentDiff}%).`);
        console.log(`> Current LTP (${parsedLtp}) vs Day's Open (${parsedOpen})`);
    } else {
        console.log(`\n🚨 ALERT: [${exchange}] ⚫ **INDECISION CANDLE** for ${symbol}! Close equals Day's Open.`);
        console.log(`> Current LTP (${parsedLtp}) = Day's Open (${parsedOpen})`);
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
 * Fetches Top 10 Price Gainers, finds their NSE equivalents, and updates the global cache.
 */
async function pollTopGainersAndTokens() {
    console.log(`\n[${new Date().toLocaleTimeString()}] --- 🥇 POLLING: Refreshing Top 10 Gainers List ---`);
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
            // 1. Store NFO Token (The primary gainer)
            // FIX: Explicitly set exchange to 'NFO' since this list is derived from the F&O segment.
            newCache.set(gainer.symbolToken, {
                exchange: 'NFO', // <--- This ensures the exchange is set.
                tradingSymbol: gainer.tradingSymbol,
            });

            // 2. Find and store NSE Equity Token
            const nseScrip = await findNSEEquityToken(gainer.tradingSymbol);
            if (nseScrip) {
                newCache.set(nseScrip.token, nseScrip);
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

    console.log(`\n[${new Date().toLocaleTimeString()}] --- 📊 POLLING: Fetching live data for ${tokenCache.size} stocks...`);

    // Prepare token structure for marketData API
    const tokensByExchange = { NSE: [], NFO: [] };
    const symbolLookup = {};

    for (const [token, data] of tokenCache.entries()) {
        
        // --- ⚠️ CRITICAL DEBUG LOG ---
        console.log(`[DEBUG CACHE ENTRY] Token: ${token}, Data:`, data);
        // --- ⚠️ CRITICAL DEBUG LOG ---

        const exchange = data.exchange;
        
        // Defensive check: Only accept pre-defined exchanges.
        if (exchange === 'NSE' || exchange === 'NFO') {
            // This is the line that throws the error if tokensByExchange[exchange] is undefined
            tokensByExchange[exchange].push(token);
            symbolLookup[token] = { exchange: exchange, tradingSymbol: data.tradingSymbol };
        } else {
            console.warn(`[CACHE WARNING] Skipping token ${token} due to invalid or unexpected exchange value: ${exchange}`);
        }
    }

    // Filter out empty arrays
    const exchangeTokens = {};
    if (tokensByExchange.NSE.length > 0) exchangeTokens.NSE = tokensByExchange.NSE;
    if (tokensByExchange.NFO.length > 0) exchangeTokens.NFO = tokensByExchange.NFO;
    
    if (Object.keys(exchangeTokens).length === 0) {
        console.log("No valid tokens to monitor after filtering.");
        return;
    }
    
    try {
        const quoteParams = { 
            "mode": "FULL", 
            "exchangeTokens": exchangeTokens 
        };
        const response = await smart_api.marketData(quoteParams); 
        
        if (response.status && response.data && response.data.fetched && response.data.fetched.length > 0) {
            console.log(`✅ Fetched data for ${response.data.fetched.length} total symbols.`);
            
            response.data.fetched.forEach(data => {
                const metadata = symbolLookup[data.symbolToken];
                
                if (metadata) {
                    // Log fetched data and then run the alert check
                    console.log(`\n--- 📝 Live Data: ${metadata.exchange} - ${data.tradingSymbol} ---`);
                    console.log(`> LTP: ${data.ltp} | Open: ${data.open} | Net Change: ${data.netChange}`);
                    
                    // 🚨 RUN CANDLE ALERT LOGIC
                    checkCandleStatusAndAlert(
                        data.tradingSymbol, 
                        metadata.exchange,
                        data.open, 
                        data.ltp
                    );
                }
            });
            
        } else {
            console.error('❌ Error fetching Live Market Data:', response.message || 'No data fetched.');
        }
    } catch (error) {
        console.error('❌ Exception fetching Live Market Data:', error.message);
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
    console.log(`> Live Data/Alert Check: Refreshed every ${MARKET_DATA_POLL_INTERVAL_MS / 60000} minute.`);

    // Start 3-minute poll for gainers list (which also finds NSE tokens)
    setInterval(pollTopGainersAndTokens, GAINERS_POLL_INTERVAL_MS);

    // Start 1-minute poll for market data and alerts
    setInterval(pollMarketDataAndAlerts, MARKET_DATA_POLL_INTERVAL_MS);
}

// Execute the main process
executeSmartAPIActions();