#!/usr/bin/env bash
# Builds "Mac Cleaner.app", a DMG and a .pkg installer into build/.
#
#   1. esbuild bundles src/cli.ts (+ hono, zod) into one CommonJS file.
#   2. Node's single-executable-application support injects it into a copy of
#      the running `node` binary -> Contents/Resources/mac-cleaner-server.
#   3. swiftc compiles the AppKit shell (app/Sources) -> Contents/MacOS.
#   4. iconutil, codesign (ad hoc), hdiutil (DMG), pkgbuild (.pkg).
#
# Requirements: Node 22+, Xcode (DEVELOPER_DIR is set below if needed).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
BUILD="$ROOT/build"
APP="$BUILD/Mac Cleaner.app"
VERSION=$(node -p "require('./package.json').version")
BUILD_NO=$(date +%Y%m%d%H%M)
ARCH=$(uname -m)

if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/sea" "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "==> bundling server"
npx esbuild src/cli.ts --bundle --platform=node --target=node22 --format=cjs \
  --outfile="$BUILD/sea/server.cjs" --log-level=warning \
  --define:import.meta.url='""'

echo "==> building single executable"
cat > "$BUILD/sea/sea-config.json" <<JSON
{ "main": "$BUILD/sea/server.cjs", "output": "$BUILD/sea/sea-prep.blob", "disableExperimentalSEAWarning": true }
JSON
node --experimental-sea-config "$BUILD/sea/sea-config.json"
SERVER="$APP/Contents/Resources/mac-cleaner-server"
cp "$(node -p process.execPath)" "$SERVER"
chmod u+w "$SERVER"
codesign --remove-signature "$SERVER"
npx postject "$SERVER" NODE_SEA_BLOB "$BUILD/sea/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA
cp ui/index.html "$APP/Contents/Resources/index.html"

echo "==> compiling app shell ($ARCH)"
xcrun swiftc -O -target "$ARCH-apple-macos13.0" \
  -framework Cocoa -framework WebKit \
  app/Sources/main.swift -o "$APP/Contents/MacOS/Mac Cleaner"

echo "==> icon + Info.plist"
swift scripts/make-icon.swift "$BUILD/AppIcon.iconset" >/dev/null
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD_NO/" app/Info.plist > "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> signing (ad hoc)"
xattr -cr "$APP"   # Finder metadata on copied files breaks codesign
codesign --force --sign - --options runtime --entitlements app/server.entitlements "$SERVER"
if codesign --force --deep --sign - "$APP" 2>/dev/null && codesign --verify --deep --strict "$APP"; then
  echo "    bundle signed (ad hoc)"
else
  # Processes launched from a provenance-tracked app (e.g. a Claude Code session)
  # stamp every file they create with com.apple.provenance, which codesign
  # rejects. Both executables are already individually ad-hoc signed, so the
  # app still launches; run this script from Terminal.app for a sealed bundle.
  echo "    WARNING: bundle-level codesign failed (com.apple.provenance); executables are signed, bundle seal skipped."
fi

echo "==> DMG"
STAGE="$BUILD/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "Mac Cleaner" -srcfolder "$STAGE" -ov -format UDZO -size 400m "$BUILD/MacCleaner-$VERSION-$ARCH.dmg"

echo "==> PKG"
pkgbuild --quiet --component "$APP" --install-location /Applications \
  --identifier dev.candy.mac-cleaner --version "$VERSION" "$BUILD/MacCleaner-$VERSION-$ARCH.pkg"

rm -rf "$STAGE" "$BUILD/AppIcon.iconset"
echo
echo "Built:"
ls -lh "$APP/Contents/MacOS/Mac Cleaner" "$BUILD"/*.dmg "$BUILD"/*.pkg | awk '{print "  " $5 "  " $9 " " $10 " " $11}'
echo
echo "Open with:  open \"$APP\""
