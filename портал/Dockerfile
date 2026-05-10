FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY static ./static
COPY templates ./templates
COPY server.js ./
COPY portal.db* ./

RUN ls -la /app/static && test -f /app/static/style.css && echo "style.css exists" || echo "style.css missing"

EXPOSE 5000
ENV PORT=5000
CMD ["node", "server.js"]
