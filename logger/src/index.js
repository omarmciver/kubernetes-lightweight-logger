// Omar McIver - Dec 2022
// A Node.js-based microservice for log aggregation on Kubernetes.
// This microservice must be deployed to Kubernetes as a Daemonset so that it can run on each node in the cluster.
// It will tail logs and write them to an Azure storage account blob as configured by the environment settings

'use strict';

// Dependencies
import * as tail from "tail";
import * as chokidar from "chokidar";
import * as path from "path";
import { globby } from "globby";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";


// Azure Storage Account information and logging settings
const account = process.env.STORAGE_ACCOUNT_NAME;
const accountUrl = `https://${account}.${process.env.STORAGE_ACCOUNT_URL_SUFFIX}`
const accountKey = process.env.STORAGE_ACCOUNT_KEY;
const storeByDate = process.env.STORE_BY_DATE === "true";
let watchContainers = process.env.WATCH_CONTAINERS?.split(",").filter(el => el != "");
watchContainers?.forEach(el => el.toLowerCase().trim());
let filterByMessage = process.env.WATCH_MESSAGE_FILTERS?.split(",").filter(el => el != "");
filterByMessage?.forEach(el => el.toLowerCase().trim());

// Use StorageSharedKeyCredential with storage account and account key
const sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
const blobServiceClient = new BlobServiceClient(accountUrl, sharedKeyCredential);

// The target container and containerclient for Azure storage account
const containerName = process.env.STORAGE_ACCOUNT_CONTAINER_NAME;
let containerClient = null;

// The directory on the Kubernetes node that contains log files for pods running on the node.
const LOG_FILES_DIRECTORY = "/var/log/containers";

// A glob that identifies the log files we'd like to track.
const LOG_FILES_GLOB = [
    `${LOG_FILES_DIRECTORY}/**/*.log`,                 // Track all log files in the log files diretory.
    `!${LOG_FILES_DIRECTORY}/*kube-system*.log`,    // Except... don't track logs for Kubernetes system pods.
];

// Map of log files currently being tracked.
const trackedFiles = {};
// Map of blob clients currently being appended.
const blobClients = new Object();

// This function is called when a line of output is received from any container on the node.
async function onLogLine(containerName, line) {

    //Flag to track if we want to log the line based upon 'filtering by message' configuration
    let shouldLog = true;

    // If we have a filter by message list of strings, test if the line contains any of them.
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

    // If the line did not meet the filter, skip logging this line.
    if (shouldLog === false)
        return;

    // If we are partitioning the storage by the date, ensure we factor this in to the expected blob name
    let blockBlobClient = await ensureBlobAppendClient(containerName);

    await writeLogLine(blockBlobClient, containerName, line);
}

// This function is called to actually write a line to a log file in the Azure storage account
async function writeLogLine(blockBlobClient, containerName, line) {
    try {
        const data = JSON.parse(line); // The line is a JSON object so parse to extract relevant data.
        const isError = data.stream === "stderr"; // Is the output an error?
        const level = isError ? "error" : "info";

        //Write to storage account....
        const content = `${containerName}/[${level}] : ${data.log}`;
        await blockBlobClient.appendBlock(content, content.length);
    } catch (error) {
        const isError = line.toLowerCase().includes("error"); // Is the output an error?
        const level = isError ? "error" : "info";

        //Write to storage account....
        const content = `${containerName}/[${level}] : ${line}\n`;
        await blockBlobClient.appendBlock(content, content.length);
    }
}

// This function is called to ensure we are pointing to the correct blob client in the Azure storage account
async function ensureBlobAppendClient(containerName) {
    // Get the blob client to append to.
    let blockBlobClient = blobClients[containerName];

    // Calculate the expected blob name        
    let expectedDestBlobName = `${containerName}.log`;
    if (storeByDate === true) {
        expectedDestBlobName = `${getDateString()}/${containerName}.log`;
    }

    // Ensure the expected blob name matches the current blob append client
    // If not, re-create the blob client and upadate the map
    if (blockBlobClient.name !== expectedDestBlobName) {
        console.log(`Cycling log file from ${blockBlobClient.name} to ${expectedDestBlobName}`);
        blockBlobClient = containerClient.getAppendBlobClient(expectedDestBlobName);
        await blockBlobClient.createIfNotExists();
        blobClients[containerName] = blockBlobClient;
    }
    return blockBlobClient;
}

// This function returns the date today (UTC) in the correct format for the blob name path
function getDateString() {
    let today = new Date();
    return `${today.getUTCFullYear()}-${today.getUTCMonth()}-${today.getUTCDate().toString().padStart(2, '0')}`;
}

// Commence tracking a particular log file.
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
    let destBlobName = `${containerName}.log`
    if (storeByDate === true) {
        destBlobName = `${getDateString()}/${containerName}.log`;
    }

    let blockBlobClient = containerClient.getAppendBlobClient(destBlobName);
    await blockBlobClient.createIfNotExists();
    blobClients[containerName] = blockBlobClient;
    logFileTail.on("line", async line => await onLogLine(containerName, line));

    //Output tracking info
    console.log(`Tracking container ${containerName} in file ${logFileName} and streaming to ${destBlobName}`);
}

// Identify log files to be tracked and start tracking them.
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
