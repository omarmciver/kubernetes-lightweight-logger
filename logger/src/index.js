//
// A Node.js-based microservice for log aggregation on Kubernetes.
// This microservice must be deployed to Kubernetes as a Daemonset so that it can run on each node in the cluster.
//

'use strict';

const tail = require("tail");
const globby = require("globby");
const chokidar = require("chokidar");
const path = require("path");

// Azure Storage Account information
const { BlobServiceClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
const { isNullOrUndefined } = require("util");
const account = process.env.STORAGE_ACCOUNT_NAME;
const accountUrl = `https://${account}.${process.env.STORAGE_ACCOUNT_URL_SUFFIX}`
const accountKey = process.env.STORAGE_ACCOUNT_KEY;

// Use StorageSharedKeyCredential with storage account and account key
const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
const blobServiceClient = new BlobServiceClient(accountUrl, sharedKeyCredential);

// The target container and containerclient for Azure storage account
const containerName = process.env.STORAGE_ACCOUNT_CONTAINER_NAME;
let containerClient = null;


let watchContainers = process.env.WATCH_CONTAINERS?.split(",").filter(el => el != "");
watchContainers.forEach(el => el.toLowerCase().trim());
let filterByMessage = process.env.WATCH_MESSAGE_FILTERS?.split(",").filter(el => el != "");
filterByMessage.forEach(el => el.toLowerCase().trim());

// The directory on the Kubernetes node that contains log files for pods running on the node.
const LOG_FILES_DIRECTORY = "/var/log/containers";

// A glob that identifies the log files we'd like to track.
const LOG_FILES_GLOB = [
    `${LOG_FILES_DIRECTORY}/**/*.log`,                 // Track all log files in the log files diretory.
    `!${LOG_FILES_DIRECTORY}/*kube-system*.log`,    // Except... don't track logs for Kubernetes system pods.
];

//
// Map of log files currently being tracked.
//
const trackedFiles = {};

//
// This function is called when a line of output is received from any container on the node.
//
async function onLogLine(containerName, blockBlobClient, line) {
    //
    // At this point you want to forward your logs to someother log collector for aggregration.
    // For this simple example we'll just print them as output from this pod.
    //

    let shouldLog = true;
    if (filterByMessage !== undefined) {
        if (Array.isArray(filterByMessage) && filterByMessage.length > 0) {
            shouldLog = false;
            filterByMessage.forEach(element => {
                if (line.toLowerCase().includes(element)) {
                    shouldLog = true;
                }
            });
        }
    }

    if (shouldLog === false)
        return;

    const data = JSON.parse(line); // The line is a JSON object so parse to extract relevant data.
    const isError = data.stream === "stderr"; // Is the output an error?
    const level = isError ? "error" : "info";

    //Write to storage account....
    const content = `${containerName}/[${level}] : ${data.log}`;
    await blockBlobClient.appendBlock(content, content.length);
}

//
// Commence tracking a particular log file.
//
async function trackFile(logFilePath) {
    const logFileTail = new tail.Tail(logFilePath);
    trackedFiles[logFilePath] = logFileTail; // Take note that we are now tracking this file.
    const logFileName = path.basename(logFilePath);
    const containerName = logFileName.split("_")[0]; // Super simple way to extract the container name from the log filename.

    if (watchContainers !== undefined) {
        if (Array.isArray(watchContainers) && watchContainers.length > 0 && watchContainers.some(watchEl => containerName.includes(watchEl)) !== true)
            return;
    }

    // Setup client for azure storage account
    const destBlobName = `${containerName}.log`
    const blockBlobClient = containerClient.getAppendBlobClient(destBlobName);
    await blockBlobClient.createIfNotExists();
    logFileTail.on("line", async line => await onLogLine(containerName, blockBlobClient, line));

    //Output tracking info
    console.log(`Tracking container ${containerName} in file ${logFileName} and streaming to ${destBlobName}`);
}

//
// Identify log files to be tracked and start tracking them.
//
async function trackFiles() {
    const logFilePaths = await globby(LOG_FILES_GLOB);
    for (const logFilePath of logFilePaths) {
        if (trackedFiles[logFilePaths]) {
            continue; // Already tracking this file, ignore it now.
        }
        await trackFile(logFilePath); // Start tracking this log file we just identified.
    }
}


async function main() {
    // Setup Azure container

    let containerExists = false;
    let containers = blobServiceClient.listContainers();
    for await (const container of containers) {
        if (container.name === containerName) {
            containerExists = true;
            break;
        }
    }

    containerClient = blobServiceClient.getContainerClient(containerName);
    if (containerExists === false) {
        await containerClient.create();
    }

    console.log("Watch Containers: " + watchContainers + ` (${watchContainers.length})`);
    console.log("Message Filters: " + filterByMessage + ` (${filterByMessage.length})`);
    //
    // Start tracking initial log files.
    //
    await trackFiles();

    //
    // Track new log files as they are created.
    //
    chokidar.watch(LOG_FILES_GLOB)
        .on("add", async newLogFilePath => await trackFile(newLogFilePath));
}

main()
    .then(() => console.log("Online"))
    .catch(err => {
        console.error("Failed to start!");
        console.error(err && err.stack || err);
    });
