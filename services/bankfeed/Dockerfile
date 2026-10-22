FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install tsx@4.19.3
COPY services/bankfeed ./services/bankfeed
COPY data/generated/bank ./data/generated/bank
ENV BANKFEED_PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "services/bankfeed/server.ts"]
