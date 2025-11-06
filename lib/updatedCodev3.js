const { SmartAPI } = require('smartapi-javascript'); 
const WebSocket = require('ws'); 
const moment = require('moment'); 
const readline = require('readline'); 

// ====================================================================
// --- GLOBAL STATE VARIABLES ---
// ====================================================================
let apiKey = null;
let clientCode = null;
let password = null;    
let totp = null;    

let MAX_SYMBOLS = 3; 
let smart_api = null;
let SCAN_TYPE = null; 

let SYMBOL_LIST_POLL_INTERVAL_MS = 30 * 1000; 
let MARKET_DATA_POLL_INTERVAL_MS = 30 * 1000; 

// --- TELEGRAM CONFIGURATION (NEW) ---
let TELEGRAM_BOT_TOKEN = null;
let TELEGRAM_CHAT_ID = null;

// --- STRATEGY PARAMETERS ---
let CANDLE_THICKNESS_PERCENT_THRESHOLD = 0.05; 
let EMA_VWAP_PERIOD = 15; 
let CANDLE_INTERVAL = 'ONE_MINUTE'; 

// Stores { token: { exchange, tradingSymbol, rootSymbol, type } } for all symbols to track
let tokenCache = new Map(); 

// Allowed intervals for SmartAPI getCandleData
const ALLOWED_INTERVALS = [
    'ONE_MINUTE', 'THREE_MINUTE', 'FIVE_MINUTE', 'TEN_MINUTE', 
    'FIFTEEN_MINUTE', 'THIRTY_MINUTE', 'ONE_HOUR', 'ONE_DAY'
];

// ====================================================================
// --- UTILITY FUNCTIONS ---
// ====================================================================

/**
 * Prompts the user for input in the console.
 */
function promptUser(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer);
    }));
}

/**
 * Sends a message directly via the Telegram Bot API.
 */
async function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error("Telegram Bot Token or Chat ID is not configured. Cannot send message.");
        return;
    }

    const apiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown' // Use Markdown for better formatting in Telegram
    };

    // Implement Exponential Backoff for API call retries
    const maxRetries = 3;
    let delay = 1000; // 1 second initial delay
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                return true; // Success
            } else {
                const errorText = await response.text();
                // If not OK, check if it's a retryable error (e.g., rate limit, server error)
                if (i === maxRetries - 1) {
                    throw new Error(`API returned ${response.status}: ${errorText}`);
                }
            }
        } catch (error) {
            if (i === maxRetries - 1) {
                throw error; // Re-throw last error
            }
            // Silent wait for exponential backoff
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // Double the delay for the next attempt
        }
    }
    return false;
}

/**
 * Formats and sends a market alert directly to Telegram.
 */
function sendTelegramAlert(symbolData, alertType, reasons) {
    const symbol = symbolData.tradingSymbol;
    const typeText = alertType === 'BULLISH' ? '*STRONG BULLISH BREAKOUT*' : '*STRONG BEARISH BREAKDOWN*';
    const intervalText = CANDLE_INTERVAL.replace('_', ' ');
    const color = alertType === 'BULLISH' ? '🟢' : '🔴';

    // Construct the message body using Markdown for Telegram
    const message = `${color} *${alertType} ALERT* ${color}\n` +
                    `\n**Symbol:** ${symbol} (${symbolData.rootSymbol})\n` +
                    `**Type:** ${typeText} (${symbolData.type})\n` +
                    `**Chart:** ${intervalText}\n` +
                    `\n*Criteria Met:*\n- ${reasons.join('\n- ')}\n` +
                    `\n_Review Chart Now!_`;

    console.log(`\n===================================================================================`);
    console.log(`🤖 TELEGRAM ALERT TRIGGERED! (${new Date().toLocaleTimeString()})`);
    console.log(`===================================================================================`);
    // Display raw content (remove markdown for cleaner console display)
    console.log(`> Alert Content Preview:\n${message.replace(/\*/g, '').replace(/_/g, '')}`); 
    console.log(`===================================================================================\n`);
    
    // Send the message
    sendTelegramMessage(message)
        .then(success => {
            if (success) {
                console.log(`...Telegram message sent successfully.`);
            }
        })
        .catch(error => {
            console.error(`...Failed to send Telegram alert:`, error.message);
        });
}

