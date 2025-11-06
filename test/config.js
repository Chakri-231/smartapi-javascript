const sinon = require('sinon');


const config = {    
    api_key: "mgIvc18Y",
    client_code: "AAAN050094",
    jwttoken: "BQ373FY2MCEO2PQLNJOLRHQSNI",
    default_login_uri :"https://smartapi.angelone.in/publisher-login",
    requestInstance: {
        request: sinon.stub(),
        interceptors: {
            request: {
                use: sinon.stub(),
            },
            response: {
                use: sinon.stub(),
            },
        },
        defaults: {
            headers: {
                post: {
                    'Content-Type': 'application/json',
                },
                put: {
                    'Content-Type': 'application/json',
                },
            },
        }
    }
};


module.exports = config;