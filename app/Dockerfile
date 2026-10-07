# syntax=docker/dockerfile:1
#
# ステージ構成
#   base      Node + Chromium + 日本語フォント(実行・テスト共通の土台)
#   deps      開発依存を含む依存関係
#   test      型チェック・ビルド・全テスト(docker build --target test .)
#   build     本番用の成果物(dist/)を作る
#   prod-deps 本番依存だけをインストールする
#   runtime   実行用イメージ(既定。docker compose up はこれを使う)

ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS base
# chromium               : PDF生成(arm64にもあるため、x86_64・arm64のどちらでも同じ手順で動く)
# fonts-noto-cjk         : 日本語(PDFにはNoto Sans CJK JPの字形で出力される)
# fonts-noto-color-emoji : 絵文字
# fonts-dejavu-core      : 罫線文字(├─│)や記号(✓ →)。CJK等幅の罫線は全角幅で桁がずれるため、コードの等幅はDejaVuを優先する
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-cjk fonts-noto-color-emoji fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS test
# PDFの検証(pdffonts / pdfinfo / pdftotext)に使う
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run typecheck && npm run build && npm test

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM base AS runtime
# 読み取り専用のルートファイルシステムでも動くよう、Chromiumのプロファイル等の書き込み先は /tmp にする
ENV NODE_ENV=production PORT=8080 HOME=/tmp
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server/index.js"]
