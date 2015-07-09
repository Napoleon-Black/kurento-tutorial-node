/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Lesser General Public License
 * (LGPL) version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser')
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
kurento.register('kurento-module-crowddetector');

const RegionOfInterest = kurento.register.complexTypes.RegionOfInterest;
const RegionOfInterestConfig = kurento.register.complexTypes.RegionOfInterestConfig;
const RelativePoint = kurento.register.complexTypes.RelativePoint;

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'http://localhost:8080/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var app = express();

/*
 * Management of sessions
 */
app.use(cookieParser());

var sessionHandler = session({
    secret : 'none',
    rolling : true,
    resave : true,
    saveUninitialized : true
});

app.use(sessionHandler);

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};
var kurentoClient = null;

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = app.listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/'
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {
    var sessionId = null;
    var request = ws.upgradeReq;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, function(err) {
        sessionId = request.session.id;
        console.log('Connection received with sessionId ' + sessionId);
    });

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'start':
            sessionId = request.session.id;
            start(sessionId, ws, message.sdpOffer, function(error, type, data) {
                if (error) {
                    return ws.send(JSON.stringify({
                        id : 'error',
                        message : error
                    }));
                }
                switch (type) {
                case 'sdpAnswer':
                    ws.send(JSON.stringify({
                        id : 'startResponse',
                        sdpAnswer : data
                    }));
                    break;
                case 'crowdDetectorDirection':
                    ws.send(JSON.stringify({
                        id : 'crowdDetectorDirection',
                        event_data : data
                    }));
                    break;
                case 'crowdDetectorFluidity':
                    ws.send(JSON.stringify({
                        id : 'crowdDetectorFluidity',
                        event_data : data
                    }));
                    break;
                case 'crowdDetectorOccupancy':
                    ws.send(JSON.stringify({
                        id : 'crowdDetectorOccupancy',
                        event_data : data
                    }));
                    break;
                }
            });
            break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }

    });
});

/*
 * Definition of functions
 */

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

function start(sessionId, ws, sdpOffer, callback) {
    if (!sessionId) {
        return callback('Cannot use undefined sessionId');
    }

    getKurentoClient(function(error, kurentoClient) {
        if (error) {
            return callback(error);
        }

        kurentoClient.create('MediaPipeline', function(error, pipeline) {
            if (error) {
                return callback(error);
            }

            createMediaElements(pipeline, ws, function(error, webRtcEndpoint, filter) {
                if (error) {
                    pipeline.release();
                    return callback(error);
                }

                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                connectMediaElements(webRtcEndpoint, filter, function(error) {
                    if (error) {
                        pipeline.release();
                        return callback(error);
                    }

                    filter.on('CrowdDetectorDirection', function (_data){
                        return callback(null, 'crowdDetectorDirection', _data);
                    });

                    filter.on('CrowdDetectorFluidity', function (_data){
                        return callback(null, 'crowdDetectorFluidity', _data);
                    });

                    filter.on('CrowdDetectorOccupancy', function (_data){
                        return callback(null, 'crowdDetectorOccupancy', _data);
                    });

                    webRtcEndpoint.on('OnIceCandidate', function(event) {
                        var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                        ws.send(JSON.stringify({
                            id : 'iceCandidate',
                            candidate : candidate
                        }));
                    });

                    webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        sessions[sessionId] = {
                            'pipeline' : pipeline,
                            'webRtcEndpoint' : webRtcEndpoint
                        }
                        return callback(null, 'sdpAnswer', sdpAnswer);
                    });

                    webRtcEndpoint.gatherCandidates(function(error) {
                        if (error) {
                            return callback(error);
                        }
                    });
                });
            });
        });
    });
}

function createMediaElements(pipeline, ws, callback) {
    pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
        if (error) {
            return callback(error);
        }

        var options = {
          rois: [
            RegionOfInterest({
              id: 'roi1',
              points: [
                RelativePoint({x: 0  , y: 0  }),
                RelativePoint({x: 0.5, y: 0  }),
                RelativePoint({x: 0.5, y: 0.5}),
                RelativePoint({x: 0  , y: 0.5})
              ],
              regionOfInterestConfig: RegionOfInterestConfig({
                occupancyLevelMin: 10,
                occupancyLevelMed: 35,
                occupancyLevelMax: 65,
                occupancyNumFramesToEvent: 5,
                fluidityLevelMin: 10,
                fluidityLevelMed: 35,
                fluidityLevelMax: 65,
                fluidityNumFramesToEvent: 5,
                sendOpticalFlowEvent: false,
                opticalFlowNumFramesToEvent: 3,
                opticalFlowNumFramesToReset: 3,
                opticalFlowAngleOffset: 0
              })
            })
          ]
        }
        pipeline.create('CrowdDetectorFilter', options, function(error, filter) {
            if (error) {
                return callback(error);
            }

            return callback(null, webRtcEndpoint, filter);
        });
    });
}

function connectMediaElements(webRtcEndpoint, filter, callback) {
    webRtcEndpoint.connect(filter, function(error) {
        if (error) {
            return callback(error);
        }

        filter.connect(webRtcEndpoint, function(error) {
            if (error) {
                return callback(error);
             }

            return callback(null);
        });
    });
}

function stop(sessionId) {
    if (sessions[sessionId]) {
        var pipeline = sessions[sessionId].pipeline;
        console.info('Releasing pipeline');
        pipeline.release();

        delete sessions[sessionId];
        delete candidatesQueue[sessionId];
    }
}

function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

    if (sessions[sessionId]) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sessionId].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
