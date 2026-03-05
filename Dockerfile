FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build && npm prune --production

ENV MCP_TRANSPORT=http
ENV PORT=3001
ENV DKG_NODE_1=https://theblackbox.network/node1
ENV DKG_NODE_2=https://theblackbox.network/node2
ENV DKG_NODE_3=https://theblackbox.network/node3
ENV DKG_NODE_4=https://theblackbox.network/node4
ENV DKG_NODE_5=https://theblackbox.network/node5

EXPOSE 3001

CMD ["node", "dist/index.js"]
