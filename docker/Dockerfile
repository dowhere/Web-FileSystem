# syntax=docker/dockerfile:1
FROM node:24-alpine

LABEL org.opencontainers.image.title="Web-FileSystem" \
      org.opencontainers.image.description="Local-first web file manager with a built-in file server"

WORKDIR /app

# The server has no third-party runtime dependencies; package.json is copied so
# Node treats server.js as an ES module ("type": "module").
ENV NODE_ENV=production \
    PORT=5500 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    BUCKET=local

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 5500
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const net=require('node:net');const port=Number(process.env.PORT)||5500;const socket=net.connect(port,'127.0.0.1');socket.once('connect',()=>{socket.end();process.exit(0)});socket.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)"

CMD ["node", "server.js"]