/**
 * Sends a general message based on custom text directly to Telegram.
 */
async function sendCustomTelegramMessage(message) {
    console.log(`\n===================================================================================`);
    console.log(`💬 SENDING CUSTOM TELEGRAM MESSAGE...`);
    console.log(`===================================================================================`);
    try {
        await sendTelegramMessage(message);
        console.log(`\n✅ Custom message delivered!`);
    } catch (error) {
        console.error(`\n❌ Failed to deliver custom message:`, error.message);
    }
}

/**
 * Sends a welcome message directly to Telegram.
 */
async function sendWelcomeMessage() {
    const message = `👋 Welcome to the SmartAPI F&O Scanner Bot!\n\nI am now configured to monitor the Top ${MAX_SYMBOLS} ${SCAN_TYPE} contracts for potential breakouts on the ${CANDLE_INTERVAL} chart.\n\nI will send alerts directly to this chat using the Telegram Bot API. Happy Trading!`;
    console.log(`\n--- Sending Welcome message to Telegram ---`);
    await sendTelegramMessage(message);
}


/**
 * Calculates the Exponential Moving Average (EMA).
 */
function calculateEMA(data, period) {
    if (data.length < period) return null;

    const relevantData = data.slice(-period);
    const multiplier = 2 / (period + 1);

    let currentEMA = relevantData.slice(0, period).reduce((sum, candle) => sum + parseFloat(candle.close), 0) / period;

    for (let i = 1; i < relevantData.length; i++) {
        const close = parseFloat(relevantData[i].close);
        currentEMA = (close - currentEMA) * multiplier + currentEMA;
    }
    
    return currentEMA;
}

/**
 * Calculates the Volume Weighted Average Price (VWAP).
 */
function calculateVWAP(data) {
    let sumTPV = 0; 
    let sumVolume = 0; 

    data.forEach(candle => {
        const high = parseFloat(candle.high);
        const low = parseFloat(candle.low);
        const close = parseFloat(candle.close);
        const volume = parseInt(candle.volume, 10);
        
        if (volume > 0) {
            const typicalPrice = (high + low + close) / 3;
            
            sumTPV += typicalPrice * volume;
            sumVolume += volume;
        }
    });

    if (sumVolume === 0) return null;
    
    return sumTPV / sumVolume;
}

/**
 * Extracts the root symbol (e.g., 'TATASTEEL') from an F&O trading symbol.
 */
function getRootSymbol(foSymbol) {
    return foSymbol.split(/[0-9]/)[0]; 
}

// ====================================================================
// --- TOKEN LOOKUP FUNCTIONS (FUT & OPT) ---
// ====================================================================

/**
 * Searches for the nearest monthly Futures contract token for a given root symbol.
 */
async function findFuturesToken(rootSymbol) {
    try {
        const response = await smart_api.searchScrip({
            "exchange": "NFO", 
            "searchScrip": rootSymbol
        });

        if (response.data && response.data.length > 0) {
            const nearestFUT = response.data
                .filter(scrip => scrip.instrumenttype === 'FUTIDX' || scrip.instrumenttype === 'FUTSTK')
                .sort((a, b) => moment(a.expiry).diff(moment(b.expiry)))
                .find(() => true); 

            if (nearestFUT) {
                return { 
                    token: nearestFUT.symboltoken, 
                    tradingSymbol: nearestFUT.tradingsymbol, 
                    exchange: 'NFO',
                    rootSymbol: rootSymbol,
                    type: 'FUT'
                };
            }
        }
    } catch (error) {
        console.error(`      -> Error searching for nearest FUT token for ${rootSymbol}:`, error.message);
    }
    return null;
}

/**
 * Searches for the nearest monthly Call Option (CE) token for a given root symbol.
 */
