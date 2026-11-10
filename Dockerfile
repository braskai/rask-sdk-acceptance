# No build step and no runtime dependencies: Node and the sources are all it needs.
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY contract ./contract
COPY scenarios ./scenarios
USER node
EXPOSE 4010 4011
ENTRYPOINT ["node", "bin/rask-sdk-acceptance.mjs", "--host", "0.0.0.0"]
