FROM docker.io/node:26.12.1-slim AS build
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM build AS test
COPY test ./test
CMD ["npm", "test"]

FROM docker.io/node:26.12.1-slim AS runtime
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY LICENSE ./
COPY --from=build /usr/src/app/dist ./dist
USER node
CMD ["node", "dist/cli.js"]
