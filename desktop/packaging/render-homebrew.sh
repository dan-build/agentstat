#!/bin/sh
# Render the Homebrew formula and cask for a release, ready to copy into a tap.
#
#   render-homebrew.sh <version> <dir containing SHA256SUMS> <output dir>
#
# The checksums come from SHA256SUMS so the rendered files can only name
# artifacts that were actually built.
set -eu

[ $# -eq 3 ] || { echo "usage: $0 <version> <sums dir> <out dir>" >&2; exit 2; }
version=$1
sums=$2/SHA256SUMS
out=$3
here=$(cd "$(dirname "$0")" && pwd)

sum_of() {
  s=$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$sums")
  [ -n "$s" ] || { echo "render-homebrew: $1 not in $sums" >&2; exit 1; }
  printf '%s' "$s"
}

tar_sha=$(sum_of "agentstat-$version-macos-universal.tar.gz")
dmg_sha=$(sum_of "AgentStat-$version-macos-universal.dmg")

mkdir -p "$out"
sed -e "s/@VERSION@/$version/g" -e "s/@TARBALL_SHA256@/$tar_sha/g" \
  "$here/homebrew/agentstat.rb" > "$out/agentstat.rb"
sed -e "s/@VERSION@/$version/g" -e "s/@DMG_SHA256@/$dmg_sha/g" \
  "$here/homebrew/agentstat-app.rb" > "$out/agentstat-app.rb"
