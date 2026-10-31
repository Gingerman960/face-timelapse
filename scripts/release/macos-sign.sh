#!/bin/sh
# Sign, notarize and package an unsigned FaceTimelapse.app (release workflow,
# job `sign-macos`; also usable locally).
#
#   scripts/release/macos-sign.sh <unsigned.app.tar.gz> <out-dir> <base-name>
#
# Writes <out-dir>/<base-name>.dmg and <out-dir>/<base-name>.app.tar.gz.
# Uses only Apple's tools (security, codesign, xcrun notarytool/stapler,
# ditto, hdiutil, PlistBuddy) plus tar/openssl/base64.
#
# Credentials come from the environment and are all optional:
#   APPLE_CERTIFICATE           Developer ID Application .p12, base64
#   APPLE_CERTIFICATE_PASSWORD  its password
#   APPLE_SIGNING_IDENTITY      optional, else the first Developer ID identity
#   notarization, either
#     APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_P8 (contents of the .p8)
#   or
#     APPLE_ID, APPLE_PASSWORD (app-specific), APPLE_TEAM_ID
# Without APPLE_CERTIFICATE the app is ad-hoc signed (runs on Apple silicon
# after the user approves it); without notarization credentials it is signed
# but not notarized.
set -eu

fail() {
    echo "error: $*" >&2
    exit 1
}

[ $# -eq 3 ] || fail "usage: $0 <unsigned.app.tar.gz> <out-dir> <base-name>"
input=$1
out=$2
base=$3
[ -f "$input" ] || fail "no such archive: $input"
mkdir -p "$out"

work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ft-sign.XXXXXX")
keychain=
cleanup() {
    if [ -n "$keychain" ]; then
        security delete-keychain "$keychain" 2>/dev/null || true
    fi
    rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tar -xzf "$input" -C "$work"
app="$work/FaceTimelapse.app"
[ -d "$app" ] || fail "$input does not contain FaceTimelapse.app"

# --- code signing -----------------------------------------------------------
if [ -n "${APPLE_CERTIFICATE:-}" ]; then
    keychain="$work/signing.keychain-db"
    kpass=$(openssl rand -hex 24)
    security create-keychain -p "$kpass" "$keychain"
    security set-keychain-settings -lut 21600 "$keychain"
    security unlock-keychain -p "$kpass" "$keychain"
    printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$work/certificate.p12"
    security import "$work/certificate.p12" -k "$keychain" \
        -P "${APPLE_CERTIFICATE_PASSWORD:-}" -T /usr/bin/codesign >/dev/null
    rm -f "$work/certificate.p12"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$kpass" "$keychain" >/dev/null
    # codesign only finds identities in keychains on the search list, even
    # with --keychain. Prepend ours; `delete-keychain` in cleanup removes it.
    # (`list-keychains` prints quoted paths, one per line.)
    eval "set -- $(security list-keychains -d user | tr '\n' ' ')"
    security list-keychains -d user -s "$keychain" "$@"
    identity=${APPLE_SIGNING_IDENTITY:-}
    if [ -z "$identity" ]; then
        identity=$(security find-identity -v -p codesigning "$keychain" |
            awk -F'"' '/Developer ID Application/ { print $2; exit }')
    fi
    [ -n "$identity" ] || fail "APPLE_CERTIFICATE holds no Developer ID Application identity"
    echo "signing with: $identity"
    # The bundle has a single executable and no nested frameworks or helpers,
    # so signing the bundle signs everything (hardened runtime, no entitlements).
    codesign --force --options runtime --timestamp --keychain "$keychain" --sign "$identity" "$app"
else
    identity=-
    echo "::warning::APPLE_CERTIFICATE not set: ad-hoc signing, no notarization."
    codesign --force --options runtime --sign - "$app"
fi
codesign --verify --strict --verbose=2 "$app"

# --- notarization -----------------------------------------------------------
notary_auth=
if [ "$identity" != "-" ]; then
    if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_P8:-}" ]; then
        printf '%s\n' "$APPLE_API_KEY_P8" > "$work/AuthKey.p8"
        notary_auth=api
    elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
        notary_auth=appleid
    else
        echo "::warning::No notarization credentials: signed with Developer ID but not notarized."
    fi
fi

# notarize <file>: submits, waits, and fails with the notary log unless Accepted.
notarize() {
    file=$1
    result="$work/notary.plist"
    case $notary_auth in
        api) xcrun notarytool submit "$file" --wait --output-format plist \
                 --key "$work/AuthKey.p8" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" > "$result" ;;
        appleid) xcrun notarytool submit "$file" --wait --output-format plist \
                     --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" > "$result" ;;
    esac
    status=$(/usr/libexec/PlistBuddy -c 'Print :status' "$result" 2>/dev/null || echo unknown)
    id=$(/usr/libexec/PlistBuddy -c 'Print :id' "$result" 2>/dev/null || echo '')
    echo "notarization of $(basename "$file"): $status ${id:+(id $id)}"
    if [ "$status" != "Accepted" ]; then
        if [ -n "$id" ]; then
            case $notary_auth in
                api) xcrun notarytool log "$id" --key "$work/AuthKey.p8" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" || true ;;
                appleid) xcrun notarytool log "$id" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" || true ;;
            esac
        fi
        fail "notarization of $(basename "$file") ended with status $status"
    fi
}

if [ -n "$notary_auth" ]; then
    ditto -c -k --keepParent "$app" "$work/app.zip"
    notarize "$work/app.zip"
    xcrun stapler staple "$app"
fi

# --- disk image -------------------------------------------------------------
stage="$work/dmg"
mkdir -p "$stage"
ditto "$app" "$stage/FaceTimelapse.app"
ln -s /Applications "$stage/Applications"
dmg="$out/$base.dmg"
attempt=1
# hdiutil occasionally fails with "Resource busy" on CI machines; retry.
until hdiutil create -volname FaceTimelapse -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg" >/dev/null; do
    [ "$attempt" -lt 3 ] || fail "hdiutil could not create $dmg"
    attempt=$((attempt + 1))
    sleep 5
done

if [ "$identity" != "-" ]; then
    codesign --force --timestamp --keychain "$keychain" --sign "$identity" "$dmg"
    codesign --verify --verbose=2 "$dmg"
fi
if [ -n "$notary_auth" ]; then
    notarize "$dmg"
    xcrun stapler staple "$dmg"
fi

tar -C "$work" -czf "$out/$base.app.tar.gz" FaceTimelapse.app
echo "wrote $dmg and $out/$base.app.tar.gz"
