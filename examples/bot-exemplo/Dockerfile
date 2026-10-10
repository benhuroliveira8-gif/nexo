FROM node:22-alpine
WORKDIR /bot
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.js ./
USER node
CMD ["node", "index.js"]
