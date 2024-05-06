FROM node:21-alpine
RUN apk update && apk upgrade && apk add --no-cache openssl
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production
COPY ./src ./src

CMD npm start
