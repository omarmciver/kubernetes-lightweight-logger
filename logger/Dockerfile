FROM node:21-alpine3.19

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production
COPY ./src ./src

CMD npm start