async function findOptionToken(rootSymbol) {
    try {
        const response = await smart_api.searchScrip({
            "exchange": "NFO", 
            "searchScrip": rootSymbol
        });

        if (response.data && response.data.length > 0) {
            const nearestCE = response.data
                .filter(scrip => scrip.instrumenttype === 'OPTIDX' || scrip.instrumenttype === 'OPTSTK')
                .filter(scrip => scrip.optiontype === 'CE')
                .sort((a, b) => moment(a.expiry).diff(moment(b.expiry)))
                .find(() => true); 

            if (nearestCE) {
                return { 
                    token: nearestCE.symboltoken, 
                    tradingSymbol: nearestCE.tradingsymbol, 
                    exchange: 'NFO',
                    rootSymbol: rootSymbol,
                    type: 'OPT'
                };
            }
        }
    } catch (error) {
        console.error(`      -> Error searching for nearest CE token for ${rootSymbol}:`, error.message);
    }
    return null;
}

// ====================================================================
// --- CORE ALERT LOGIC ---
// ====================================================================

/**
 * Checks for Thick Candle momentum confirmed by EMA and VWAP.
 */
function checkCandleStrengthAndAlert(symbolData, candleData, ltp) {
    const symbol = symbolData.tradingSymbol;
    const exchange = symbolData.exchange;
    const category = symbolData.category;
    const type = symbolData.type; 

    const lastCandle = candleData[candleData.length - 1];
    
    const parsedLtp = parseFloat(ltp);
    const parsedOpen = parseFloat(lastCandle.open);

    if (isNaN(parsedOpen) || parsedOpen <= 0) return;

    // 1. Calculate Indicators
    const emaValue = calculateEMA(candleData, EMA_VWAP_PERIOD);
    const vwapValue = calculateVWAP(candleData);

    if (!emaValue || !vwapValue) {
        // console.log(`   > [${symbol}] Insufficient data for EMA/VWAP calculation. Skipping alert check.`);
        return;
    }
    
    // 2. Check for Thick Candle Momentum
    const diff = parsedLtp - parsedOpen;
    const percentDiff = (diff / parsedOpen) * 100;
    const isThickCandle = Math.abs(percentDiff) >= CANDLE_THICKNESS_PERCENT_THRESHOLD;
    
    let alertType = null;
    let reasons = [];

    if (isThickCandle && diff > 0) {
        // --- 🟢 BULLISH CHECK ---
        const priceAboveEMA = parsedLtp > emaValue;
        const priceAboveVWAP = parsedLtp > vwapValue;

        if (priceAboveEMA && priceAboveVWAP) {
            alertType = 'BULLISH';
            reasons.push(`Thick Bullish Candle (+${percentDiff.toFixed(2)}%)`);
            reasons.push(`LTP ${parsedLtp.toFixed(2)} > EMA ${emaValue.toFixed(2)}`);
            reasons.push(`LTP ${parsedLtp.toFixed(2)} > VWAP ${vwapValue.toFixed(2)}`);
        }

    } else if (isThickCandle && diff < 0) {
        // --- 🔴 BEARISH CHECK ---
        const priceBelowEMA = parsedLtp < emaValue;
        const priceBelowVWAP = parsedLtp < vwapValue;

        if (priceBelowEMA && priceBelowVWAP) {
            alertType = 'BEARISH';
            reasons.push(`Thick Bearish Candle (${percentDiff.toFixed(2)}%)`);
            reasons.push(`LTP ${parsedLtp.toFixed(2)} < EMA ${emaValue.toFixed(2)}`);
            reasons.push(`LTP ${parsedLtp.toFixed(2)} < VWAP ${vwapValue.toFixed(2)}`);
        }
    }
    
    // 3. Trigger Alert
    if (alertType) {
        const color = alertType === 'BULLISH' ? '🟢' : '🔴';
        const typeText = alertType === 'BULLISH' ? '**STRONG BULLISH BREAKOUT**' : '**STRONG BEARISH BREAKDOWN**';
        
        console.log(`\n🔥🔥🚨 ${color} TRADING ALERT: [${exchange} ${category} ${type}] ${typeText} for ${symbol} (Root: ${symbolData.rootSymbol})`);
        console.log(`> Confirmed by: ${reasons.join(' | ')}`);

        // Send Telegram alert
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            sendTelegramAlert(symbolData, alertType, reasons);
        }
    } 
}

