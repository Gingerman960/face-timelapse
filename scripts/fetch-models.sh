#!/bin/sh
# Download the ONNX face models used by crates/face-engine into models/.
#
#   scripts/fetch-models.sh [destination-dir]
#
# - POSIX sh; needs curl or wget, and shasum or sha256sum (or openssl).
# - Idempotent: files already present with the right SHA-256 are left alone;
#   a file with a wrong checksum is re-downloaded.
# - Fails closed: any download or verification error stops the script with a
#   message and a non-zero exit status, and never leaves a partial file.
# - URLs are pinned to the opencv_zoo commits that last touched each model, so
#   the bytes (and the checksums below) never change underneath us.
#
# Models (both from https://github.com/opencv/opencv_zoo):
#   face_detection_yunet_2023mar.onnx    YuNet face detector        MIT
#   face_recognition_sface_2021dec.onnx  SFace face recognizer      Apache-2.0
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
DEST=${1:-"$ROOT/models"}

ZOO=https://media.githubusercontent.com/media/opencv/opencv_zoo

# name|url|sha256
MODELS="face_detection_yunet_2023mar.onnx|$ZOO/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx|8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
face_recognition_sface_2021dec.onnx|$ZOO/ba91a3b91d00d76e86540d4013f944bd6b514e39/models/face_recognition_sface/face_recognition_sface_2021dec.onnx|0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"

fail() {
    echo "error: $*" >&2
    exit 1
}

# Pick the tools once, up front, so a missing tool is reported as such (and not
# as a checksum mismatch from inside a command substitution).
if command -v shasum >/dev/null 2>&1; then
    HASHER=shasum
elif command -v sha256sum >/dev/null 2>&1; then
    HASHER=sha256sum
elif command -v openssl >/dev/null 2>&1; then
    HASHER=openssl
else
    fail "need shasum, sha256sum or openssl to verify downloads"
fi

if command -v curl >/dev/null 2>&1; then
    FETCHER=curl
elif command -v wget >/dev/null 2>&1; then
    FETCHER=wget
else
    fail "need curl or wget to download models"
fi

sha256_of() {
    case $HASHER in
        shasum) shasum -a 256 "$1" ;;
        sha256sum) sha256sum "$1" ;;
        openssl) openssl dgst -sha256 -r "$1" ;;
    esac | cut -d ' ' -f 1
}

download() {
    case $FETCHER in
        curl) curl --fail --location --silent --show-error --retry 3 --output "$2" "$1" ;;
        wget) wget --quiet --tries=3 --output-document="$2" "$1" ;;
    esac
}

# Removes an unfinished download on any exit (error, Ctrl-C, kill).
tmp=
cleanup() {
    if [ -n "$tmp" ]; then
        rm -f "$tmp"
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$DEST" || fail "cannot create $DEST"

# Here-document instead of a pipe: the loop runs in this shell, so `fail`
# (and `set -e`) end the script instead of only a subshell.
while IFS='|' read -r name url sha; do
    [ -n "$name" ] || continue
    target="$DEST/$name"
    if [ -f "$target" ]; then
        current=$(sha256_of "$target") || fail "cannot hash $target"
        if [ "$current" = "$sha" ]; then
            echo "ok        $name"
            continue
        fi
        echo "stale     $name (checksum differs, downloading again)"
    fi
    echo "fetching  $name"
    tmp="$target.part.$$"
    if ! download "$url" "$tmp"; then
        fail "download of $name failed ($url)"
    fi
    actual=$(sha256_of "$tmp") || fail "cannot hash the download of $name"
    if [ "$actual" != "$sha" ]; then
        fail "checksum mismatch for $name: expected $sha, got $actual"
    fi
    mv -f "$tmp" "$target" || fail "cannot move the download into $target"
    tmp=
    echo "ok        $name"
done <<EOF
$MODELS
EOF
