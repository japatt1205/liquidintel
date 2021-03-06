/// <reference path="typings/index.d.ts" />

import express = require('express');        // call express
var app = express();                 // define our app using express

import ConnectionPool = require('tedious-connection-pool');
import tds = require('./app/utils/tds-promises');
import {TYPES} from 'tedious';
import passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var BearerStrategy = require('passport-azure-ad').BearerStrategy;
var bodyParser = require('body-parser');
var fs = require('fs'); //For SSL
var env = require('dotenv').load();
var moment = require('moment');
var tz = require('moment-timezone');
import kegController = require('./app/controllers/kegController');
import personController = require('./app/controllers/personController');
import sessionController = require('./app/controllers/session');
import votingController = require('./app/controllers/votingController');
import adminController = require('./app/controllers/adminController');
import updateController = require('./app/controllers/updateController');
import queryExpression = require('./app/utils/query_expression');
import adminUserCache = require('./app/utils/admin_user_cache');
import settings = require('./app/utils/settings_encoder');
require('./app/utils/array_async');

var config = {
    userName: process.env.SqlUsername,
    password: process.env.SqlPassword,
    server: process.env.SqlServer,
    options: {
        database: process.env.SqlDatabase,
        encrypt: true,
        rowCollectionOnRequestCompletion: true
    }
};

var basicAuthCreds = JSON.parse(process.env.Basic_Auth_Conn_String);

tds.default.setConnectionPool(new ConnectionPool({}, config));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

/* Azure AD */
app.use(passport.initialize());

passport.use(new BasicStrategy(async (username, password, done) => {
    try {
        for(var cred in basicAuthCreds){
            if(username === basicAuthCreds[cred].username && password === basicAuthCreds[cred].key){
                return done(null, true);
            }
        }  
        return done(null, false, {message: 'Invalid client_id or api_key'});
    }
    catch (ex) {
        done(ex);
    }
}));
// OAuth bearer strategy for admin apis
var aad_auth_options = {  
    identityMetadata: process.env.AADMetadataEndpoint,
    clientID: process.env.ClientId,  
    audience: settings.decodeSettingArray(process.env.AADAudience),  
    validateIssuer: true,  
};
// Strategy for any valid AAD user
passport.use("aad-user", new BearerStrategy(aad_auth_options, async (token, done) => { 
    token['is_admin'] = await adminUserCache.isUserAdmin(token.oid);
    return done(null, token);
}));
// Strategy for valid AAD users in our admin group
passport.use("aad-admin", new BearerStrategy(aad_auth_options, async (token, done) => { 
    // Verify that the user associated with the supplied token is a member of our specified group
    if (await adminUserCache.isUserAdmin(token.oid)) {
        token['is_admin'] = true;
        return done(null, token);
    }
    done(null, false);
}));
// Note: All routes with 'basic' auth also accept OAuth bearer as well
var basicAuthStrategy = () => passport.authenticate(['basic', 'aad-user'], {session: false});
var bearerOAuthStrategy = (requireAdmin: boolean) => passport.authenticate(requireAdmin ? 'aad-admin' : 'aad-user', {session: false});

/* Setting Port to 8000 */
var port = process.env.PORT || 8080;
var router = express.Router();

router.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS, POST, PUT");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Cache-Control, Authorization");
    next();
});

var stdHandler = (handler: (req:express.Request, resultDispatcher:(resp:any)=>express.Response)=>void) => {
    return (req:express.Request, res:express.Response) => {
        handler(req, resp => {
            if (resp.code == 200) {
                return res.json(resp.msg);
            }
            else {
                return res.send(resp.code, resp.msg);
            }
        });
    };
};

router.get('/', function(req, res) {
    res.json({ message: 'Welcome to DX Liquid Intelligence api!' });   
});

router.route('/appConfiguration')
    .get(bearerOAuthStrategy(false), stdHandler((req, resultDispatcher) => resultDispatcher({
        code: 200, 
        msg: {
            UntappdClientId: process.env.UntappdClientId,
            UntappdClientSecret: process.env.UntappdClientSecret
        }
    })));

router.route('/isPersonValid/:card_id')
    .get(basicAuthStrategy(), stdHandler((req, resultDispatcher) => personController.getPersonByCardId(req.params.card_id, resultDispatcher)));

router.route('/validpeople/:card_id?')
    .get(basicAuthStrategy(), stdHandler((req, resultDispatcher) => personController.getValidPeople(req.params.card_id, resultDispatcher)));

router.route('/kegs')
    .get(basicAuthStrategy(), stdHandler((req, resultDispatcher) => kegController.getKeg(null, resultDispatcher)))
    .post(bearerOAuthStrategy(true), stdHandler((req, resultDispatcher) => kegController.postNewKeg(req.body, resultDispatcher)));

router.route('/activity/:sessionId?')
    .get(basicAuthStrategy(), stdHandler((req, resultDispatcher) => sessionController.getSessions(req.params.sessionId, new queryExpression.QueryExpression(req.query), resultDispatcher)))
    .post(basicAuthStrategy(), stdHandler((req, resultDispatcher) => sessionController.postNewSession(req.body, resultDispatcher)));

router.route('/CurrentKeg/:tap_id?')
    .get(basicAuthStrategy(), stdHandler((req, resultDispatcher) => kegController.getCurrentKeg(req.params.tap_id, resultDispatcher)))
    .put(bearerOAuthStrategy(true), stdHandler((req, resultDispatcher) => kegController.postPreviouslyInstalledKeg(req.body.KegId, req.params.tap_id, req.body.KegSize, resultDispatcher)));

router.route('/users/:user_id?')
    .get(bearerOAuthStrategy(false), stdHandler((req, resultDispatcher) => personController.getUserDetails(req.params.user_id, req.user.is_admin, req.user.upn, resultDispatcher)))
    .put(bearerOAuthStrategy(false), stdHandler((req, resultDispatcher) => personController.postUserDetails(req.params.user_id, req.user.is_admin, req.user.upn, req.body, resultDispatcher)));

router.route('/votes/:user_id')
    .get(bearerOAuthStrategy(false), stdHandler((req, resultDispatcher) => votingController.getUserVotes(req.params.user_id, resultDispatcher)))
    .put(bearerOAuthStrategy(false), stdHandler((req, resultDispatcher) => votingController.putUserVotes(req.params.user_id, req.body, resultDispatcher)));

router.route('/votes_tally')
    .get(bearerOAuthStrategy(false), stdHandler((req, resultDispatcher) => votingController.getVotesTally(resultDispatcher)))

router.route('/admin/AuthorizedGroups')
    .get(bearerOAuthStrategy(true), stdHandler((req, resultDispatcher) => adminController.getAllowedGroups(req.query, resultDispatcher)))
    .put(bearerOAuthStrategy(true), stdHandler((req, resultDispatcher) => adminController.putAllowedGroups(req.body.AuthorizedGroups, req.headers.authorization, resultDispatcher)));

router.route('/updates/:package_type')
    .get(basicAuthStrategy(), stdHandler((req, resultDispatcher) => updateController.getAvailableUpdates(req.params.package_type, new queryExpression.QueryExpression(req.query), resultDispatcher)));

app.use('/api', router);

app.listen(port, function () {
    console.log('Listening on port: ' + port);
});

module.exports = {app};