// ====================================================================
// --- LIST REFRESH (DYNAMIC POLLING) ---
// ====================================================================

/**
 * Fetches symbols for a specific category (Gainers or Losers) and processes them.
 */
async function fetchAndProcessSymbols(dataType) {
    const tempCache = new Map();
    const categoryName = dataType === 'PercPriceGainers' ? 'Gainers' : 'Losers';
    
    try {
        const params = { "datatype": dataType, "expirytype": "NEAR" };
        const response = await smart_api.gainersLosers(params); 
        
        if (!response.status || !response.data || response.data.length === 0) {
            console.log(`No Top ${categoryName} data available in API response for F&O symbols.`);
            return tempCache;
        }

        const topSymbols = response.data.slice(0, MAX_SYMBOLS);
        
        for (const symbol of topSymbols) {
            const rootSymbol = getRootSymbol(symbol.tradingSymbol);
            
            let scrip = null;
            
            if (SCAN_TYPE === 'OPT') {
                scrip = await findOptionToken(rootSymbol);
            } else if (SCAN_TYPE === 'FUT') {
                scrip = await findFuturesToken(rootSymbol);
            }

            if (scrip) {
                tempCache.set(scrip.token, {
                    ...scrip,
                    category: categoryName
                });
            }
        }
        
    } catch (error) {
        console.error(`❌ Error fetching Top ${categoryName} list:`, error.message);
    }

    return tempCache;
}


/**
 * Fetches Top N Price Gainers and Losers, finds their derivative contract, and updates the global cache.
 */
async function pollTopGainersAndLosers() {
    console.log(`\n[${new Date().toLocaleTimeString()}] --- 🥇 POLLING: Refreshing Top ${MAX_SYMBOLS} Gainers & Losers (${SCAN_TYPE}) List ---`);
    if (!smart_api) return;

    const newCache = new Map();

    // 1. Fetch and process Gainers
    const gainerTokens = await fetchAndProcessSymbols('PercPriceGainers');
    gainerTokens.forEach((v, k) => newCache.set(k, v));
    
    // 2. Fetch and process Losers
    const loserTokens = await fetchAndProcessSymbols('PercPriceLosers');
    loserTokens.forEach((v, k) => newCache.set(k, v));

    // 3. Update global cache
    tokenCache = newCache;
    console.log(`✅ CACHE UPDATED: ${tokenCache.size} nearest ${SCAN_TYPE} contracts stored for monitoring.`);
}

/**
 * Fetches historical data, calculates EMA/VWAP, and runs the combined alert check.
 */
