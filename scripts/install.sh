#!/usr/bin/env bash
# One-time install for Fedora (or any Linux with systemd). Run from a clone of the repository:
#
#   bash scripts/install.sh              install, or reinstall over an existing install
#   bash scripts/install.sh --uninstall  remove the app and its services (your data is kept)
#
# Afterwards the app runs in the background whenever you are logged in, checks for new versions every
# hour, and installs them when you click "Restart now" (or by itself at 3 AM).
# Your data stays in ~/.local/share/mpcrm (or MPCRM_DATA_DIR) and is never touched by updates.
#
# `--refresh` is used by the updater after each update to refresh these scripts and service files.
set -euo pipefail

APP="${MPCRM_APP_DIR:-$HOME/.local/share/mpcrm-app}"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/mpcrm/env"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
MODE="${1:-install}"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

write_files() {
  local node; node="$(command -v node)" || die "node is not installed"
  mkdir -p "$APP/bin" "$UNITS" "$APPS" "$(dirname "$ENV_FILE")"
  install -m 0755 "$SRC/scripts/mpcrm-update.mjs" "$APP/bin/mpcrm-update.mjs"
  install -m 0755 "$SRC/scripts/mpcrm-open.sh" "$APP/bin/mpcrm-open"
  [ -f "$ENV_FILE" ] || install -m 0600 /dev/null "$ENV_FILE"

  cat > "$UNITS/mpcrm.service" <<EOF
[Unit]
Description=Mortgage Protection CRM

[Service]
Type=simple
WorkingDirectory=$APP/current
Environment=MPCRM_APP_DIR=$APP
EnvironmentFile=-$ENV_FILE
ExecStart=$node dist/server/main.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

  cat > "$UNITS/mpcrm-update.service" <<EOF
[Unit]
Description=Check for a new version of the CRM and prepare it

[Service]
Type=oneshot
Environment=MPCRM_APP_DIR=$APP
EnvironmentFile=-$ENV_FILE
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node $APP/bin/mpcrm-update.mjs check
Nice=10
EOF

  cat > "$UNITS/mpcrm-update.timer" <<EOF
[Unit]
Description=Check for a new version of the CRM every hour

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h

[Install]
WantedBy=timers.target
EOF

  cat > "$UNITS/mpcrm-apply.service" <<EOF
[Unit]
Description=Install the prepared version of the CRM

[Service]
Type=oneshot
Environment=MPCRM_APP_DIR=$APP
EnvironmentFile=-$ENV_FILE
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node $APP/bin/mpcrm-update.mjs apply
EOF

  cat > "$UNITS/mpcrm-apply.timer" <<EOF
[Unit]
Description=Install a prepared CRM update overnight

[Timer]
OnCalendar=*-*-* 03:00:00

[Install]
WantedBy=timers.target
EOF

  cat > "$UNITS/mpcrm-backup.service" <<EOF
[Unit]
Description=Mortgage Protection CRM nightly backup

[Service]
Type=oneshot
WorkingDirectory=$APP/current
EnvironmentFile=-$ENV_FILE
ExecStart=$node dist/server/cli.js backup
EOF

  cat > "$UNITS/mpcrm-backup.timer" <<EOF
[Unit]
Description=Back up the CRM every night

[Timer]
OnCalendar=*-*-* 23:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

  cat > "$APPS/mpcrm.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Mortgage Protection CRM
Comment=Calling CRM
Exec=$APP/bin/mpcrm-open
Icon=x-office-address-book
Terminal=false
Categories=Office;
EOF
  systemctl --user daemon-reload
}

case "$MODE" in
  --refresh)
    write_files
    exit 0
    ;;
  --uninstall)
    systemctl --user disable --now mpcrm.service mpcrm-update.timer mpcrm-apply.timer mpcrm-backup.timer 2>/dev/null || true
    rm -f "$UNITS"/mpcrm.service "$UNITS"/mpcrm-update.{service,timer} "$UNITS"/mpcrm-apply.{service,timer} "$UNITS"/mpcrm-backup.{service,timer} "$APPS/mpcrm.desktop"
    systemctl --user daemon-reload
    rm -rf "$APP"
    say "Removed the app. Your data is still in ${MPCRM_DATA_DIR:-$HOME/.local/share/mpcrm}."
    exit 0
    ;;
  install) ;;
  *) die "unknown option $MODE" ;;
esac

# ---------- checks ----------
command -v git >/dev/null || die "git is not installed (sudo dnf install git)"
command -v node >/dev/null || die "Node.js is not installed (sudo dnf install nodejs npm)"
command -v npm >/dev/null || die "npm is not installed (sudo dnf install npm)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || die "Node.js 22 or newer is needed (you have $(node -v))"
command -v make >/dev/null && command -v g++ >/dev/null || say "Note: if the build fails, install build tools: sudo dnf install gcc-c++ make python3"
systemctl --user show-environment >/dev/null 2>&1 || die "systemd user services are not available in this session"

data_dir="${MPCRM_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mpcrm}"
if [ -f "$data_dir/server.pid" ] && kill -0 "$(cat "$data_dir/server.pid")" 2>/dev/null \
   && ! systemctl --user is-active --quiet mpcrm.service; then
  die "the app is already running from a terminal (npm start). Stop it with Ctrl+C, then run this again."
fi

url="$(git -C "$SRC" remote get-url origin)" || die "run this from a git clone of the repository"

# ---------- code ----------
mkdir -p "$APP"
if [ -d "$APP/repo/.git" ]; then
  git -C "$APP/repo" remote set-url origin "$url"
else
  say "Copying the repository..."
  git clone --quiet "$SRC" "$APP/repo"
  git -C "$APP/repo" remote set-url origin "$url"
fi

say "Building the latest version (this takes a few minutes the first time)..."
MPCRM_APP_DIR="$APP" node "$SRC/scripts/mpcrm-update.mjs" bootstrap || die "the build failed; see $APP/state/build.log"

# ---------- services ----------
write_files
systemctl --user enable --now mpcrm-update.timer mpcrm-apply.timer mpcrm-backup.timer >/dev/null
systemctl --user enable mpcrm.service >/dev/null
systemctl --user restart mpcrm.service

port="$(grep -E '^MPCRM_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)"
for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:${port:-5170}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fs "http://127.0.0.1:${port:-5170}/healthz" >/dev/null 2>&1 || die "the app did not start; see: journalctl --user -u mpcrm.service"

say ""
say "Installed. The app now runs in the background whenever you are logged in."
say "Open it from your app menu: \"Mortgage Protection CRM\" (or run $APP/bin/mpcrm-open)."
say "Updates are checked every hour; the app shows a bar when one is ready."
say "You can delete the folder you ran this from; the app no longer needs it."
