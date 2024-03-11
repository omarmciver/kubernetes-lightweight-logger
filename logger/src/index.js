// Omar McIver - Dec 2022
// A Node.js-based microservice for log aggregation on Kubernetes.
// This microservice must be deployed to Kubernetes as a Daemonset so that it can run on each node in the cluster.
// It will tail logs and write them to an Azure storage account blob as configured by the environment settings

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as tail from 'tail';
import * as chokidar from 'chokidar';
import { globby } from 'globby';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { hostname } from 'os';


//Logging destination
const logOutputDestination = process.env.LOG_OUTPUT_DESTINATION || "AZURE"; // Can be "AZURE", "LOCAL", or "BOTH"
const localLogDirectory = process.env.LOCAL_LOG_DIRECTORY || "/kubernetes-logs";

// Azure Storage Account information
const account = process.env.STORAGE_ACCOUNT_NAME;
const accountUrl = `https://${account}.${process.env.STORAGE_ACCOUNT_URL_SUFFIX}`;
const accountKey = process.env.STORAGE_ACCOUNT_KEY;

// Logging settings
const storeByDate = process.env.STORE_BY_DATE === "true";
let watchContainers = process.env.WATCH_CONTAINERS?.split(",").filter(el => el != "");
watchContainers?.forEach(el => el.toLowerCase().trim());
let filterByMessage = process.env.WATCH_MESSAGE_FILTERS?.split(",").filter(el => el != "");
filterByMessage?.forEach(el => el.toLowerCase().trim());

// Only import and use Azure-related components if needed
let sharedKeyCredential, blobServiceClient;
if ((logOutputDestination === 'AZURE' || logOutputDestination === 'BOTH') && account && accountKey && accountUrl) {
    // Use StorageSharedKeyCredential with storage account and account key
    sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
    blobServiceClient = new BlobServiceClient(accountUrl, sharedKeyCredential);
}

// Ensure the local log directory exists
if (logOutputDestination === "LOCAL" || logOutputDestination === "BOTH") {
    if (!fs.existsSync(localLogDirectory)) {
        fs.mkdirSync(localLogDirectory, { recursive: true });
    }
}


// The target container and containerclient for Azure storage account
const containerName = process.env.STORAGE_ACCOUNT_CONTAINER_NAME;
let containerClient = null;

// The directory on the Kubernetes node that contains log files for pods running on the node.
const LOG_FILES_DIRECTORY = "/var/log/containers";

// A glob that identifies the log files we'd like to track.
const LOG_FILES_GLOB = [
    `${LOG_FILES_DIRECTORY}/**/*.log`,                 // Track all log files in the log files directory.
    `!${LOG_FILES_DIRECTORY}/*kube-system*.log`,    // Except... don't track logs for Kubernetes system pods.
];

// Map of log files currently being tracked.
const trackedFiles = {};
// Map of blob clients currently being appended.
const blobClients = new Object();

// Define batch-related variables
const logBatches = {};
const batchUploadPeriod = process.env.BATCH_LOG_UPLOAD_TIME_SECONDS && (parseInt(process.env.BATCH_LOG_UPLOAD_TIME_SECONDS) * 1000) || 60000; // 1 minute in milliseconds

// Utility function to append log to a local file
async function appendToLocalLogFile(fileName, content) {
    const filePath = path.join(localLogDirectory, fileName);
    const appendFilePromise = util.promisify(fs.appendFile);
    await appendFilePromise(filePath, content + '\n');
}

// Timer function to upload log lines in batches
async function uploadLogBatch(containerName) {
    const batch = logBatches[containerName];
    if (batch && batch.length > 0) {
        const batchContent = batch.map(({ content }) => content).join('\n') + '\n';
        if(batch.length === 0)
            return;

        // Azure Blob upload
        if ((logOutputDestination === 'AZURE' || logOutputDestination === 'BOTH') && blobServiceClient) {
            await ensureBlobAppendClient(containerName);
            const blockBlobClient = blobClients[containerName];
            blockBlobClient.appendBlock(batchContent, batchContent.length)
                .then(() => {
                    console.log(`Azure Blob: Uploaded batch of ${batch.length} lines for container ${containerName}`);
                })
                .catch((error) => {
                    console.error('Azure Blob: Failed to upload batch:', error);
                });
        }

        // Local file system writing
        if (logOutputDestination === "LOCAL" || logOutputDestination === "BOTH") {
            const localFileName = `${getDateString}/${containerName}.log`;
            appendToLocalLogFile(localFileName, batchContent)
                .then(() => {
                    console.log(`Local File System: Appended ${batch.length} lines for container ${containerName} to ${localFileName}`);
                })
                .catch((error) => {
                    console.error('Local File System: Failed to append to file:', error);
                });
        }

        logBatches[containerName].length = 0;
    }
}

