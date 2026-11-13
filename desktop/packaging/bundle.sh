#!/usr/bin/env bash
# Assemble AgentStat.app, the .dmg and the CLI tarball from built binaries.
#
#   APP_BIN=path/to/agentstat-app CLI_BIN=path/to/agentstat \
#     ARCH_LABEL=universal OUT_DIR=dist ./bundle.sh
#
# APP_BIN and CLI_BIN default to the workspace's release build. ARCH_LABEL
# names the output files (default: this machine's arch). VERSION defaults to
# the workspace version.
#
# Signing is ad-hoc only (no Apple Developer ID, no notarization): arm64
# binaries must carry at least an ad-hoc signature to run at all. Trust comes
# from the release's SHA256SUMS and GitHub artifact attestations.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)

VERSION=${VERSION:-$(sed -n '/^\[workspace.package\]/,/^\[/{s/^version *= *"\(.*\)"/\1/p;}' "$root/Cargo.toml")}
[ -n "$VERSION" ] || { echo "bundle.sh: cannot determine version" >&2; exit 1; }
target=${CARGO_TARGET_DIR:-$root/target}
APP_BIN=${APP_BIN:-$target/release/agentstat-app}
CLI_BIN=${CLI_BIN:-$target/release/agentstat}
ARCH_LABEL=${ARCH_LABEL:-$(uname -m)}
OUT_DIR=${OUT_DIR:-$root/dist}
BUNDLE_ID=io.github.dan-build.agentstat

for f in "$APP_BIN" "$CLI_BIN"; do
  [ -f "$f" ] || { echo "bundle.sh: missing binary $f" >&2; exit 1; }
done

mkdir -p "$OUT_DIR"
OUT_DIR=$(cd "$OUT_DIR" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Sign the CLI once; the same signed file goes in the app and the tarball.
cli="$work/agentstat"
cp "$CLI_BIN" "$cli"
codesign --force --sign - --identifier "$BUNDLE_ID.cli" "$cli"

# The app finds the CLI as a sibling of its own executable, so both live in
# Contents/MacOS.
stage="$work/dmg"
app="$stage/AgentStat.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$APP_BIN" "$app/Contents/MacOS/agentstat-app"
cp "$cli" "$app/Contents/MacOS/agentstat"
sed "s/@VERSION@/$VERSION/g" "$here/Info.plist" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
# TODO: add AppIcon.icns to Contents/Resources and CFBundleIconFile to Info.plist.

# Inner executables first, then the bundle that seals them.
codesign --force --sign - --identifier "$BUNDLE_ID.app" "$app/Contents/MacOS/agentstat-app"
codesign --force --sign - --identifier "$BUNDLE_ID" "$app"
codesign --verify --strict "$app"

ln -s /Applications "$stage/Applications"
dmg="$OUT_DIR/AgentStat-$VERSION-macos-$ARCH_LABEL.dmg"
rm -f "$dmg"
hdiutil create -quiet -volname AgentStat -srcfolder "$stage" -format UDZO -ov "$dmg"

tarball="$OUT_DIR/agentstat-$VERSION-macos-$ARCH_LABEL.tar.gz"
COPYFILE_DISABLE=1 tar -C "$work" -czf "$tarball" agentstat

echo "$dmg"
echo "$tarball"
