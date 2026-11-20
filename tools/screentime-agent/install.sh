#!/bin/bash
# Installs the ParentSlop screen time agent on a Linux family computer (Ubuntu/GNOME tested).
#
#   sudo ./install.sh --token psd_xxx [--server https://parentslop.com] LOGIN [LOGIN...]
#   sudo ./install.sh LOGIN...          add more kids' logins (keeps the existing config)
#   sudo ./install.sh --uninstall       remove everything (PAM lines, service, files, group)
#
# LOGIN is each kid's Linux username (e.g. en nadia). They're added to the local "screentime" group: only
# accounts in that group are ever counted, blocked or logged out. Each person's daily allowance and their
# login name are set in ParentSlop > Screen Time; the token comes from the Computers section there.
#
# What it does:
#   /usr/local/sbin/parentslop-screentime     the agent (Python 3, standard library only)
#   /etc/parentslop-screentime.conf           server + token (root only)
#   parentslop-screentime.service             runs the agent as root
#   /etc/pam.d/{gdm-password,gdm-autologin,gdm-fingerprint,xrdp-sesman,login,sshd}
#       two account lines after "@include common-account" (between BEGIN/END markers): people in the
#       screentime group with no time left can't log in or unlock. Everyone else skips the check.
#       Originals are backed up to /var/lib/parentslop-screentime/pam-backup/.
set -euo pipefail

BIN=/usr/local/sbin/parentslop-screentime
CONF=/etc/parentslop-screentime.conf
UNIT=/etc/systemd/system/parentslop-screentime.service
STATE_DIR=/var/lib/parentslop-screentime
GROUP=screentime
PAM_SERVICES="gdm-password gdm-autologin gdm-fingerprint xrdp-sesman login sshd"
BEGIN="# BEGIN parentslop-screentime"
END="# END parentslop-screentime"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run with sudo"

remove_pam() {
  for svc in $PAM_SERVICES; do
    f=/etc/pam.d/$svc
    [ -f "$f" ] && grep -qF "$BEGIN" "$f" && sed -i "/^$BEGIN\$/,/^$END\$/d" "$f" && echo "PAM: removed from $svc"
  done
  return 0
}

if [ "${1:-}" = "--uninstall" ]; then
  remove_pam
  systemctl disable --now parentslop-screentime.service 2>/dev/null || true
  rm -f "$UNIT" "$BIN"
  systemctl daemon-reload
  rm -f "$CONF"
  rm -rf "$STATE_DIR"
  groupdel "$GROUP" 2>/dev/null || true
  echo "Uninstalled."
  exit 0
fi

TOKEN="" SERVER="" LOGINS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) LOGINS+=("$1"); shift ;;
  esac
done

command -v python3 >/dev/null || die "python3 is required"
command -v notify-send >/dev/null || echo "warning: notify-send not found (apt install libnotify-bin); warnings won't show"

# Kids' accounts: must exist, be normal users, and not be admins.
for u in "${LOGINS[@]}"; do
  uid=$(id -u "$u" 2>/dev/null) || die "no such user: $u"
  [ "$uid" -ge 1000 ] || die "$u is a system account"
  if id -nG "$u" | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel'; then die "$u is an administrator; refusing to put screen time limits on it"; fi
done

# Agent + config
install -m 0755 "$HERE/parentslop-screentime" "$BIN"
if [ -n "$TOKEN" ] || [ ! -f "$CONF" ]; then
  [ -n "$TOKEN" ] || die "--token is required the first time (ParentSlop > Screen Time > Computers > Add)"
  [[ "$TOKEN" =~ ^psd_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,64}$ ]] || die "that doesn't look like a computer token (psd_...)"
  umask 077
  cat > "$CONF" <<EOF
# ParentSlop screen time agent. See $BIN --help.
server = ${SERVER:-https://parentslop.com}
token = $TOKEN
group = $GROUP
# count_idle = no
# offline = enforce
EOF
  chmod 600 "$CONF"
  umask 022
  echo "Wrote $CONF"
elif [ -n "$SERVER" ]; then
  sed -i "s|^server = .*|server = $SERVER|" "$CONF"
fi

# Group
getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"
for u in "${LOGINS[@]}"; do usermod -aG "$GROUP" "$u" && echo "Added $u to $GROUP"; done

# Service
mkdir -p "$STATE_DIR/pam-backup"
install -m 0644 "$HERE/parentslop-screentime.service" "$UNIT"
systemctl daemon-reload
systemctl enable parentslop-screentime.service >/dev/null
systemctl restart parentslop-screentime.service
echo "Service started"

# PAM: after "@include common-account", skip unless the user is in the group, then ask the agent.
remove_pam >/dev/null
for svc in $PAM_SERVICES; do
  f=/etc/pam.d/$svc
  [ -f "$f" ] || continue
  grep -q '^@include common-account' "$f" || { echo "PAM: $svc has no '@include common-account', skipped"; continue; }
  [ -f "$STATE_DIR/pam-backup/$svc" ] || cp -p "$f" "$STATE_DIR/pam-backup/$svc"
  tmp=$(mktemp)
  awk -v begin="$BEGIN" -v end="$END" -v bin="$BIN" -v group="$GROUP" '
    { print }
    /^@include common-account/ && !done {
      print begin
      print "account [success=1 default=ignore] pam_succeed_if.so quiet user notingroup " group
      print "account required pam_exec.so quiet stdout " bin " pam-check"
      print end
      done = 1
    }' "$f" > "$tmp"
  cat "$tmp" > "$f"
  rm -f "$tmp"
  echo "PAM: added to $svc"
done

sleep 2
"$BIN" status || true
echo
echo "Done. Check with:  systemctl status parentslop-screentime   journalctl -u parentslop-screentime -f"
echo "Test a notification (while a kid is logged in):  sudo $BIN test-notify LOGIN"
