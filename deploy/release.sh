#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd /opt/sellerpro
# Serializes both repositories, including DB migrations.
exec 9>/opt/sellerpro/release.lock
flock -w 900 9
component=${1:-}
revision=${2:-}
[[ "$component" == backend || "$component" == frontend ]] || exit 2
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
archive="/opt/sellerpro/incoming/${component}-${revision}.tar.gz"
test -f "$archive"
test -f .env
test -f .images.env
dc() { docker compose --env-file .env --env-file .images.env -f compose.yml "$@"; }
docker load -i "$archive"
docker image inspect "sellerpro-${component}:${revision}" >/dev/null
cp .images.env .images.env.previous
if [[ "$component" == backend ]]; then
  variable=BACKEND_IMAGE
else
  variable=FRONTEND_IMAGE
fi
awk -v key="$variable" -v image="sellerpro-${component}:${revision}" '
  index($0,key "=")==1 {$0=key "=" image; found=1} {print}
  END {if(!found) print key "=" image}
' .images.env > .images.env.next
mv .images.env.next .images.env
# First installation may receive the two independent builds in either order.
# Stage the first image; start the whole application only when both are available.
initial=false
if [[ ! -f .initialized ]]; then
  initial=true
  while IFS= read -r image; do
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      echo "Image staged; waiting for the other repository's first successful release."
      exit 0
    fi
  done < <(dc config --images | grep '^sellerpro-' | sort -u)
fi
rollback() {
  trap - ERR
  if [[ "$initial" == false ]]; then
    cp .images.env.previous .images.env
    dc up -d api worker web || true
    echo 'Release failed; attempted to restore previous images. Database is NOT rolled back.' >&2
  else
    echo 'Initial release failed. No previous version exists; inspect logs before retry.' >&2
  fi
  exit 1
}
trap rollback ERR
dc up -d --wait postgres redis
if [[ "$component" == backend || "$initial" == true ]]; then
  mkdir -p backups
  dc exec -T postgres pg_dump -U sellerpro -d sellerpro -Fc > "backups/pre-${revision}-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # Incompatible schema changes require an explicit maintenance migration, never automatic rollback.
  dc run --rm migrate
  dc up -d --wait --wait-timeout 180 api worker
  if [[ "$initial" == true ]]; then dc up -d --wait --wait-timeout 180 web; fi
else
  dc up -d --wait --wait-timeout 180 web
fi
curl --fail --silent --show-error --retry 6 --retry-delay 5 --retry-all-errors https://sellerpro.org/api/health
curl --fail --silent --show-error --output /dev/null https://sellerpro.org/login
trap - ERR
touch .initialized
echo "Deployed ${component} ${revision}"
# Images, incoming archive and backup retained for operator rollback; do not prune volumes.