async function pollDataAndCheckStrategy() {
    if (tokenCache.size === 0) {
        console.log(`[${new Date().toLocaleTimeString()}] --- 🕯️ IDLE: Waiting for ${SCAN_TYPE} symbols list to be populated...`);
        return;
    }

    console.log(`\n[${new Date().toLocaleTimeString()}] --- 📊 POLLING: Checking ${SCAN_TYPE} strategy for ${tokenCache.size} contracts on ${CANDLE_INTERVAL} chart...`);

    const tokensToMonitor = Array.from(tokenCache.keys());
    
    // Fetch LTP for all symbols
    const exchangeTokens = { NFO: tokensToMonitor };
    let liveLTPData = {};
    
    try {
        const quoteParams = { 
            "mode": "FULL", 
            "exchangeTokens": exchangeTokens 
        };
        const response = await smart_api.marketData(quoteParams); 
        
        if (response.status && response.data && response.data.fetched) {
             response.data.fetched.forEach(item => {
                liveLTPData[item.symbolToken] = item.ltp;
             });
        }
    } catch (error) {
        console.error('❌ Exception during Market Data Fetch:', error.message);
        return;
    }


    // Now iterate through each token to fetch historical data and run analysis
    for (const [token, metadata] of tokenCache.entries()) {
        const ltp = liveLTPData[token];
        if (!ltp) continue;
        
        try {
            // Determine the look-back time based on the interval
            const periodMultiplier = {
                'ONE_MINUTE': 1, 'THREE_MINUTE': 3, 'FIVE_MINUTE': 5, 'TEN_MINUTE': 10,
                'FIFTEEN_MINUTE': 15, 'THIRTY_MINUTE': 30, 'ONE_HOUR': 60, 'ONE_DAY': 1440 
            }[CANDLE_INTERVAL] || 1; 

            // Request enough time range for EMA_VWAP_PERIOD + buffer candles
            const minutesToSubtract = (EMA_VWAP_PERIOD + 10) * periodMultiplier; 
            const toDate = moment().format('YYYY-MM-DD HH:mm');
            const fromDate = moment().subtract(minutesToSubtract, 'minutes').format('YYYY-MM-DD HH:mm'); 

            const historyParams = {
                "exchange": metadata.exchange,
                "symboltoken": token,
                "interval": CANDLE_INTERVAL, 
                "fromdate": fromDate,
                "todate": toDate
            };
            
            const historyResponse = await smart_api.getCandleData(historyParams);
            
            if (historyResponse.status && historyResponse.data && historyResponse.data.length > 0) {
                const historicalData = historyResponse.data.map(d => ({
                    time: d[0], open: d[1], high: d[2], low: d[3], close: d[4], volume: d[5]
                }));
                
                if (historicalData.length >= EMA_VWAP_PERIOD) {
                    checkCandleStrengthAndAlert(
                        metadata, 
                        historicalData,
                        ltp
                    );
                } else {
                    // console.log(`   > [${metadata.tradingSymbol}] Only found ${historicalData.length} ${CANDLE_INTERVAL}. Need ${EMA_VWAP_PERIOD}.`);
                }

            } else {
                // console.log(`   > [${metadata.tradingSymbol}] No historical data found.`);
            }

        } catch (error) {
            console.error(`❌ Exception fetching historical data for ${metadata.tradingSymbol}:`, error.message);
        }
    }
}

/**
 * Main loop for polling and interactive commands.
 */
async function mainPollingLoop() {
    while (true) {
        // 1. Prompt for user command
        const command = await promptUser(`\n[${new Date().toLocaleTimeString()}] ENTER COMMAND: Enter 'M' to send a custom Telegram message, or press Enter/Return to continue waiting for alerts... `);
        
        if (command.toUpperCase().trim() === 'M' && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            const message = await promptUser('>> Enter the message you want to send: ');
            await sendCustomTelegramMessage(message);
        } else if (command.toUpperCase().trim() === 'M' && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
            console.log("⚠️ Telegram Bot Token and Chat ID are not configured. Cannot send custom message.");
        }
        
        // 2. Run the Polling Logic (Symbol List Refresh & Strategy Check)
        await pollTopGainersAndLosers(); 
        await pollDataAndCheckStrategy();

        // 3. Wait for the shortest interval 
        await new Promise(resolve => setTimeout(resolve, MARKET_DATA_POLL_INTERVAL_MS)); 
    }
}


// ====================================================================
// --- 🚀 MAIN EXECUTION FLOW ---
// ====================================================================

