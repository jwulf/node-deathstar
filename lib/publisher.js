var async = require('async'),
    jsondb = require('./Books'),
    authenticated = false,
    spawn = require('child_process').spawn,
    nexpect = require('nexpect'),
    path = require('path'), 
    wrench = require('wrench'),
    humanize = require('humanize'),
    fs = require('fs'),
    mv = require('mv'),
    ephemeral = require('./ephemeralStreams'),
    livePatch = require('./livePatch'),
    PUBLISH_DIR = process.cwd() + '/publish/',
    MAX_SIMULTANEOUS_PUBLISH = 1, // Kerberos ticket needs to be unique on the OS
    LOG_HEADER = ephemeral.LOG_HEADER,
    LOG_CONSOLE = ephemeral.LOG_CONSOLE,
    LOG_TIMESTAMP = ephemeral.LOG_TIMESTAMP,
    mutex = false,
    CODE_PUBLISH_UNKNOWN = 1,
    CODE_PUBLISH_SUCCESS = 0;

/*

Book properties related to publishing:

publishID - uuid for ephemeral streams
publishlog - absolute filepath to publish log
hasPublishLog - has publish log in public html dir
publishing -  is being published atm
onPublishQueue - is currently in the queue for publishing
inBrew - task is in brew

*/

exports.publish = publish;

function publish (url, id, kerbid, kerbpwd, commitmsg) {
    var Books = jsondb.Books,
        my,
        publishlogURLPath = path.normalize('/' + Books[url][id].bookdir + '/publish.log'),
        publishlog = path.normalize(process.cwd() + '/' + publishlogURLPath);
        
    console.log('Publisher called for ' + url + ' ' + id);
    if (Books[url] && Books[url][id]) {
        my = Books[url][id];
        // We will need to build the book in a secure location, so that we publish the right state
        // Eventually we'll check the book out, build it with Publican, then publish it asynchronously from the file system    
        // For now, we'll just queue a csprocessor publish command.
        // This means the book is published as it is when it hits the front of the queue, not as it is when the publish
        // was requested.
        
        my.set('publishing', true);
        ephemeral.createStream('publish', url, id, publishlog, function (err, publishUUID) {
            my.setMany({
                onPublishQueue: true,
                inBrew: false,
                brewTask: '',
                publishID: publishUUID,
                publishlog: publishlog
            });
            ephemeral.write(publishUUID, 'Queuing publish job for ' + url + ' ' + id, [LOG_CONSOLE, LOG_HEADER]);
            ephemeral.write(publishUUID, my.title, [LOG_CONSOLE, LOG_HEADER]);
            mutexPublish({url: url, id: id, kerbid: kerbid, kerbpwd: kerbpwd, commitmsg: commitmsg}, publishComplete);
        });
    }  else {
        console.log('Book: ' + url + ' ' + id + ' not found in database.');
    }
}

function mutexPublish (task, endThisPublishcb){
    async.whilst( 
        function () { return mutex },
        function (cb) {
            cb();
            // do Nothing - waiting for the mutex to start another publish
        },
        function() {
            doPublish(task, endThisPublishcb);
        }
    );    
}

function allowNewPublish () {
    mutex = false;
}

function doPublish (task, endThisPublishcb) {
    var url = task.url,
        id = task.id,
        kerbid = task.kerbid,
        kerbpwd = task.kerbpwd,
        commitmsg = task.commitmsg,
        Books = jsondb.Books,
        publishUUID = Books[url][id].publishUUID;
        
    mutex = true; // Grab the mutex
    Books[url][id].set('onPublishQueue',  false);
    ephemeral.write(publishUUID, 'Commencing publish for ' + url + ' ' + id, [LOG_CONSOLE, LOG_HEADER]);
    getKerberosTicket(publishUUID, kerbid, kerbpwd, function (err) {
        csprocessorPublish(url, id, commitmsg, endThisPublishcb);       
    });    
}

function publishComplete (url, id, uuid, result_code, msg) {
    exports.publishJobs[uuid].kill('SIGTERM');
    jsondb.Books[url][id].notify(msg);
}

function getKerberosTicket (publishUUID, kerbid, kerbpwd, cb) {
        
    // Run kdestroy to be doubly, doubly sure
    // Then get a Kerberos ticket
        
    kdestroy(publishUUID, function(err) {
        ephemeral.write(publishUUID, 'Requesting a new Kerberos ticket', LOG_HEADER);
        nexpect.spawn('kinit ', [kerbid + '@REDHAT.COM'])
            .expect('Password for ' + kerbid + '@REDHAT.COM')
            .sendline(kerbpwd)
            .run(function (err) {
                if (!err) {
                    ephemeral.write(publishUUID, 'Kerberos authentication complete', LOG_HEADER);
                    if (cb) cb(err);
                } else {
                    ephemeral.write(publishUUID, 'Kerberos authentication error: ' + err, [LOG_HEADER, LOG_CONSOLE]);
                }
            });
    });       
}

