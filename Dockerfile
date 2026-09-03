# The whole system in one container: the web, a worker, and a first capture.
#
# Two stages so the compiler that builds `better-sqlite3` does not travel to
# production, and both stand on the same base image — a native module built
# against one Node ABI and run against another fails at import time, which is a
# miserable thing to debug inside a container.
#
#   docker build -t trf5 .
#   docker run -p 4321:4321 -v trf5-data:/app/data trf5
#
# The volume is the point: it holds the acervo and the PDFs, so stopping the
# container does not throw away what was captured.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for the one native dependency. Only in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Manifests first: this layer is rebuilt only when the dependencies change,
# not on every edit to the source.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/scraper/package.json packages/scraper/
COPY demo/web/package.json demo/web/
COPY demo/worker/package.json demo/worker/
RUN npm ci

COPY . .
RUN npm run build --workspace demo/web

# ---

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# `tini` so Ctrl-C reaches the processes and a stopped container does not leave
# a worker mid-request against the court.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The source tree comes too, and deliberately: the web starts the worker by
# running `demo/worker/src/cli.ts` with Node's type stripping, exactly as it
# does from a terminal. A production image with only `dist/` could serve pages
# but never capture anything.
COPY --from=build /app /app

# Where the acervo lives. Declared so `docker run` without `-v` still works and
# says, by its presence, which directory is worth keeping.
VOLUME /app/data
ENV PJE_DB=/app/data/pje.db \
    PJE_PDFS=/app/data/pdfs \
    PJE_CHAT_DB=/app/data/chat.db \
    HOST=0.0.0.0 \
    PORT=4321

# The first capture, as a queued job rather than a silent pre-seed: the point of
# this system is that you can watch it work. Empty range means no seeding.
ENV SEED_RANGE=130100-130140 \
    SEED_CONCURRENCY=3 \
    SEED_RATE=2

EXPOSE 4321

# Cheap and honest: the page renders, so the server is up. It says nothing
# about the capture, which may still be running — and should not, or a slow
# court would mark a healthy container unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./docker/start.sh"]
