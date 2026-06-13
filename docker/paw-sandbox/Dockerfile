FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    findutils \
    git \
    grep \
    procps \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
