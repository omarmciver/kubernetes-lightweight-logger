kubectl delete -f ..\kubernetes\logger-local-built-image.yaml
docker build . -t logger:local_build
minikube image load logger:local_build
kubectl apply -f ..\kubernetes\logger-local-built-image.yaml