FROM oven/bun:1.1.42

WORKDIR /app

COPY package.json ./
RUN bun install

COPY svelte.config.js tsconfig.json vite.config.ts ./
COPY src ./src
RUN bunx svelte-kit sync

EXPOSE 5173

CMD ["bun", "run", "start"]
