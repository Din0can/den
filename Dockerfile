FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server.js ./
COPY src/map-generator.js ./src/map-generator.js
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "server.js"]
