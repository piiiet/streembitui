﻿/*

This file is part of Streembit application. 
Streembit is an open source project to create a real time communication system for humans and machines. 

Streembit is a free software: you can redistribute it and/or modify it under the terms of the GNU General Public License 
as published by the Free Software Foundation, either version 3.0 of the License, or (at your option) any later version.

Streembit is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty 
of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with Streembit software.  
If not, see http://www.gnu.org/licenses/.
 
-------------------------------------------------------------------------------------------------------------------------
Author: Tibor Zsolt Pardi 
Copyright (C) 2016 The Streembit software development team
-------------------------------------------------------------------------------------------------------------------------

*/

'use strict';

if (global.appgui) {
    var fs = require('fs');
    var path = require('path');
}

var streembit = streembit || {};

streembit.MediaCall = (function (module, logger, app_events, config) {
    
    module.options = {};
    module.is_outgoing_call = false;
    module.connection = 0;
    module.ice_servers = config.ice_resolvers;
    
    var localVideo;
    var contactVidElement;
    var mediaStream;
    var remoteStream;
    
    function create_connection() {
        logger.debug('WebRTC: creating connection for ' + module.options.contact.name);
        
        // Create a new PeerConnection
        var servers = { iceServers: module.ice_servers };
        var connection = new RTCPeerConnection(servers);
        
        // ICE Candidate Callback
        connection.onicecandidate = function (event) {
            if (event.candidate) {
                // Found a new candidate
                logger.debug('WebRTC: onicecandidate, candidate: %j', event.candidate);
                var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTC, type: "candidate", "candidate": event.candidate };
                streembit.PeerNet.send_peer_message(module.options.contact, message);
            } 
            else {
                logger.debug('WebRTC: ICE candidate gathering is completed');
                if (remoteStream) {
                    logger.debug('WebRTC: call onRemoteStreamAdded()');
                    onRemoteStreamAdded(remoteStream);
                }
            }
        };
        
        connection.onstatechange = function () {
            var states = {
                'iceConnectionState': connection.iceConnectionState,
                'iceGatheringState': connection.iceGatheringState,
                'readyState': connection.readyState,
                'signalingState': connection.signalingState
            };
            
            logger.debug(JSON.stringify(states));
        };
        
        connection.onnegotiationneeded = function () {
            if (module.is_outgoing_call) {
                logger.debug('WebRTC: connection.onnegotiationneeded -> create offer');
                
                // Send an offer for a connection
                connection.createOffer(
                    function (desc) {
                        try {
                            connection.setLocalDescription(desc, function () {
                                logger.debug("WebRTC: createOffer() callback. Send sdp localDescription");
                                var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTC, type: "sdp", "sdp": connection.localDescription };
                                streembit.PeerNet.send_peer_message(module.options.contact, message);
                            });
                        }
                        catch (err) {
                            streembit.notify.error("setLocalDescription error: %j", err);
                        }
                    }, 
                    function (error) {
                        logger.error('connection createOffer error: ' + error);
                    }
                );
            }
        }
        
        connection.onaddstream = function (evt) {
            logger.debug('WebRTC: connection.onaddstream, set remote stream');
            remoteStream = evt.stream;
            if (module.is_outgoing_call) {
                logger.debug('is_outgoing_call == true, call onRemoteStreamAdded()');
                onRemoteStreamAdded(evt.stream);
            }
        };
        
        connection.onremovestream = function (event) {
            logger.debug('WebRTC: connection.onremovestream');
            // A stream was removed
            onStreamRemoved(event.stream.id);
        };
        
        // And return it
        return connection;
    }
    
    function getConnection() {
        if (!module.connection) {
            module.connection = create_connection();
        }
        return module.connection;
    }
    
    // Process a newly received Candidate signal
    function onCandidateSignalReceived(connection, candidate) {
        logger.debug('WebRTC: candidate %j', candidate);
        try {
            connection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        catch (err) {
            streembit.notify.error("addIceCandidate error: %j", err);
        }
    }
    
    // Process a newly received SDP signal
    function onSdpSignalReceived(connection, sdp) {
        
        logger.debug('WebRTC: processing sdp signal');
        
        var tdesc = new RTCSessionDescription(sdp);
        //logger.debug('sdp desc %j', tdesc);
        logger.debug('desc.type == ' + tdesc.type);
        
        try {
            connection.setRemoteDescription(
                tdesc, 
                function () {
                    if (connection.remoteDescription.type == "offer" && !module.is_outgoing_call) { //  only the callee creates an answer
                        logger.info('WebRTC: received offer, sending response');
                        onReadyForStream(connection);
                        connection.createAnswer(
                            function (desc) {
                                connection.setLocalDescription(desc, function () {
                                    logger.debug('WebRTC: send sdp connection.localDescription:');
                                    logger.debug('%j', connection.localDescription);
                                    var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTC, type: "sdp", "sdp": connection.localDescription };
                                    streembit.PeerNet.send_peer_message(module.options.contact, message);
                                });
                            },
                            function (error) {
                                logger.error('Error creating session description: ' + error);
                            }
                        );
                    } 
                    else if (connection.remoteDescription.type == "answer") {
                        logger.info('WebRTC: caller setRemoteDescription success');
                    }
                },
                function (error) {
                    logger.error('setRemoteDescription error: %j', error);
                }
            );
        }
        catch (err) {
            streembit.notify.error("setRemoteDescription error: %j", err);
        }
    }
    
    // Hand off a new signal from the signaler to the connection
    // listen on the data received event
    module.onSignalReceive = function (data) {
        //var signal = JSON.parse(data);
        var connection = getConnection();
        
        logger.debug('WebRTC: received signal type: %s', data.type);
        
        // Route signal based on type
        if (data.sdp) {
            onSdpSignalReceived(connection, data.sdp);
        } 
        else if (data.candidate) {
            onCandidateSignalReceived(connection, data.candidate);
        }
        else {
            logger.error('onReceiveSignal error: unknown signal type');
        }
    }
    
    module.show_video = function (callback) {
        var videoTracks = mediaStream.getVideoTracks();
        if (videoTracks.length === 0) {
            logger.debug('No local video available.');
            return;
        }
        
        trace('Toggling video mute state.');
        for (var i = 0; i < videoTracks.length; ++i) {
            videoTracks[i].enabled = true;
        }
        
        logger.debug('Video ' + (videoTracks[0].enabled ? 'unmuted.' : 'muted.'));
        if (videoTracks[0].enabled) {
            callback();
        }
    }
    
    module.hide_video = function (callback) {
        var videoTracks = mediaStream.getVideoTracks();
        if (videoTracks.length === 0) {
            logger.debug('No local video available.');
            return;
        }
        
        trace('Toggling video mute state.');
        for (var i = 0; i < videoTracks.length; ++i) {
            videoTracks[i].enabled = false;
        }
        
        logger.debug('Video ' + (videoTracks[0].enabled ? 'unmuted.' : 'muted.'));
        if (!videoTracks[0].enabled) {
            callback();
        }
    }
    
    module.toggle_audio = function (ismute, callback) {
        var audioTracks = mediaStream.getAudioTracks();
        if (audioTracks.length === 0) {
            logger.debug('toggle_audio() No local audio available.');
            return;
        }
        
        logger.debug('Toggling audio mute state.');
        for (var i = 0; i < audioTracks.length; ++i) {
            audioTracks[i].enabled = !audioTracks[i].enabled;
        }
        
        logger.debug('Audio ' + (audioTracks[0].enabled ? 'unmuted.' : 'muted.'));
        callback();
    }
    
    function onReadyForStream(connection) {
        try {
            if (!mediaStream) {
                return streembit.notify.error_popup('Invalid media stream');
            }
            
            connection.addStream(mediaStream);
        }
        catch (err) {
            logger.error("onReadyForStream error " + err.message);
        }
    }
    
    //  public methods
    function call_contact() {
        try {
            if (!mediaStream) {
                return streembit.notify.error_popup('Invalid media stream');
            }
            
            //  create a connection 
            var connection = getConnection(module.options.contact.name);
            // Add our audio/video stream
            connection.addStream(mediaStream);
            logger.debug('stream added to connection at the caller end');
        }
        catch (err) {
            streembit.notify.error_popup("call_contact error %j", err);
        }
    }
    
    
    function onStreamRemoved(streamId) {
        try {
            logger.debug('Remove remote stream from contact video element');
            
            module.hangup();
        }
        catch (err) {
            logger.error("onStreamRemoved error " + err.message);
        }
    }
    
    
    function onRemoteStreamAdded(eventStream) {
        try {
            if (module.options.calltype == "videocall") {
                
                logger.debug('Bind remote stream to contact video element');
                // Bind the remote stream to the contact video control
                var contactVideo = document.getElementById(contactVidElement);
                attachMediaStream(contactVideo, eventStream);

            }
            else {
                logger.debug('Bind remote stream to audio element');
                var audio = document.querySelector('audio');
                audio.srcObject = eventStream; //event.stream;
            }
            
            if (eventStream.active) {
                logger.debug("onRemoteStreamAdded: eventStream is active");
            }
            
            app_events.emit(app_events.APPEVENT, app_events.TYPES.ONVIDEOCONNECT);
        }
        catch (err) {
            logger.error("onRemoteStreamAdded error: %j", err);
        }
    }
    
    // private variables and methods
    function onStreamCreated(stream) {
        try {
            logger.debug('Received local stream');
            
            if (module.options.calltype == "videocall") {
                attachMediaStream(localVideo, stream);
            }
            else {
                var audioTracks = stream.getAudioTracks();
                logger.debug('Using audio device: ' + audioTracks[0].label);
            }
            
            mediaStream = stream;
            
            // create the connection and perform the call
            if (module.is_outgoing_call) {
                call_contact();
            }
        }
        catch (err) {
            logger.error("onStreamCreated error " + err.message);
        }
    }
    
    //  public methods
    module.init = function (localvideo, contactvideo, options) {
        try {
            module.options = options;
            module.is_outgoing_call = options.iscaller;
            module.connection = null;
            
            logger.debug(options.calltype + " with %s", options.contact.name);
            
            if (options.calltype == "videocall") {
                localVideo = document.getElementById(localvideo);
                contactVidElement = contactvideo;
            }
            
            var params = {};
            if (options.calltype == "videocall") {
                params = { audio: true, video: true };
            }
            else {
                params = { audio: true, video: false };
            }
            
            navigator.mediaDevices.getUserMedia(params)
            .then(onStreamCreated)
            .catch(function (error) {
                if (error.name === 'ConstraintNotSatisfiedError') {
                    streembit.notify.error_popup('The resolution ' + constraints.video.width.exact + 'x' + constraints.video.width.exact + ' px is not supported by your device.');
                } else if (error.name === 'PermissionDeniedError') {
                    streembit.notify.error_popup('Permissions have not been granted to use your camera and ' +
                                                'microphone, you need to allow the page access to your devices in order for the demo to work.');
                }
                else {
                    streembit.notify.error_popup('getUserMedia error: %j', error);
                }
            });
        }
        catch (err) {
            streembit.notify.error_popup("Media call init error %j", err);
        }
    }
    
    module.hangup = function () {
        logger.debug("MediaCall hangup()");
        if (module.connection) {
            try {
                module.connection.close();
                module.connection = null;
            }
            catch (e) { }
        }
        
        try {
            if (mediaStream) {
                mediaStream.getAudioTracks().forEach(function (track) {
                    track.stop();
                });
                
                mediaStream.getVideoTracks().forEach(function (track) {
                    track.stop();
                });
            }
        }
        catch (e) { }
        
        try {
            var contactVideo = document.getElementById(contactVidElement);
            contactVideo.src = '';
            if (localVideo) {
                localVideo.pause();
                localVideo.src = "";
            }
        }
        catch (e) { }
    }
    
    return module;

}(streembit.MediaCall || {}, streembit.logger, global.appevents, streembit.config));


