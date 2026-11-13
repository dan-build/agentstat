#!/bin/sh
# Install the AgentStat command line (and optionally the app) on macOS.
#
#   curl -fsSL https://github.com/dan-build/agentstat/releases/download/app-vX.Y.Z/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --app
#
# Environment:
#   AGENTSTAT_VERSION      version to install, e.g. 0.1.0 (default: newest app release)
#   AGENTSTAT_INSTALL_DIR  where `agentstat` goes (default: ~/.local/bin)
#   AGENTSTAT_INSTALL_APP  set to 1 to also install AgentStat.app (same as --app)
#   AGENTSTAT_BASE_URL     release download base (default: this repo's GitHub releases)
#
# Everything is verified against the release's SHA256SUMS before it is
# installed. Nothing here needs sudo. Files fetched with curl carry no
# quarantine flag, so Gatekeeper does not block the ad-hoc signed binaries.
set -eu

REPO=dan-build/agentstat
BASE=${AGENTSTAT_BASE_URL:-https://github.com/$REPO/releases/download}
INSTALL_DIR=${AGENTSTAT_INSTALL_DIR:-$HOME/.local/bin}
WANT_APP=${AGENTSTAT_INSTALL_APP:-0}

die() { printf 'agentstat install: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

for arg in "$@"; do
  case $arg in
    --app) WANT_APP=1 ;;
    -h|--help)
      # Inline: under `curl | sh`, $0 is the shell, not this file.
      cat <<'USAGE'
Install the AgentStat command line (and with --app, AgentStat.app) on macOS.
Every file is checked against the release's SHA256SUMS before it's installed.

  sh install.sh [--app]

  AGENTSTAT_VERSION      version to install (default: newest app release)
  AGENTSTAT_INSTALL_DIR  where `agentstat` goes (default: ~/.local/bin)
  AGENTSTAT_INSTALL_APP  1 = also install AgentStat.app into ~/Applications
USAGE
      exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

[ "$(uname -s)" = Darwin ] || die "this installer is for macOS"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v shasum >/dev/null 2>&1 || die "shasum is required"

version=${AGENTSTAT_VERSION:-}
if [ -z "$version" ]; then
  # The repo also releases the npm library, so "latest" may not be an app
  # release; pick the newest app-v* tag instead.
  say "Finding the latest AgentStat app release..."
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" \
    | sed -n 's/.*"tag_name": *"app-v\([^"]*\)".*/\1/p' | head -n 1) || true
  [ -n "$version" ] || die "could not find an app release; set AGENTSTAT_VERSION"
fi
version=${version#app-v}
version=${version#v}

url="$BASE/app-v$version"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Ctrl-C stops the install (the EXIT trap still cleans up).
trap 'exit 130' INT TERM

fetch() { # name
  curl -fsSL "$url/$1" -o "$tmp/$1" || die "download failed: $url/$1"
}

verify() { # name
  want=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
  [ -n "$want" ] || die "$1 is not listed in SHA256SUMS"
  got=$(shasum -a 256 "$tmp/$1" | awk '{ print $1 }')
  [ "$want" = "$got" ] || die "checksum mismatch for $1 (expected $want, got $got); nothing was installed"
}

say "Installing AgentStat $version"
fetch SHA256SUMS

tarball="agentstat-$version-macos-universal.tar.gz"
fetch "$tarball"
verify "$tarball"
mkdir "$tmp/cli"
tar -xzf "$tmp/$tarball" -C "$tmp/cli"
[ -f "$tmp/cli/agentstat" ] || die "archive does not contain agentstat"

mkdir -p "$INSTALL_DIR"
cp "$tmp/cli/agentstat" "$INSTALL_DIR/agentstat.new"
chmod 755 "$INSTALL_DIR/agentstat.new"
mv -f "$INSTALL_DIR/agentstat.new" "$INSTALL_DIR/agentstat"
say "Installed $INSTALL_DIR/agentstat"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) say "Note: $INSTALL_DIR is not on your PATH. Add this to your shell profile:"
     say "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

if [ "$WANT_APP" = 1 ]; then
  command -v hdiutil >/dev/null 2>&1 || die "hdiutil is required to install the app"
  dmg="AgentStat-$version-macos-universal.dmg"
  fetch "$dmg"
  verify "$dmg"
  mnt="$tmp/mnt"
  mkdir "$mnt"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$tmp/$dmg" >/dev/null \
    || die "could not mount $dmg"
  apps="$HOME/Applications"
  mkdir -p "$apps"
  rm -rf "$apps/AgentStat.app.new"
  if cp -R "$mnt/AgentStat.app" "$apps/AgentStat.app.new"; then
    rm -rf "$apps/AgentStat.app"
    mv "$apps/AgentStat.app.new" "$apps/AgentStat.app"
    hdiutil detach -quiet "$mnt" || true
  else
    hdiutil detach -quiet "$mnt" || true
    die "could not copy AgentStat.app to $apps"
  fi
  say "Installed $apps/AgentStat.app"
fi

say "Done. Next: agentstat connect claude   (shows each change and asks first)"