// This function is called when a line of output is received from any container on the node.
async function onLogLine(containerName, line) {
    // Initialize container-specific batch if not existent
    if (!logBatches[containerName]) {
        logBatches[containerName] = [];
    }
    // Check if containerName matches the hostname
    if (containerName === hostname) {
        return;
    }
    // Flag to track if we want to log the line based upon 'filtering by message' configuration
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

    if (shouldLog) {
        try {
            const data = JSON.parse(line); // The line is a JSON object so parse to extract relevant data.
            const isError = data.stream === "stderr"; // Is the output an error?
            const level = isError ? "error" : "info";

            // Write to storage account....
            const content = `${containerName}/[${level}] : ${data.log}`;
            logBatches[containerName].push({ containerName, content });
        } catch (error) {
            const isError = line.toLowerCase().includes("error"); // Is the output an error?
            const level = isError ? "error" : "info";

            // Write to storage account....
            const content = `${containerName}/[${level}] : ${line}\n`;
            logBatches[containerName].push({ containerName, content });
        }
        // Check batch size for this specific container
        if (logBatches[containerName].length >= 50000) {
            uploadLogBatch(containerName);
        }
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
    // If not, re-create the blob client and update the map
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
    return `${today.getUTCFullYear()}-${(today.getUTCMonth() + 1).toString().padStart(2, '0')}-${today.getUTCDate().toString().padStart(2, '0')}`;
}

// Commence tracking a particular log file.
async function trackFile(logFilePath) {
    const logFileTail = new tail.Tail(logFilePath);
    trackedFiles[logFilePath] = logFileTail; // Take note that we are now tracking this file.
    const logFileName = path.basename(logFilePath);
    const containerName = logFileName.split("_")[0]; // Super simple way to extract the container name from the log filename.

    if (containerName === hostname) {
        return;
    }

    if (watchContainers !== undefined) {
        if (Array.isArray(watchContainers) && watchContainers.length > 0 && watchContainers.some(watchEl => containerName.includes(watchEl)) !== true)
            return;
    }

    let destBlobName = `${containerName}.log`
    if (storeByDate === true) {
        destBlobName = `${getDateString()}/${containerName}.log`;
    }

    if (logOutputDestination === 'AZURE' || logOutputDestination === 'BOTH') {
        // Setup client for Azure storage account
        let blockBlobClient = containerClient.getAppendBlobClient(destBlobName);
        await blockBlobClient.createIfNotExists();
        blobClients[containerName] = blockBlobClient;
    }
    logFileTail.on("line", async line => await onLogLine(containerName, line));

    // Output tracking info
    if (logOutputDestination === 'AZURE' || logOutputDestination === 'BOTH') {
        console.log(`Tracking container ${containerName} in file ${logFileName} and streaming to ${destBlobName}`);
    }
    if (logOutputDestination === 'LOCAL' || logOutputDestination === 'BOTH') {
        console.log(`Tracking container ${containerName} in file ${logFileName} and writing to ${localLogDirectory}/${destBlobName}`);
    }

    // Periodically upload log batches
    setInterval(async () => {
        await uploadLogBatch(containerName);
    }, batchUploadPeriod);
}

// Identify log files to be tracked and start tracking them.
async function trackFiles() {
    const logFilePaths = await globby(LOG_FILES_GLOB);
    for (const logFilePath of logFilePaths) {
        if (trackedFiles[logFilePath]) {
            continue; // Already tracking this file, ignore it now.
        }
        await trackFile(logFilePath); // Start tracking this log file we just identified.
    }
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Graceful shutdown start at ${new Date().toISOString()}`);

    // Attempt to upload all pending log batches
    try {
        const uploadPromises = Object.keys(logBatches).map(containerName => {
            return uploadLogBatch(containerName); // Ensure this function resolves even on failure
        });
        await Promise.all(uploadPromises);

        console.log("All log batches have been uploaded.");

        console.log("Graceful shutdown completed. Exiting.");
        process.exit(0); // Exit cleanly
    } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1); // Exit with error
    }
}

async function main() {
    // Setup Azure container

    console.log(`Logging target: ${logOutputDestination}`);
    if ((logOutputDestination === 'AZURE' || logOutputDestination === 'BOTH') && blobServiceClient && containerName) {
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
        console.log("Azure Storage Account: " + account);
        console.log("Azure Storage Account Container: " + containerName);
    }
    if (logOutputDestination === 'LOCAL' || logOutputDestination === 'BOTH') {
        console.log("Local Log Directory: " + localLogDirectory);
    }
    console.log("Store By Date: " + storeByDate);
    console.log("Watch Containers: " + watchContainers + ` (${watchContainers?.length})`);
    console.log("Message Filters: " + filterByMessage + ` (${filterByMessage?.length})`);
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

// Listen for termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
