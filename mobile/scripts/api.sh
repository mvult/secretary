#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "${1:-generate}" in
  generate) buf generate --template buf.gen.yaml ;;
  check)
    output=$(mktemp -d "${TMPDIR:-/tmp}/secretary-swift-api.XXXXXX")
    trap 'rm -rf "$output"' EXIT HUP INT TERM
    buf generate --template buf.gen.yaml --output "$output"
    diff -ru Secretary/Core/API/Generated "$output/Secretary/Core/API/Generated"
    ;;
  *) echo 'Usage: sh scripts/api.sh [generate|check]' >&2; exit 2 ;;
esac
