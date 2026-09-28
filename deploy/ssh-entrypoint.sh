#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# This key cannot open a shell, forward ports, use SFTP, or alter deployment scripts.
read -r action component revision extra <<< "${SSH_ORIGINAL_COMMAND:-}"
[[ -z "${extra:-}" && "$component" =~ ^(backend|frontend)$ && "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
case "$action" in
  upload)
    mkdir -p /opt/sellerpro/incoming
    archive="/opt/sellerpro/incoming/${component}-${revision}.tar.gz"
    # Limit an uploaded artifact to 1 GiB. Atomic rename avoids partial releases.
    ulimit -f 1048576
    dd of="${archive}.partial" status=none
    mv "${archive}.partial" "$archive"
    ;;
  deploy) exec /opt/sellerpro/release.sh "$component" "$revision" ;;
  *) exit 2 ;;
esac
