# Kubernetes Lightweight Logger for AKS

Based on the great example set by <a target="_blank" href="https://github.com/ashleydavis/kubernetes-log-aggregation-example">Ashley Davis</a>

This microservice is designed to aggregate logs from Kubernetes pods and store them either in Azure Blob Storage, locally, or both. It can be deployed as a Daemonset to ensure that it runs on each node in the cluster.

## Environment Variables Configuration

Here are the env vars required to configure this solution:

```yaml
env:
- name: LOG_OUTPUT_DESTINATION
  value: "AZURE" # Can be "AZURE", "LOCAL", or "BOTH" - where do you want the logs to go?

- name: LOCAL_LOG_DIRECTORY
  value: "/kubernetes-logs" # Or wherever you want the logs to be saved locally

- name: BATCH_LOG_UPLOAD_TIME_SECONDS
  value: "60" # Number of seconds before the latest log updates are uploaded to the storage account or saved to the local disk

- name: STORE_BY_DATE
  value: "true" # Set to true if you want to store logs by date, false for one big file per container

- name: WATCH_CONTAINERS
  value: "" # CSV of strings to look for in container names. Uses 'contains' logic. Leave blank to get all container logs.

- name: WATCH_MESSAGE_FILTERS
  value: "" # CSV of strings to look for in log messages. Uses 'contains' logic. Avoid capturing every output message if you only care about some!

- name: STORAGE_ACCOUNT_NAME
  value: <your_storage_account_name>

- name: STORAGE_ACCOUNT_URL_SUFFIX
  value: blob.core.windows.net # Or something different if non-standard, like gov cloud

- name: STORAGE_ACCOUNT_CONTAINER_NAME
  value: <your_storage_account_container_name> # Use a different container name for each cluster if needed

- name: STORAGE_ACCOUNT_KEY
  valueFrom:
    secretKeyRef:
      name: azstoragecreds
      key: storagekey
      optional: false

```

Make sure to create a secret for the STORAGE_ACCOUNT_KEY environment variable. It should be your storage key for the storage account.

`kubectl create secret generic azstoragecreds --namespace kube-system --from-literal=storagekey=<insert_storage_key_here>`

This will ensure secure access to your Azure Blob Storage.