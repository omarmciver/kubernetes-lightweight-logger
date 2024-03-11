// Omar McIver - Dec 2022
// A Node.js-based microservice for log aggregation on Kubernetes.
// This microservice must be deployed to Kubernetes as a Daemonset so that it can run on each node in the cluster.
// It will tail logs and write them to an Azure storage account blob and/or the local filesystem as configured by the environment settings
'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as tail from 'tail';
import * as chokidar from 'chokidar';
import { globby } from 'globby';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { hostname } from 'os';

// Constants
const LOG_OUTPUT_DESTINATION = process.env.LOG_OUTPUT_DESTINATION || "AZURE"; // Can be "AZURE", "LOCAL", or "BOTH"
const STORE_BY_DATE = process.env.STORE_BY_DATE === "true"
const LOCAL_LOG_DIRECTORY = process.env.LOCAL_LOG_DIRECTORY || "/kubernetes-logs";
const LOG_FILES_DIRECTORY = "/var/log/containers";
const LOG_FILES_GLOB = [
    `${LOG_FILES_DIRECTORY}/**/*.log`,
    `!${LOG_FILES_DIRECTORY}/*kube-system*.log`,
];
const BATCH_LOG_UPLOAD_TIME_SECONDS = parseInt(process.env.BATCH_LOG_UPLOAD_TIME_SECONDS) || 60; // Default: 1 minute
const BATCH_SIZE_THRESHOLD = 50000;
const CONTAINER_NAME = process.env.STORAGE_ACCOUNT_CONTAINER_NAME;
const watchContainers = process.env.WATCH_CONTAINERS ? process.env.WATCH_CONTAINERS.split(',') : undefined;
const filterByMessage = process.env.FILTER_BY_MESSAGE ? process.env.FILTER_BY_MESSAGE.split(',') : undefined;


// Azure Storage
let sharedKeyCredential, blobServiceClient, containerClient;

if (LOG_OUTPUT_DESTINATION === 'AZURE' || LOG_OUTPUT_DESTINATION === 'BOTH') {
    const account = process.env.STORAGE_ACCOUNT_NAME;
    const accountUrl = `https://${account}.${process.env.STORAGE_ACCOUNT_URL_SUFFIX}`;
    const accountKey = process.env.STORAGE_ACCOUNT_KEY;

    if (account && accountKey) {
        sharedKeyCredential = new StorageSharedKeyCredential(account, accountKey);
        blobServiceClient = new BlobServiceClient(accountUrl, sharedKeyCredential);
        containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    }
}

// Ensure local log directory exists
if (LOG_OUTPUT_DESTINATION === "LOCAL" || LOG_OUTPUT_DESTINATION === "BOTH") {
    if (!fs.existsSync(LOCAL_LOG_DIRECTORY)) {
        fs.mkdirSync(LOCAL_LOG_DIRECTORY, { recursive: true });
    }
}

// Maps
const trackedFiles = {};
const blobClients = {};
const logBatches = {};

// Timer
setInterval(uploadAllLogBatches, BATCH_LOG_UPLOAD_TIME_SECONDS * 1000);

// Main function
async function main() {
    console.log(`Logging target: ${LOG_OUTPUT_DESTINATION}`);
    console.log(`Store By Date: ${STORE_BY_DATE}`);
    console.log(`Watch Containers Filter: ${watchContainers ?? "No Filter"} (${watchContainers?.length})`);
    console.log(`Message Filters: ${filterByMessage ?? "No Filter"} (${filterByMessage?.length})`);

    await trackInitialFiles();
    watchForNewFiles();
}

// Track initial log files
async function trackInitialFiles() {
    const logFilePaths = await globby(LOG_FILES_GLOB);
    for (const logFilePath of logFilePaths) {
        if (!trackedFiles[logFilePath]) {
            await trackFile(logFilePath);
        }
    }
}

// Watch for new log files
function watchForNewFiles() {
    chokidar.watch(LOG_FILES_GLOB)
        .on("add", async newLogFilePath => {
            if (!trackedFiles[newLogFilePath]) {
                await trackFile(newLogFilePath);
            }
        });
}

// Track a log file
async function trackFile(logFilePath) {
    const logFileTail = new tail.Tail(logFilePath);
    trackedFiles[logFilePath] = logFileTail;
    const logFileName = path.basename(logFilePath);
    const containerName = logFileName.split("_")[0];

    if (containerName === hostname) {
        return;
    }

    if (watchContainers !== undefined) {
        if (Array.isArray(watchContainers) && watchContainers.length > 0 && !watchContainers.some(watchEl => containerName.includes(watchEl))) {
            return;
        }
    }

    let destBlobName = `${containerName}.log`
    if (STORE_BY_DATE) {
        destBlobName = `${getDateString()}/${containerName}.log`;
    }

    if (LOG_OUTPUT_DESTINATION === 'AZURE' || LOG_OUTPUT_DESTINATION === 'BOTH') {
        await createBlobClient(containerName, destBlobName);
    }

    logFileTail.on("line", async line => await onLogLine(containerName, line));

    console.log(`Tracking container ${containerName} in file ${logFileName} and ${LOG_OUTPUT_DESTINATION === 'LOCAL' ? 'writing' : 'streaming'} to ${destBlobName}`);
}

