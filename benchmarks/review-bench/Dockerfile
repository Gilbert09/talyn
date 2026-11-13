FROM node:22 AS build
WORKDIR /build
RUN npm install --no-audit --no-fund --save-exact esbuild@0.25.12 croner@10.0.1
COPY packages/shared ./packages/shared
COPY packages/backend/src/services/codeReview ./packages/backend/src/services/codeReview
COPY benchmarks/review-bench ./benchmarks/review-bench
# Drop unused exports from the shared module in this build only.
RUN npm pkg set sideEffects=false --json --prefix packages/shared
RUN ./node_modules/.bin/esbuild benchmarks/review-bench/src/main.ts \
    --bundle --platform=node --format=esm --target=node22 \
    --alias:@talyn/shared=./packages/shared/src/index.ts \
    --outfile=/build/main.js --metafile=/build/meta.json \
    && ! grep -Ei 'drizzle|postgres' /build/main.js /build/meta.json

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.166.0
WORKDIR /app
RUN printf '{"type":"module"}\n' > package.json
COPY --from=build /build/main.js ./main.js
COPY --chmod=755 benchmarks/review-bench/entrypoint.sh ./entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