function kdestroy (pubID, cb) { 
    ephemeral.write(pubID, 'Destroying Kerberos tickets', LOG_HEADER);
    // Destroy all kerberos tickets
    var kdestroyer = spawn('kdestroy', [], {
        cwd: process.cwd()
        }).on('exit', function(err) {
            if (err) {ephemeral.write(pubID, err);}
            if (cb) cb(err);
        });    
    kdestroyer.stdout.setEncoding('utf8');
    kdestroyer.stderr.setEncoding('utf8');
    if (pubID) {
        console.log('Piping kdestroy output to ' + pubID);
        kdestroyer.stdout.pipe(ephemeral.streams[pubID].stream);
        kdestroyer.stderr.pipe(ephemeral.streams[pubID].stream);
    }
}

function csprocessorPublish(url, id, commitmsg, endThisPublishcb){
    var Books = jsondb.Books,
        my = Books[url][id],
        commandopts = commitmsg ? ['publish', '--fetch-pubsnum', '--rev-message', '"' + commitmsg +'"', '-H', url, id ] : ['publish', '--fetch-pubsnum', '-H', url, id],
        publishDir = PUBLISH_DIR + id + '-' + jsondb.Books[url][id].builtFilename,
        uuid = my.publishID,    
        BUILDS_DIR = process.cwd() + '/public/builds/',
        pathURLAbsolute = BUILDS_DIR + id + '-' + my.builtFilename,
        dest = pathURLAbsolute + '/publish.log';
    
    if (fs.existsSync(publishDir))
        wrench.rmdirSyncRecursive(publishDir);
        
    fs.mkdirSync(publishDir);
    
    ephemeral.write(uuid, 'Initiated csprocessor publish with options: ' + commandopts, [LOG_CONSOLE, LOG_HEADER, LOG_TIMESTAMP]);
    if (!exports.publishJobs) exports.publishJobs = {};
    exports.publishJobs[uuid] = spawn('csprocessor', commandopts, {
        cwd: publishDir
    }).on('exit', function(err) {
        ephemeral.write(uuid, 'Publish exited with code: ' + err, [ LOG_CONSOLE, LOG_HEADER, LOG_TIMESTAMP]);
        return kdestroy(uuid, function () {
            ephemeral.write(uuid, 'Moving ' + Books[url][id].publishlog + ' to ' +  dest, [LOG_HEADER, LOG_TIMESTAMP]);
            mv(my.publishlog, dest, function(err) {
                if (err) return ephemeral.write(uuid, 'Error moving publish log: ' + err, [LOG_CONSOLE, LOG_TIMESTAMP]); 
                ephemeral.write(uuid, 'Moved ' + my.publishlog + ' to ' +  dest, [LOG_HEADER, LOG_CONSOLE]);
            });
            // move publish log to public directory
            if (fs.existsSync(publishDir))
                wrench.rmdirSyncRecursive(publishDir);
            ephemeral.retire(uuid);
            my.remove('publishID');
            my.setMany({
                publishing: false,
                hasPublishLog: true
            });
            jsondb.write();
            if (! my.inBrew) { 
                allowNewPublish();
                if (endThisPublishcb) return endThisPublishcb(url, id, uuid, CODE_PUBLISH_UNKNOWN, 'Looks like publishing failed. Check the <a target="_blank" href="/builds/'
                     + id + '-' + my.builtFilename + '/publish.log">publishing log for this book</a>');
            } 
        });
    });
    exports.publishJobs[uuid].stdout.setEncoding('utf8');
    exports.publishJobs[uuid].stderr.setEncoding('utf8');
    exports.publishJobs[uuid].stdout.on('data', function(data){ 
        ephemeral.write(uuid, data, LOG_HEADER);
        if (data.indexOf('Watching tasks (this may be safely interrupted)...') != -1) {
            my.set('inBrew', true);
            allowNewPublish();
        }
        if (data.indexOf('Task info: http://brewweb.devel.redhat.com/brew/taskinfo') != -1)
        {
            my.brewTask = data.substr(data.indexOf('http://'));
        }
        
        // TODO: Deal with ERROR: 
        // Deal with successful exit
        if (data.indexOf('completed successfully') != -1 && my.inBrew) {
            endThisPublishcb(url, id, uuid, CODE_PUBLISH_SUCCESS, 'This book was successfully <a target ="_blank" href="' + 
                my.brewTask +'">' +  'published to Brew</a>.');
        }
        
    });
    console.log('Piping Publish output to ' + uuid);
   // publishJob.stdout.pipe(ephemeral.streams[uuid].stream);
}

