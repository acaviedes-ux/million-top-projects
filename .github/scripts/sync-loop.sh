#!/usr/bin/env bash
#
# sync-loop.sh — runs the price-list sync repeatedly until END_HOUR_UTC.
#
# Called from .github/workflows/sync-pricelists.yml. Each iteration:
#   1. Runs the four sync scripts (seed, update-dates, heal, make-public)
#   2. Commits + pushes if data/projects.json changed
#   3. Sleeps until the next 15-minute boundary
#
# Environment expected (set by the workflow):
#   END_HOUR_UTC                       — stop the loop at this UTC hour
#   GOOGLE_SERVICE_ACCOUNT_EMAIL
#   GOOGLE_PRIVATE_KEY
#   GOOGLE_IMPERSONATE_EMAIL
#   PRICE_LIST_DRIVE_FOLDER_ID
#   DOCS_DRIVE_FOLDER_ID
#   EXTRA_DOCS_FOLDER_IDS
#
# Error handling: each script call is guarded with `|| echo …` so a transient
# Drive API hiccup in one step doesn't kill the loop. The next iteration will
# pick up where this one left off. `set -e` is intentionally NOT used.

set -u   # error on unset vars (catches typos), but NOT -e (we want to keep looping)

git config user.name  "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

iter=0
while [ "$(date -u +%H)" -lt "${END_HOUR_UTC}" ]; do
  iter=$((iter + 1))
  ITER_START=$(date -u +%s)
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  echo "::group::Iter ${iter} — ${TS}"

  echo "→ seed"
  node scripts/seed-pricelists-from-project-folders.js || echo "  ⚠ seed failed (continuing)"

  echo "→ update-dates"
  node scripts/update-pricelist-dates.js               || echo "  ⚠ update-dates failed (continuing)"

  echo "→ heal-trashed"
  node scripts/heal-trashed-pricelists.js              || echo "  ⚠ heal failed (continuing)"

  echo "→ make-public"
  node scripts/make-drive-files-public.js              || echo "  ⚠ make-public failed (continuing)"

  # Commit + push if there are changes. Using -X ours on the pull so that
  # if a manual commit raced ours, our (Drive-derived) projects.json wins —
  # the seeder is deterministic and will re-apply manual changes that match
  # Drive on the next iteration.
  if ! git diff --quiet data/projects.json 2>/dev/null; then
    git add data/projects.json
    git commit -m "chore: auto-sync price lists from Drive" || echo "  ⚠ commit failed"
    git pull --rebase -X ours origin main                   || echo "  ⚠ rebase failed"
    git push                                                || echo "  ⚠ push failed"
    echo "  ✓ pushed"
  else
    echo "  · no changes"
  fi

  echo "::endgroup::"

  # Sleep until the next 15-minute mark. Computed as 900s minus how long this
  # iteration took, with a 30s floor in case the iteration ran long.
  ITER_NOW=$(date -u +%s)
  ITER_TOOK=$((ITER_NOW - ITER_START))
  SLEEP_SECONDS=$((900 - ITER_TOOK))
  if [ "${SLEEP_SECONDS}" -lt 30 ]; then SLEEP_SECONDS=30; fi
  echo "Iter ${iter} took ${ITER_TOOK}s — sleeping ${SLEEP_SECONDS}s until next tick"
  sleep "${SLEEP_SECONDS}"
done

echo "Loop ended at $(date -u). Completed ${iter} iterations."