// On log line received
async function onLogLine(containerName, line) {
    let shouldLog = true;

    if (filterByMessage !== undefined) {
        if (Array.isArray(filterByMessage) && filterByMessage.length > 0) {
            shouldLog = filterByMessage.some(element => line.toLowerCase().includes(element));
        }
    }

    if (shouldLog) {
        try {
            const data = JSON.parse(line);
            const isError = data.stream === "stderr";
            const level = isError ? "error" : "info";
            const content = `${containerName}/[${level}] : ${data.log}`;
            addToLogBatch(containerName, content);
        } catch (error) {
            const isError = line.toLowerCase().includes("error");
            const level = isError ? "error" : "info";
            const content = `${containerName}/[${level}] : ${line}\n`;
            addToLogBatch(containerName, content);
        }

        if (logBatches[containerName].length >= BATCH_SIZE_THRESHOLD) {
            await uploadLogBatch(containerName);
        }
    }
}

// Append log to a local file
async function appendToLocalLogFile(fileName, content) {
    const dirPath = path.dirname(path.join(LOCAL_LOG_DIRECTORY, fileName));
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    const filePath = path.join(LOCAL_LOG_DIRECTORY, fileName);
    const appendFilePromise = util.promisify(fs.appendFile);
    await appendFilePromise(filePath, content + '\n');
}

// Upload all pending log batches
async function uploadAllLogBatches() {
    for (const containerName of Object.keys(logBatches)) {
        await uploadLogBatch(containerName);
    }
}

// Ensure blob client for a container
async function createBlobClient(containerName, destBlobName) {
    if (!blobClients[containerName]) {
        console.log(`Creating blob client for ${containerName}`);
        const blockBlobClient = containerClient.getAppendBlobClient(destBlobName);
        await blockBlobClient.createIfNotExists();
        blobClients[containerName] = blockBlobClient;
    }
}

// Add log line to batch
function addToLogBatch(containerName, content) {
    if (!logBatches[containerName]) {
        logBatches[containerName] = [];
    }
    logBatches[containerName].push({ containerName, content });
}

// Upload log batch
async function uploadLogBatch(containerName) {
    const batch = logBatches[containerName];
    if (batch && batch.length > 0) {
        const batchContent = batch.map(({ content }) => content).join('\n') + '\n';

        if (LOG_OUTPUT_DESTINATION === 'AZURE' || LOG_OUTPUT_DESTINATION === 'BOTH') {
            await ensureBlobAppendClient(containerName);
            const blockBlobClient = blobClients[containerName];
            await blockBlobClient.appendBlock(batchContent, batchContent.length);
            console.log(`Azure Blob: Uploaded batch of ${batch.length} lines for container ${containerName}`);
        }

        if (LOG_OUTPUT_DESTINATION === "LOCAL" || LOG_OUTPUT_DESTINATION === "BOTH") {
            const localFileName = `${getDateString()}/${containerName}.log`;
            await appendToLocalLogFile(localFileName, batchContent);
            console.log(`Local File System: Appended ${batch.length} lines for container ${containerName} to ${localFileName}`);
        }

        logBatches[containerName].length = 0;
    }
}

// Ensure blob client is correct
async function ensureBlobAppendClient(containerName) {
    let blockBlobClient = blobClients[containerName];

    let expectedDestBlobName = `${containerName}.log`;
    if (STORE_BY_DATE) {
        expectedDestBlobName = `${getDateString()}/${containerName}.log`;
    }

    if (!blockBlobClient || blockBlobClient.name !== expectedDestBlobName) {
        console.log(`Updating blob client for ${containerName}`);
        blockBlobClient = containerClient.getAppendBlobClient(expectedDestBlobName);
        await blockBlobClient.createIfNotExists();
        blobClients[containerName] = blockBlobClient;
    }

    return blockBlobClient;
}

// Get today's date in the correct format for blob name path
function getDateString() {
    const today = new Date();
    return today.toISOString().slice(0, 10);
}

// Graceful shutdown
async function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Starting graceful shutdown.`);
    try {
        await uploadAllLogBatches();
        console.log("All log batches have been uploaded.");
    } catch (error) {
        console.error("Error during shutdown:", error);
    } finally {
        console.log("Graceful shutdown completed. Exiting.");
        process.exit(0);
    }
}

// Listen for termination signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start
main().then(() => console.log("Online")).catch(err => {
    console.error("Failed to start!");
    console.error(err && err.stack || err);
});
