# Kubernetes Lightweight Logger for AKS

Based on the great example set by <a target="_blank" href="https://github.com/ashleydavis/kubernetes-log-aggregation-example">Ashley Davis</a>

Here are the env vars required to configure this solution:

```yaml
env:
- name: STORAGE_ACCOUNT_NAME
    value: <what's your storage account name?>
- name: STORAGE_ACCOUNT_URL_SUFFIX
    value: blob.core.windows.net <or something different if non standard - i.e. gov cloud>
- name: STORAGE_ACCOUNT_CONTAINER_NAME
    value: <the storage account container name to create / use>
- name: STORE_BY_DATE
    value: "true" <or false if you just want one big never ending file per container name>
- name: WATCH_CONTAINERS
    value: "" <CSV of string to look for in container names. Uses 'contains' logic. Doesn't support wildcards. Leave black to get all container logs [also, that's a bit excessive - get a logging strategy!]>
- name: WATCH_MESSAGE_FILTERS
    value: "" <CSV of string to look for in log messages. Uses 'contains' logic. Doesn't support wildcards. Avoid caputring every output message if you only care about some!>
- name: STORAGE_ACCOUNT_KEY
    valueFrom:
    secretKeyRef:
        name: azstoragecreds
        key: storagekey
        optional: false
```

Use a secret for that last env var. It should be your storage key for the storage account.
`kubectl create secret generic azstoragecreds --namespace kube-system --from-literal=storagekey=<insertstoragekeyhere>`
