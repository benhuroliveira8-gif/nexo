FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Instala as dependências primeiro (fica em cache entre builds).
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# Pasta dos anexos (vira um volume do Docker).
RUN mkdir -p /data/uploads && chown node:node /data/uploads

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "src/server.js"]