streembit.FileTransfer = (function (module, logger, app_events, config) {
    
    module.options = {};
    module.chunksize = 8192;
    module.list_of_files = {};
    
    function cancelFile(file) {
        file.iscancelled = true;
        if (file.writepath) {
            streembit.util.deleteFile(file.writepath, function () { });
            try {
                delete module.list_of_files[file.hash];
            }
            catch (e) { }
        }
    }
    
    function fileItem(filename, filesize, filehash, filetype, filepath) {
        var obj = {
            name: filename,
            size: filesize,
            hash: filehash,
            type: filetype,
            path: filepath,
            processed: 0,
            iscancelled: false,
            fqueue: [],
            qtimer: null,
            currpos: 0,
            missingpos: 0,
            maxpos: ((parseInt((filesize / module.chunksize)) - 1) + ((filesize % module.chunksize) > 0 ? 1 : 0)),
            blobitems: []
        };
        
        obj.fwrite = function () {
            try {
                if (obj.processed >= obj.size || obj.currpos > obj.maxpos) {
                    clearTimeout(obj.qtimer);
                    logger.debug("file write completed processed length: " + obj.processed + " currpos: " + obj.currpos);
                    if (global.appgui) {
                        //  compute the file hash
                        streembit.util.fileHash(obj.writepath, function (sha1sum) {
                            streembit.Session.tasksvm.complete(obj.hash, sha1sum, obj.writepath);
                            try {
                                delete module.list_of_files[obj.hash];
                            }
                            catch (e) { }
                        });
                    }
                    else {
                        streembit.Session.tasksvm.complete(obj.hash, obj.hash, null, obj.blobitems);
                        try {
                            delete module.list_of_files[obj.hash];
                        }
                        catch (e) { }
                    }
                }
                
                if (obj.iscancelled) {
                    clearTimeout(obj.qtimer);
                    logger.debug("file transfer was cancelled")
                    return;
                }
                
                //find in the queueu the current position;
                var index = -1;
                for (var i = 0; i < obj.fqueue.length; i++) {
                    if (obj.fqueue[i].pos == obj.currpos) {
                        index = i;
                        break;
                    }
                }
                
                if (index == -1) {
                    //  update the missingpos variable count
                    //  if the missingpos > 300 (30 seconds) then cancel the operation
                    if (obj.missingpos >= 300) {
                        clearTimeout(obj.qtimer);
                        var msg = "File transfer tmed out. File chunk is not received at position " + obj.currpos;
                        streembit.Session.tasksvm.error(obj.hash, msg);
                        cancelFile(obj);
                        return logger.error("file write error: " + msg)
                    }
                    else {
                        //logger.debug("missing pos " + obj.currpos); 
                        obj.missingpos++;
                        return;
                    }
                }
                
                // reset the missing variable                
                obj.missingpos = 0;
                
                // get the item from the array at position index
                var items = obj.fqueue.splice(index, 1);
                if (!items || !items.length) {
                    clearTimeout(obj.qtimer);
                    var msg = "couldn't get the data chunk from file queue at position " + obj.currpos;
                    streembit.Session.tasksvm.error(obj.hash, msg);
                    cancelFile(obj);
                    return logger.error("file write error: " + msg)
                }
                
                if (global.appgui) {
                    
                    var chunk = items[0].buffer;
                    if (!chunk || !chunk.length) {
                        clearTimeout(obj.qtimer);
                        var msg = "invalid file data chunk at position " + obj.currpos;
                        streembit.Session.tasksvm.error(obj.hash, msg);
                        cancelFile(obj);
                        return logger.error("file write error: " + msg)
                    }
                    
                    fs.appendFile(obj.writepath, chunk, function (err) {
                        if (err) {
                            clearTimeout(obj.qtimer);
                            streembit.Session.tasksvm.error(obj.hash, err);
                            cancelFile(obj);
                            return logger.error("file open error %j", err)
                        }
                        
                        // update the processed length
                        obj.processed += chunk.length;
                        
                        logger.debug("wrote file at pos " + obj.currpos + " offset: " + obj.processed);
                        
                        // update the current position
                        obj.currpos++;
                        
                        streembit.Session.tasksvm.update(obj.hash, obj.processed);
                    });

                }
                else {
                    var chunk = items[0].buffer;
                    obj.blobitems.push(chunk);
                    // update the processed length
                    obj.processed += items[0].length;
                    // update the current position
                    obj.currpos++;
                    streembit.Session.tasksvm.update(obj.hash, obj.processed);
                }
            }
            catch (err) {
                logger.error('file write error %j', err);
            }
        }
        
        obj.process = function (fobj) {
            obj.fqueue.push(fobj);
            
            if (!obj.qtimer) {
                logger.debug("qtimer start, maxpos: " + obj.maxpos);
                obj.qtimer = setInterval(obj.fwrite, 100);
            }
        }
        
        return obj;
    }
    
    function toArrayBuffer(buffer) {
        var ab = new ArrayBuffer(buffer.length);
        var view = new Uint8Array(ab);
        for (var i = 0; i < buffer.length; ++i) {
            view[i] = buffer[i];
        }
        return ab;
    }
    
    function base64ToArrayBuffer(base64) {
        var binaryString = window.atob(base64);
        var binaryLen = binaryString.length;
        var bytes = new Uint8Array(binaryLen);
        for (var i = 0; i < binaryLen; i++) {
            var ascii = binaryString.charCodeAt(i);
            bytes[i] = ascii;
        }
        return bytes;
    }
    
    module.cancel = function (hash) {
        var file = module.list_of_files[hash];
        if (file) {
            cancelFile(file);
        }
    }
    
    module.cancel_by_peer = function (payload) {
        if (!payload || !payload.hash) {
            return logger.error("Invalid file cancel data");
        }
        
        var hash = payload.hash;
        streembit.Session.tasksvm.cancel_by_peer(hash);
        
        var file = module.list_of_files[hash];
        if (file) {
            file.iscancelled = true;
            setTimeout(
                function () {
                    cancelFile(file);
                },
                1000
            );
        }
    }
    
    module.onFileChunkReceive = function (data) {
        try {
            if (!data || !data.chunk || !data.hash) {
                return logger.error("onFileChunkReceive invalid data")
            }
            
            var file = module.list_of_files[data.hash];
            if (!file) {
                var msg = "couldn't find file transfer task by hash: " + data.hash;
                streembit.Session.tasksvm.error(data.hash, msg);
                return logger.error(msg);
            }
            
            if (file.iscancelled) {
                logger.debug("onFileChunkReceive file.iscancelled");
                return;
            }
            
            var chunk;
            if (global.appgui) {
                chunk = new Buffer(data.chunk, 'base64');
                if (data.length != chunk.length) {
                    streembit.Session.tasksvm.error(data.hash, "invalid data length for file chunk");
                    logger.error("onFileChunkReceive invalid data length");
                    cancelFile(file);
                    return;
                }
            }
            else {
                chunk = base64ToArrayBuffer(data.chunk);
            }
            
            //logger.debug("received pos: " + data.pos + " offset: " + data.offset + " length: " + data.length);
            
            var fobj = { pos: data.pos, offset: data.offset, length: data.length, buffer: chunk };
            file.process(fobj);
        }
        catch (err) {
            logger.error("onFileChunkReceive error: " + err.message);
        }
    }
    
    function getWait(fsize) {
        var wait = 250;
        switch (true) {
            case (fsize <= 100000):
                wait = 150;
                break;
            case (fsize > 100000 && fsize <= 1000000):
                chunk_size = 8192;
                wait = 200;
                break;
            case (fsize > 1000000 && fsize <= 4000000):
                chunk_size = 16384;
                wait = 250;
                break;
            case (fsize > 4000000 && fsize <= 10000000):
                chunk_size = 16384;
                wait = 300;
                break;
            default:
                wait = 400;
        }
        
        return wait;
    }
    
    function sendData(hash) {
        logger.debug('FileTransfer sendData()');
        
        var file = module.list_of_files[hash];
        
        if (!file) {
            bootbox.alert("File send error: invalid file");
            //closeDataChannels();
            return;
        }
        
        var name = file.name;
        if (!name) {
            bootbox.alert("File send error: invalid file name");
            return;
        }
        
        var path = file.path;
        if (!path) {
            bootbox.alert("File send error: invalid file path");
            return;
        }
        
        var fsize = file.size;
        if (fsize === 0) {
            bootbox.alert('File is empty, please select a non-empty file');
            return;
        }
        
        if (fsize > 10000000) {
            bootbox.alert('The maximum supported file size of this software version is 10 MB');
            return;
        }
        
        logger.debug('file is ' + [file.name, fsize, file.type].join(' '));
        
        var chunk_size = module.chunksize; //8192; //8192;
        var wait = 250; //getWait(fsize);
        
        logger.debug('chunk size: ' + chunk_size + ' send interval: ' + wait);
        
        var readable = fs.createReadStream(path, {
            flags: 'r',
            encoding: null,
            fd: null
        });
        
        readable.on('readable', function () {
            var chunk;
            while (null !== (chunk = readable.read(chunk_size))) {
                file.fqueue.push(chunk);
            }
        });
        
        readable.on('end', function () {
            logger.debug('file read end');
        });
        
        readable.on('error', function (err) {
            logger.error('file read error %j', err);
            streembit.notify.error_popup("File read error %j", err);
        });
        
        file.processed = 0;
        file.qtimer = setInterval(function () {
            try {
                if (file.iscancelled) {
                    clearTimeout(file.qtimer);
                    logger.debug("file transfer was cancelled")
                    return;
                }
                
                if (file.processed >= fsize && file.fqueue.length == 0) {
                    clearTimeout(file.qtimer);
                    logger.debug("file transfer fqueue is processed bytes: " + file.processed);
                    streembit.Session.tasksvm.complete(hash);
                    return;
                }
                
                var chunk = file.fqueue.shift();
                if (chunk) {
                    var data = chunk.toString('base64');
                    var message = { cmd: streembit.DEFS.PEERMSG_FSEND, hash: hash, pos: file.currpos, offset: file.processed, length: chunk.length, chunk: data };
                    streembit.PeerNet.send_peer_message(module.options.contact, message);
                    
                    file.processed += chunk.length;
                    file.currpos++;
                    
                    streembit.Session.tasksvm.update(hash, file.processed);
                }
            }
            catch (err) {
                logger.error('file send error %j', err);
            }
        },
        wait);
               
    }
    
    
    //  public methods
    module.init_send = function (options) {
        try {
            
            module.connection = 0;
            module.options = options;
            
            logger.debug("FileTransfer to %s", options.contact.name);
            
            if (!options.file || !options.file.name || !options.file.hash)
                throw new Error("Invalid file");
            
            if (options.file.size === 0) {
                throw new Error('File is empty, please select a non-empty file');
            }
            
            
            var hash = options.file.hash;
            var item = new fileItem(options.file.name, options.file.size, hash, options.file.type, options.file.path);
            module.list_of_files[hash] = item;
            
            sendData(hash);
            
        }
        catch (err) {
            logger.error("FileTransfer init_send() error %j", err);
            bootbox.alert("File send error " + err);
        }
    }
    
    module.init_receive = function (options) {
        try {
            
            if (!options || !options.file || !options.file.size || !options.file.name || !options.file.hash)
                throw new Error("Invalid file");
            
            module.options = options;
            
            var hash = options.file.hash;
            var item = new fileItem(options.file.name, options.file.size, hash, options.file.type);
            item.writepath = global.datapath ? path.join(global.datapath, options.file.name) : "";
            module.list_of_files[hash] = item;
            
            module.options = options;
            
            logger.debug("FileTransfer from " + options.contact.name + " file size: " + options.file.size + " file name: " + options.file.name + " file type: " + options.file.type);

        }
        catch (err) {
            logger.error("FileTransfer init_receive() error %j", err);
            streembit.notify.error_popup("File receive error %j", err);
        }
    }
    
    return module;

}(streembit.FileTransfer || {}, streembit.logger, global.appevents, streembit.config));


