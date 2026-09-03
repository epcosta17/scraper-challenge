#!/bin/bash
# Brings up the whole system: a worker, a first capture, and the web.
#
# bash, not sh: `wait -n` — which is what lets either process going down take
# the container with it — is a bash builtin, and /bin/sh on Debian is dash,
# where it does not exist.
#
# The order matters. The web comes up last but the seed is queued first, so by
# the time anyone opens the page there is already something happening on it —
# the queue screen shows a real job with real progress instead of an empty
# system that gives no hint of what it does.
set -eu

DB="${PJE_DB:-/app/data/pje.db}"
PDFS="${PJE_PDFS:-/app/data/pdfs}"
mkdir -p "$(dirname "$DB")" "$PDFS"

# Seed only an empty acervo. A restart with a volume attached must not queue
# the same range again on top of what is already captured.
if [ -n "${SEED_RANGE:-}" ]; then
  node --experimental-strip-types --no-warnings docker/seed.ts "$DB" "$SEED_RANGE" || {
    # A court that cannot be reached is not a reason to refuse to start: the
    # rest of the system — search, the case files, the agent — works on
    # whatever is already stored, and the queue screen will show the failure.
    echo "seed: no se pudo encolar la captura inicial; el sistema arranca igual" >&2
  }
fi

# A worker in watch mode, so anything queued from the UI is picked up too and
# not just the seed.
node --experimental-strip-types --no-warnings demo/worker/src/cli.ts \
  --db "$DB" --out "$PDFS" --watch \
  --concurrency "${SEED_CONCURRENCY:-3}" --rate "${SEED_RATE:-2}" &
WORKER=$!

# Stopping the container stops both, and the worker is given the chance to
# finish the request in flight rather than being cut off mid-capture.
trap 'kill -TERM "$WORKER" 2>/dev/null || true' TERM INT

node ./demo/web/dist/server/entry.mjs &
WEB=$!

# Either one exiting takes the container down, so a dead worker is visible
# instead of a page that quietly stops capturing.
wait -n "$WORKER" "$WEB"
kill -TERM "$WORKER" "$WEB" 2>/dev/null || true
wait
