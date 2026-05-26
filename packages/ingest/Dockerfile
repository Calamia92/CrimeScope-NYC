FROM oven/bun:1.1.42

WORKDIR /app

COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY src ./src

CMD ["bun", "run", "start"]