streembit.ShareScreenCall = (function (module, logger, app_events, config) {
    
    module.options = {};
    module.is_outgoing_call = false;
    module.connection = 0;
    module.ice_servers = config.ice_resolvers;
    module.scn = 0;
    
    var screenVideo;
    var mediaStream;
    var remoteStream;
    
    function create_connection() {
        logger.debug('WebRTC: creating connection for ' + module.options.contact.name);
        
        // Create a new PeerConnection
        var servers = { iceServers: module.ice_servers };
        var connection = new RTCPeerConnection(servers);
        
        // ICE Candidate Callback
        connection.onicecandidate = function (event) {
            if (event.candidate) {
                // Found a new candidate
                logger.debug('WebRTC: onicecandidate, candidate: %j', event.candidate);
                var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTCSS, type: "candidate", "candidate": event.candidate };
                streembit.PeerNet.send_peer_message(module.options.contact, message);
            } 
            else {
                logger.debug('WebRTC: ICE candidate gathering is completed');
                if (remoteStream) {
                    logger.debug('WebRTC: call onRemoteStreamAdded()');
                    onRemoteStreamAdded(remoteStream);
                }
                else {
                    try {
                        logger.debug('WebRTC: call videoconnfn_callback()');
                        if (module.videoconnfn_callback) {
                            module.videoconnfn_callback();
                        }
                        
                        logger.debug("calling contact with auto audio");
                        // initialize the audio call module
                        var options = {
                            contact: module.options.contact,
                            iscaller: true
                        };                       
                        streembit.AutoAudioCall.init(options);
                    }
                    catch (err) {

                    }
                }
            }
        };
        
        connection.onstatechange = function () {
            var states = {
                'iceConnectionState': connection.iceConnectionState,
                'iceGatheringState': connection.iceGatheringState,
                'readyState': connection.readyState,
                'signalingState': connection.signalingState
            };
            
            logger.debug("WebRTC: connection.onstatechange");
        };
        
        connection.onnegotiationneeded = function () {
            if (module.is_outgoing_call) {
                logger.debug('WebRTC: connection.onnegotiationneeded -> create offer');
                
                // Send an offer for a connection
                connection.createOffer(
                    function (desc) {
                        try {
                            connection.setLocalDescription(desc, function () {
                                logger.debug("WebRTC: createOffer() callback. Send sdp localDescription");
                                var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTCSS, type: "sdp", "sdp": connection.localDescription };
                                streembit.PeerNet.send_peer_message(module.options.contact, message);
                            });
                        }
                        catch (err) {
                            streembit.notify.error("setLocalDescription error: %j", err);
                        }
                    }, 
                    function (error) {
                        logger.error('connection createOffer error: ' + error);
                    }
                );
            }
        }
        
        connection.onaddstream = function (evt) {
            logger.debug('WebRTC: connection.onaddstream, set remote stream');
            remoteStream = evt.stream;
        };
        
        connection.onremovestream = function (event) {
            logger.debug('WebRTC: connection.onremovestream');
            // A stream was removed
            onStreamRemoved(event.stream.id);
        };
        
        // And return it
        return connection;
    }
    
    function getConnection() {
        if (!module.connection) {
            module.connection = create_connection();
        }
        return module.connection;
    }
    
    // Process a newly received Candidate signal
    function onCandidateSignalReceived(connection, candidate) {
        logger.debug('WebRTC: candidate %j', candidate);
        try {
            connection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        catch (err) {
            streembit.notify.error("addIceCandidate error: %j", err);
        }
    }
    
    // Process a newly received SDP signal
    function onSdpSignalReceived(connection, sdp) {
        
        logger.debug('WebRTC: processing sdp signal');
        
        var tdesc = new RTCSessionDescription(sdp);
        //logger.debug('sdp desc %j', tdesc);
        logger.debug('desc.type == ' + tdesc.type);
        
        try {
            connection.setRemoteDescription(
                tdesc, 
                function () {
                    if (connection.remoteDescription.type == "offer" && !module.is_outgoing_call) { //  only the callee creates an answer
                        logger.info('WebRTC: received offer, sending response');
                        onReadyForStream(connection);
                        connection.createAnswer(
                            function (desc) {
                                connection.setLocalDescription(desc, function () {
                                    logger.debug('WebRTC: send sdp connection.localDescription:');
                                    logger.debug('%j', connection.localDescription);
                                    var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTCSS, type: "sdp", "sdp": connection.localDescription };
                                    streembit.PeerNet.send_peer_message(module.options.contact, message);
                                });
                            },
                            function (error) {
                                logger.error('Error creating session description: ' + error);
                            }
                        );
                    } 
                    else if (connection.remoteDescription.type == "answer") {
                        logger.debug('WebRTC: caller setRemoteDescription success');
                    }
                },
                function (error) {
                    logger.error('setRemoteDescription error: %j', error);
                }
            );
        }
        catch (err) {
            streembit.notify.error("setRemoteDescription error: %j", err);
        }
    }
    
    // Hand off a new signal from the signaler to the connection
    // listen on the data received event
    module.onSignalReceive = function (data) {
        try {
            //var signal = JSON.parse(data);
            var connection = getConnection();
            
            logger.debug('WebRTC: received signal type: %s', data.type);
            
            // Route signal based on type
            if (data.sdp) {
                onSdpSignalReceived(connection, data.sdp);
            } 
            else if (data.candidate) {
                onCandidateSignalReceived(connection, data.candidate);
            }
            else {
                logger.error('onReceiveSignal error: unknown signal type');
            }
        }
        catch (err) {
            logger.error('WebRTC onReceiveSignal error: %j', err);
        }
    }
    

    function onReadyForStream(connection) {
        if (module.videoconnfn_callback) {
            module.videoconnfn_callback();
        }
    }
    
    //  public methods
    function call_contact(stream) {
        try {
            if (!stream) {
                return streembit.notify.error_popup('Invalid media stream');
            }
            
            mediaStream = stream;
            
            //  create a connection 
            var connection = getConnection(module.options.contact.name);
            // Add our audio/video stream
            connection.addStream(mediaStream);
            logger.debug('stream added to connection at the caller end');
        }
        catch (err) {
            streembit.notify.error_popup("call_contact error %j", err);
        }
    }
    
    
    function onStreamRemoved(streamId) {
        try {
            logger.debug('Remove remote stream from contact video element');
            
            module.hangup();
        }
        catch (err) {
            logger.error("onStreamRemoved error " + err.message);
        }
    }
    
    
    function onRemoteStreamEnded(event) {
        
        logger.debug('onRemoteStreamEnded()');
    }
    
    function onRemoteStreamRemoveTrack(event) {
        
        logger.debug('onRemoteStreamRemoveTrack()');
    }
    
    function onRemoteStreamAdded(eventStream) {
        try {
 
            logger.debug('Bind remote stream to screen video element');
            // Bind the remote stream to the contact video control
            
            //  screenVideo should be initialised by now
            attachMediaStream(screenVideo, eventStream);
                
            //TODO this changed with Chromium 45
            eventStream.onended = onRemoteStreamEnded;
            eventStream.onremovetrack = onRemoteStreamRemoveTrack;
            
            app_events.emit(app_events.APPEVENT, app_events.TYPES.ONVIDEOCONNECT);
        }
        catch (err) {
            logger.error("onRemoteStreamAdded error: %j", err);
        }
    }
    
    // private variables and methods
    function onStreamCreated(stream) {
        try {
            logger.debug('Received local stream');
            
            if (module.options.calltype == "videocall") {
                attachMediaStream(localVideo, stream);
            }
            else {
                var audioTracks = stream.getAudioTracks();
                logger.debug('Using audio device: ' + audioTracks[0].label);
            }
            
            mediaStream = stream;
            
            // create the connection and perform the call
            if (module.is_outgoing_call) {
                call_contact();
            }
        }
        catch (err) {
            logger.error("onStreamCreated error " + err.message);
        }
    }
    
    //  public methods
    module.offer_screenshare = function (options) {
        try {
            module.options = options;
            module.is_outgoing_call = options.iscaller;
            module.connection = null;
            module.videoconnfn_callback = options.videoconnfn
            
            logger.debug("Screen share to %s", options.contact.name);            

            if (!module.scn) {
                module.scn = nw.Screen.Init();
            }

            // get video stream, nw.js prompts only "entire screen" available
            module.scn.chooseDesktopMedia(["screen"], function (streamId, args) {
                
                navigator.webkitGetUserMedia({
                    audio: false,
                    video: {
                        mandatory: {
                            chromeMediaSource: 'desktop',
                            chromeMediaSourceId: streamId,
                            maxWidth: 1280,
                            maxHeight: 720,
                            minFrameRate: 20,
                            maxFrameRate: 60
                        },
                        optional: []
                    }
                },
                function (stream) {
                    // set stream of source of video element
                    //screenVideo.src = window.URL.createObjectURL(stream);
                    //screenVideo.onloadedmetadata = function (e) {
                    //    video.play();
                    //};
             
                    // create the connection and perform the call
                    call_contact(stream);

                },
                function (err) {
                    streembit.notify.error_popup("Share screen error: %j", err);
                });
            });
        }
        catch (err) {
            streembit.notify.error_popup("Share screen error: %j", err);
        }
    }
    
    module.accept_screenshare = function (screenvideo, options) {
        try {
            module.options = options;
            module.is_outgoing_call = options.iscaller;
            module.connection = null;
            module.videoconnfn_callback = options.videoconnfn
            
            logger.debug("Screen share to %s", options.contact.name);
            
            screenVideo = document.getElementById(screenvideo);
            
            // initialize the audio call module
            streembit.AutoAudioCall.init(options);
        }
        catch (err) {
            streembit.notify.error_popup("Share screen error: %j", err);
        }
    }
    
    module.hangup = function () {
        logger.debug("ShareScreenCall hangup()");
        
        // hangup the audio connection
        try {
            streembit.AutoAudioCall.hangup();            
        }
        catch (e) { }

        if (module.connection) {
            try {
                module.connection.close();
                module.connection = null;
            }
            catch (e) { }
        }
        
        try {
            if (mediaStream) {
                mediaStream.getAudioTracks().forEach(function (track) {
                    track.stop();
                });
                
                mediaStream.getVideoTracks().forEach(function (track) {
                    track.stop();
                });
            }
        }
        catch (e) { }
        
        try {
            if (screenVideo) {
                screenVideo.src = '';
            }
        }
        catch (e) { }
    }
    
    return module;

}(streembit.ShareScreenCall || {}, streembit.logger, global.appevents, streembit.config));


