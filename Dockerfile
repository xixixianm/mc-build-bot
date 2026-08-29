FROM node:20-bookworm

# Java (for both Maven and Gradle builds) + Maven + Gradle.
# Both JDK 17 and 21 are installed so users can pick a target with
# `/build java:`; python3/build-essential are needed to compile the
# better-sqlite3 native addon at npm install time.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless \
      openjdk-21-jdk-headless \
      maven \
      gradle \
      python3 \
      build-essential \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Default JAVA_HOME (17); build.js can point individual builds at 21 instead.
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV NODE_ENV=production

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY lib ./lib
COPY commands ./commands
COPY index.js ./

# Persistent build history/stats DB and compiler caches. Mount a volume
# here in production so history and warm caches survive redeploys.
RUN mkdir -p /app/data /app/.cache && chown -R node:node /app/data /app/.cache
ENV DATA_DIR=/app/data
ENV BUILD_CACHE_DIR=/app/.cache

USER node

CMD ["node", "index.js"]
