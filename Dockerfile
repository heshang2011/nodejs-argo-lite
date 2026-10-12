# 固定 22-alpine：node:alpine / lts-alpine / 24-alpine 已不再发布 linux/arm/v7，
# 用它们会导致 arm/v7 构建失败。22-alpine 覆盖 amd64 / arm64 / arm/v7。
FROM node:22-alpine

# 下载 Xray / cloudflared 需要解压与证书
RUN apk add --no-cache unzip curl ca-certificates

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY disguise.html ./
COPY bin ./bin

# 按目标架构只保留匹配的探针二进制，其余删除，避免镜像里塞进用不到的架构。
# TARGETARCH/TARGETPLATFORM 由 Buildx 注入；普通 docker build 时为空，此时全部保留。
ARG TARGETARCH
ARG TARGETVARIANT
RUN set -eux; \
    if [ -z "${TARGETARCH}" ]; then \
      echo "TARGETARCH 未设置，保留全部探针二进制"; \
    else \
      case "${TARGETARCH}${TARGETVARIANT}" in \
        amd64) keep="vps-dog-linux-amd64" ;; \
        arm64) keep="vps-dog-linux-arm64" ;; \
        armv7|arm) keep="vps-dog-linux-armv7" ;; \
        armv6) \
          echo "armv6 不受支持：Xray 与 cloudflared 均无可用 armv6 构建" >&2; \
          exit 1 ;; \
        *) keep="" ;; \
      esac; \
      if [ -n "${keep}" ]; then \
        for f in bin/*; do \
          if [ "$(basename "$f")" != "${keep}" ]; then rm -f "$f"; fi; \
        done; \
      fi; \
    fi; \
    chmod +x bin/* 2>/dev/null || true; \
    rm -f bin/*.exe; \
    ls -l bin

ENV PORT=3000 \
    ARGO_PORT=8001 \
    FILE_PATH=/app/tmp \
    SHOW_LOG=true

EXPOSE 3000

CMD ["node", "index.js"]