async function executeSmartAPIActions() {
    console.log('--- Starting SmartAPI Dynamic Market Scanner ---');
    console.log('Please provide your API credentials to log in:');
    
    // 1. CREDENTIALS
    apiKey = await promptUser('1. Enter your SmartAPI Key: ');
    clientCode = await promptUser('2. Enter your SmartAPI Client ID (User ID): ');
    password = await promptUser('3. Enter your SmartAPI Password: ');
    totp = await promptUser('4. Enter your current TOTP (6-digit code): ');

    // 5. TELEGRAM BOT CONFIGURATION (NEW)
    console.log('\n--- Telegram Bot Setup (For Direct Alerts) ---');
    TELEGRAM_BOT_TOKEN = await promptUser('5. Enter your Telegram Bot Token: ');
    TELEGRAM_CHAT_ID = await promptUser('6. Enter your Telegram Chat ID (where alerts should be sent): ');
    
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        console.log(`✅ Telegram alerts enabled. The bot will send messages directly.`);
    } else {
        console.log(`⚠️ Telegram details are missing. Alerts will only show in the console.`);
    }
    
    // 7. SCAN TYPE
    let userChoice = await promptUser('\n7. Do you want to scan Options (OPT) or Futures (FUT)? (Enter OPT or FUT): ');
    SCAN_TYPE = userChoice.toUpperCase().trim();
    if (SCAN_TYPE !== 'OPT' && SCAN_TYPE !== 'FUT') {
        console.error('❌ Invalid scan type. Please restart and enter OPT or FUT.');
        process.exit(1);
    }
    
    // 8. STRATEGY PARAMETERS
    console.log('\nNow set your custom chart and momentum strategy parameters:');
    
    const maxSymbolsInput = await promptUser('8. How many top Gainers and Losers should we monitor (per side)? (e.g., enter 3): ');
    MAX_SYMBOLS = parseInt(maxSymbolsInput, 10) || 3;

    // CANDLE INTERVAL PROMPT (uses exact API strings)
    let intervalInput = await promptUser(`9. What **chart interval** should we use for analysis?\n   (Enter one of these exact API values: ${ALLOWED_INTERVALS.join(', ')}): `);
    CANDLE_INTERVAL = intervalInput.toUpperCase().trim();
    if (!ALLOWED_INTERVALS.includes(CANDLE_INTERVAL)) {
        console.error(`❌ Invalid interval input. Defaulting to ONE_MINUTE.`);
        CANDLE_INTERVAL = 'ONE_MINUTE';
    }
    
    const emaVwapPeriodInput = await promptUser(`10. For trend confirmation (EMA/VWAP), how many ${CANDLE_INTERVAL.replace('_', ' ')} candles should we analyze? (e.g., enter 15): `);
    EMA_VWAP_PERIOD = parseInt(emaVwapPeriodInput, 10) || 15;
    
    const thicknessThresholdInput = await promptUser(`11. What minimum **percentage move** in one ${CANDLE_INTERVAL.replace('_', ' ')} candle should be considered 'Strong Momentum'? (e.g., enter 0.05 for 0.05%): `);
    CANDLE_THICKNESS_PERCENT_THRESHOLD = parseFloat(thicknessThresholdInput) || 0.05;

    // 12. POLLING INTERVALS
    console.log('\nFinally, set your monitoring frequency:');
    
    const listPollInput = await promptUser('12. How often (in seconds) should we refresh the list of Top Gainers/Losers? (e.g., 180 seconds for 3 minutes): ');
    SYMBOL_LIST_POLL_INTERVAL_MS = (parseInt(listPollInput, 10) * 1000) || (3 * 60 * 1000); 
    
    const dataPollInput = await promptUser('13. How often (in seconds) should we check the live data and run the alert strategy? (e.g., 60 seconds for 1 minute): ');
    MARKET_DATA_POLL_INTERVAL_MS = (parseInt(dataPollInput, 10) * 1000) || (1 * 60 * 1000); 
    
    // --- SEND WELCOME MESSAGE AFTER ALL CONFIG IS DONE ---
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        await sendWelcomeMessage();
    }
    
    // 14. LOGIN
    smart_api = new SmartAPI({ api_key: apiKey });

    try {
        const sessionData = await smart_api.generateSession(clientCode, password, totp);

        if (!sessionData.status || !sessionData.data || !sessionData.data.feedToken) {
            console.error('❌ Session generation failed. Please check credentials or TOTP.');
            return;
        }

        console.log('✅ Session generated successfully. JWT Token acquired.');
    
        // 15. START POLLING
        console.log('\n--- ⏱️ STRATEGY ACTIVATED ---');
        console.log(`> Scan Target: ${SCAN_TYPE} Contracts`);
        console.log(`> Chart Interval: ${CANDLE_INTERVAL}`);
        console.log(`> Momentum Threshold: ${CANDLE_THICKNESS_PERCENT_THRESHOLD}%`);
        console.log(`> Trend Period (EMA/VWAP): ${EMA_VWAP_PERIOD} candles.`);
        console.log(`> Strategy Check Frequency: Every ${MARKET_DATA_POLL_INTERVAL_MS / 1000} seconds.`);

        // Use the main loop for combined interaction and polling
        await mainPollingLoop(); 

    } catch (error) {
        console.error('❌ An unexpected error occurred during login or setup:', error.message);
    }
}

// Execute the main process
executeSmartAPIActions();