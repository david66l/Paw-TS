FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
RUN apk add --no-cache bash git ripgrep libstdc++ && npm install -g @anthropic-ai/claude-code@2.1.224
ENV DISABLE_AUTOUPDATER=1
