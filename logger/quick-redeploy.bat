kubectl delete -f ..\kubernetes\logger.yaml
docker build . -t logger:1
minikube image load logger:1
kubectl apply -f ..\kubernetes\logger.yaml