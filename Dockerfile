# CPU-only image for the API + UI. Zetaris and the Meterless Runtime run outside this container;
# SAMPLE_MODE=true replays a recorded live run with no external services.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
COPY sql ./sql
COPY eval ./eval
COPY input_examples ./input_examples
COPY recordings ./recordings
COPY data ./data
ENV PORT=8795 HOST=0.0.0.0 SAMPLE_MODE=true
EXPOSE 8795
CMD ["npx", "tsx", "src/server.ts"]
