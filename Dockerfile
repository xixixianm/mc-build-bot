FROM node:20-bookworm

# Java 21 (for Maven and Gradle builds targeting Minecraft 1.20.5+/1.21.x) + Maven + Gradle.
#
# Debian bookworm's own repos only ship OpenJDK 17, not 21, so we add
# Eclipse Temurin's official Adoptium APT repo to get JDK 21 directly.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      maven \
      gradle \
      python3 \
      build-essential \
      ca-certificates \
      curl \
      gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://packages.adoptium.net/artifactory/api/gpg/key/public | gpg --dearmor -o /etc/apt/keyrings/adoptium.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/adoptium.gpg] https://packages.adoptium.net/artifactory/deb bookworm main" > /etc/apt/sources.list.d/adoptium.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends temurin-21-jdk && \
    rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/temurin-21-jdk-amd64
ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY lib ./lib
COPY commands ./commands
COPY index.js ./

# Persistent build history/stats DB and compiler caches.
# NOTE: no `VOLUME` instruction here — Railway doesn't support the Docker
# VOLUME directive at build time. To persist /app/data across deploys,
# attach a Railway Volume to this path from the service's Settings tab
# in the dashboard instead.
RUN mkdir -p /app/data /app/.cache && chown -R node:node /app/data /app/.cache
ENV DATA_DIR=/app/data
ENV BUILD_CACHE_DIR=/app/.cache

USER node

CMD ["node", "index.js"]