streembit.AutoAudioCall = (function (module, logger, app_events, config) {
    
    module.options = {};
    module.is_outgoing_call = false;
    module.connection = 0;
    module.ice_servers = config.ice_resolvers;
    
    //var localVideo;
    //var contactVidElement;
    var mediaStream;
    var remoteStream;
    
    function create_connection() {
        logger.debug('WebRTC: creating connection for ' + module.options.contact.name);
        
        // Create a new PeerConnection
        var servers = { iceServers: module.ice_servers };
        var connection = new RTCPeerConnection(servers);
        
        // ICE Candidate Callback
        connection.onicecandidate = function (event) {
            if (event.candidate) {
                // Found a new candidate
                logger.debug('WebRTC: onicecandidate, candidate: %j', event.candidate);
                var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTCAA, type: "candidate", "candidate": event.candidate };
                streembit.PeerNet.send_peer_message(module.options.contact, message);
            } 
            else {
                logger.debug('WebRTC: ICE candidate gathering is completed');
                if (remoteStream) {
                    logger.debug('WebRTC: call onRemoteStreamAdded()');
                    onRemoteStreamAdded(remoteStream);
                }
            }
        };
        
        connection.onstatechange = function () {
            var states = {
                'iceConnectionState': connection.iceConnectionState,
                'iceGatheringState': connection.iceGatheringState,
                'readyState': connection.readyState,
                'signalingState': connection.signalingState
            };
            
            logger.debug(JSON.stringify(states));
        };
        
        connection.onnegotiationneeded = function () {
            if (module.is_outgoing_call) {
                logger.debug('WebRTC: connection.onnegotiationneeded -> create offer');
                
                // Send an offer for a connection
                connection.createOffer(
                    function (desc) {
                        try {
                            connection.setLocalDescription(desc, function () {
                                logger.debug("WebRTC: createOffer() callback. Send sdp localDescription");
                                var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTCAA, type: "sdp", "sdp": connection.localDescription };
                                streembit.PeerNet.send_peer_message(module.options.contact, message);
                            });
                        }
                        catch (err) {
                            streembit.notify.error("setLocalDescription error: %j", err);
                        }
                    }, 
                    function (error) {
                        logger.error('connection createOffer error: ' + error);
                    }
                );
            }
        }
        
        connection.onaddstream = function (evt) {
            logger.debug('WebRTC: connection.onaddstream, set remote stream');
            remoteStream = evt.stream;
            if (module.is_outgoing_call) {
                logger.debug('WebRTC: call onRemoteStreamAdded()');
                onRemoteStreamAdded(evt.stream);
            }
        };
        
        connection.onremovestream = function (event) {
            logger.debug('WebRTC: connection.onremovestream');
            // A stream was removed
            onStreamRemoved(event.stream.id);
        };
        
        // And return it
        return connection;
    }
    
    function getConnection() {
        if (!module.connection) {
            module.connection = create_connection();
        }
        return module.connection;
    }
    
    // Process a newly received Candidate signal
    function onCandidateSignalReceived(connection, candidate) {
        logger.debug('WebRTC: candidate %j', candidate);
        try {
            connection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        catch (err) {
            streembit.notify.error("addIceCandidate error: %j", err);
        }
    }
    
    // Process a newly received SDP signal
    function onSdpSignalReceived(connection, sdp) {
        
        logger.debug('WebRTC: processing sdp signal');
        
        var tdesc = new RTCSessionDescription(sdp);
        //logger.debug('sdp desc %j', tdesc);
        logger.debug('desc.type == ' + tdesc.type);
        
        try {
            connection.setRemoteDescription(
                tdesc, 
                function () {
                    if (connection.remoteDescription.type == "offer" && !module.is_outgoing_call) { //  only the callee creates an answer
                        logger.info('WebRTC: received offer, sending response');
                        onReadyForStream(connection);
                        connection.createAnswer(
                            function (desc) {
                                connection.setLocalDescription(desc, function () {
                                    logger.debug('WebRTC: send sdp connection.localDescription:');
                                    logger.debug('%j', connection.localDescription);
                                    var message = { cmd: streembit.DEFS.PEERMSG_CALL_WEBRTCAA, type: "sdp", "sdp": connection.localDescription };
                                    streembit.PeerNet.send_peer_message(module.options.contact, message);
                                });
                            },
                            function (error) {
                                logger.error('Error creating session description: ' + error);
                            }
                        );
                    } 
                    else if (connection.remoteDescription.type == "answer") {
                        logger.info('WebRTC: caller setRemoteDescription success');
                    }
                },
                function (error) {
                    logger.error('setRemoteDescription error: %j', error);
                }
            );
        }
        catch (err) {
            streembit.notify.error("setRemoteDescription error: %j", err);
        }
    }
    
    // Hand off a new signal from the signaler to the connection
    // listen on the data received event
    module.onSignalReceive = function (data) {
        //var signal = JSON.parse(data);
        var connection = getConnection();
        
        logger.debug('WebRTC: received signal type: %s', data.type);
        
        // Route signal based on type
        if (data.sdp) {
            onSdpSignalReceived(connection, data.sdp);
        } 
        else if (data.candidate) {
            onCandidateSignalReceived(connection, data.candidate);
        }
        else {
            logger.error('onReceiveSignal error: unknown signal type');
        }
    }
    
    module.toggle_audio = function (ismute, callback) {
        var audioTracks = mediaStream.getAudioTracks();
        if (audioTracks.length === 0) {
            logger.debug('toggle_audio() No local audio available.');
            return;
        }
        
        logger.debug('Toggling audio mute state.');
        for (var i = 0; i < audioTracks.length; ++i) {
            audioTracks[i].enabled = !audioTracks[i].enabled;
        }
        
        logger.debug('Audio ' + (audioTracks[0].enabled ? 'unmuted.' : 'muted.'));
        callback();
    }
    
    function onReadyForStream(connection) {
        try {
            if (!mediaStream) {
                return streembit.notify.error_popup('Invalid media stream');
            }
            
            connection.addStream(mediaStream);
        }
        catch (err) {
            logger.error("onReadyForStream error " + err.message);
        }
    }
    
    //  public methods
    function call_contact() {
        try {
            if (!mediaStream) {
                return streembit.notify.error_popup('Invalid media stream');
            }
            
            //  create a connection 
            var connection = getConnection(module.options.contact.name);
            // Add our audio/video stream
            connection.addStream(mediaStream);
            logger.debug('stream added to connection at the caller end');
        }
        catch (err) {
            streembit.notify.error_popup("call_contact error %j", err);
        }
    }
    
    
    function onStreamRemoved(streamId) {
        try {
            logger.debug('Remove remote stream from contact video element');
            
            module.hangup();
        }
        catch (err) {
            logger.error("onStreamRemoved error " + err.message);
        }
    }    
    
    function onRemoteStreamEnded(event) {        
        logger.debug('onRemoteStreamEnded()');
    }
    
    function onRemoteStreamRemoveTrack(event) {        
        logger.debug('onRemoteStreamRemoveTrack()');
    }
    
    function onRemoteStreamAdded(eventStream) {
        try {
            logger.debug('Bind remote stream to audio element');
            var audio = document.getElementById('contactaudio');
            audio.srcObject = eventStream; //event.stream;
            logger.debug('Remote stream binded to audio element');
        }
        catch (err) {
            logger.error("onRemoteStreamAdded error: %j", err);
        }
    }
    
    // private variables and methods
    function onStreamCreated(stream) {
        try {
            logger.debug('Received local stream');
            
            var audioTracks = stream.getAudioTracks();
            logger.debug('Using audio device: ' + audioTracks[0].label);
            
            mediaStream = stream;
            
            // create the connection and perform the call
            if (module.is_outgoing_call) {
                call_contact();
            }
        }
        catch (err) {
            logger.error("onStreamCreated error " + err.message);
        }
    }
    
    //  public methods
    module.init = function (options) {
        try {
            module.options = options;
            module.is_outgoing_call = options.iscaller;
            module.connection = null;
            
            logger.debug("auto audio call with %s", options.contact.name);
            
            var params = { audio: true, video: false };

            navigator.mediaDevices.getUserMedia(params)
            .then(onStreamCreated)
            .catch(function (error) {
                if (error.name === 'ConstraintNotSatisfiedError') {
                    streembit.notify.error_popup('The resolution ' + constraints.video.width.exact + 'x' + constraints.video.width.exact + ' px is not supported by your device.');
                } 
                else if (error.name === 'PermissionDeniedError') {
                    streembit.notify.error_popup('Permissions have not been granted to use your camera and microphone, you need to allow the page access to your devices in order for the demo to work.');
                }
                else {
                    streembit.notify.error_popup('getUserMedia error: %j', error);
                }
            });
        }
        catch (err) {
            streembit.notify.error_popup("Media call init error %j", err);
        }
    }
    
    module.hangup = function () {
        logger.debug("AutoAudioCall hangup()");
        if (module.connection) {
            try {
                module.connection.close();
                module.connection = null;
            }
            catch (e) { }
        }
        
        try {
            if (mediaStream) {
                mediaStream.getAudioTracks().forEach(function (track) {
                    track.stop();
                });
            }
        }
        catch (e) { }        
    }
    
    return module;

}(streembit.AutoAudioCall || {}, streembit.logger, global.appevents, streembit.config));


