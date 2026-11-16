#!/usr/bin/env bash
# Build + package the PocketJS Android host as a signed APK — no Gradle, no dex.
#
#   hosts/android/build.sh [app-manifest]     (default: apps/desk/pocket.json)
#
# Steps: compile the app bundle for the `android` target → cross-compile the
# host .so (cargo-ndk, arm64-v8a, API 24) → aapt2 link manifest + assets →
# add the .so → zipalign → apksigner (debug key, generated on first run).
# Output: hosts/android/out/pocketjs.apk
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
APP_MANIFEST="${1:-apps/desk/pocket.json}"

export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
NDK_VER="${NDK_VER:-27.2.12479018}"
BT_VER="${BT_VER:-34.0.0}"
API=24
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/$NDK_VER}"
BT="$ANDROID_HOME/build-tools/$BT_VER"
PLATFORM_JAR="$ANDROID_HOME/platforms/android-$API/android.jar"
# bindgen (rquickjs) needs a host libclang and the NDK sysroot.
export LIBCLANG_PATH="${LIBCLANG_PATH:-/Library/Developer/CommandLineTools/usr/lib}"
export BINDGEN_EXTRA_CLANG_ARGS="--sysroot=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/sysroot --target=aarch64-linux-android$API"
export PATH="$HOME/.bun/bin:$PATH"

OUT="$HERE/out"
STAGE="$OUT/stage"
rm -rf "$STAGE" && mkdir -p "$STAGE/assets" "$STAGE/lib/arm64-v8a"

echo "▸ app bundle ($APP_MANIFEST)"
(cd "$ROOT" && bun pocket compile --target android --manifest "$APP_MANIFEST" --project-root . >/dev/null)
APP_NAME="$(cd "$ROOT" && bun -e "console.log(JSON.parse(require('fs').readFileSync('$APP_MANIFEST','utf8')).name ?? '')")"
OUTNAME="$(cd "$ROOT" && bun -e "console.log(JSON.parse(require('fs').readFileSync('$APP_MANIFEST','utf8')).app.output)")"
JS="$ROOT/dist/$OUTNAME.js"
PAK="${JS%.js}.pak"
cp "$JS" "$STAGE/assets/app.js"
cp "$PAK" "$STAGE/assets/app.pak"
# Logical viewport the app was built for (host reads assets/viewport).
(cd "$ROOT" && bun -e "const m=JSON.parse(require('fs').readFileSync('$APP_MANIFEST','utf8'));const v=m.app?.viewport?.fixed?.logical??[480,272];console.log(v[0]+' '+v[1])") > "$STAGE/assets/viewport"
echo "  $(basename "$JS") + $(basename "$PAK") ${APP_NAME:+($APP_NAME)}"

echo "▸ host .so"
(cd "$HERE" && cargo ndk -t arm64-v8a -P $API build --release --lib ${CARGO_FEATURES:+--features $CARGO_FEATURES})
cp "$HERE/target/aarch64-linux-android/release/libpocketjs.so" "$STAGE/lib/arm64-v8a/"

echo "▸ apk"
"$BT/aapt2" link -o "$OUT/unsigned.apk" --manifest "$HERE/AndroidManifest.xml" \
  -I "$PLATFORM_JAR" -A "$STAGE/assets" --min-sdk-version $API --target-sdk-version $API
# Native libs stored uncompressed + page-aligned so they can be mapped directly.
(cd "$STAGE" && zip -q -0 "$OUT/unsigned.apk" lib/arm64-v8a/libpocketjs.so)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias pocketjs -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=PocketJS Debug" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT/pocketjs.apk" "$OUT/aligned.apk"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk"
echo "✓ $OUT/pocketjs.apk ($(du -h "$OUT/pocketjs.apk" | cut -f1))"
echo "  install: adb install -r $OUT/pocketjs.apk"
echo "  iterate: adb push dist/<app>.{js,pak} /data/local/tmp/pocketjs/app.{js,pak} (no reinstall)"
