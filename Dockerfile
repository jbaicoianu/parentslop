FROM node:20-alpine

WORKDIR /app

# Install build tools for better-sqlite3 native addon, unzip for crsqlite prebuilt binary
RUN apk add --no-cache python3 make g++ unzip

COPY package.json package-lock.json ./
RUN npm ci --production && apk del python3 make g++ unzip

COPY server.js ./
COPY lib/ ./lib/
COPY static/ ./static/

# Stamp build time into footer
RUN sed -i "s/__BUILD_TIME__/$(date -u '+%Y-%m-%d %H:%M UTC')/" static/index.html

# Data directory for SQLite DB and other persistent files (mount EFS here)
RUN mkdir -p /data
VOLUME /data

EXPOSE 8080

CMD ["node", "server.js"]
