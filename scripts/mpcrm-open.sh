#!/usr/bin/env bash
# Opens the CRM in the default browser using the private access link.
set -euo pipefail
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/mpcrm/env"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
data_dir="${MPCRM_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mpcrm}"
port="${MPCRM_PORT:-5170}"
if ! systemctl --user is-active --quiet mpcrm.service; then
  systemctl --user start mpcrm.service
  for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
fi
token="$(cat "$data_dir/access-token")"
exec xdg-open "http://127.0.0.1:$port/?t=$token"
