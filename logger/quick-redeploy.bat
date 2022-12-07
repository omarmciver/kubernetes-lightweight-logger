kubectl delete -f ..\kubernetes\logger.yaml
docker build . -t logger:2
minikube image load logger:2
kubectl apply -f ..\kubernetes\logger.yaml