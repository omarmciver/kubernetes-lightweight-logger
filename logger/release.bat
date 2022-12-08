docker build . -t omarmciver/lightweight-aks-container-logger:1
docker tag omarmciver/lightweight-aks-container-logger:1 omarmciver/lightweight-aks-container-logger:latest
docker push omarmciver/lightweight-aks-container-logger:1
docker push omarmciver/lightweight-aks-container-logger:latest
