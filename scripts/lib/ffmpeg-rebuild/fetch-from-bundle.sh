#!/bin/sh
# Stands in for the build scripts' download() (script/functions.sh): build-from-bundle.sh makes every
# download the build scripts ask for come from this archive instead of the network.
#
#   fetch-from-bundle.sh <address the build script asks for> <file name it wants>
#
# rebuild/url-map.tsv lists each address the build scripts at the pinned revision ask for, the file in
# this archive that holds it, and how it is handed over:
#   copy             the file as it is;
#   tar.bz2          the same archive recompressed with bzip2 (FFmpeg: the scripts fetch .tar.bz2;
#                    this archive holds the FFmpeg developers' .tar.xz of the same release);
#   top=<folder>     the same archive with its top folder renamed (x264: the scripts fetch the moving
#                    master branch and expect x264-master/; this archive holds the pinned commit).
# An address not in the map is a build tool (nasm, ninja, pkg-config and its patches, cmake, SDL for
# ffplay), none of which is part of the ffmpeg program: it is downloaded as the build scripts would,
# unless TW_REBUILD_OFFLINE=1, when it is refused.
set -eu
URL=$1
NAME=$2
HERE=$(cd "$(dirname "$0")" && pwd)
BUNDLE=$(cd "$HERE/.." && pwd)
TAB=$(printf '\t')
LINE=$(awk -F "$TAB" -v url="$URL" '$1 == url { print; exit }' "$HERE/url-map.tsv")
if [ -z "$LINE" ]; then
  if [ "${TW_REBUILD_OFFLINE:-0}" = "1" ]; then
    echo "fetch-from-bundle: refused (TW_REBUILD_OFFLINE=1): $URL is not in this archive (a build tool, not part of the ffmpeg program)" >&2
    exit 1
  fi
  echo "fetch-from-bundle: not in this archive, downloading (a build tool, not part of the ffmpeg program): $URL" >&2
  exec curl -o "$NAME" -L -f "$URL"
fi
FILE=$BUNDLE/$(printf '%s' "$LINE" | cut -f 2)
OP=$(printf '%s' "$LINE" | cut -f 3)
[ -f "$FILE" ] || { echo "fetch-from-bundle: $FILE is missing from the archive" >&2; exit 1; }
case "$OP" in
  copy)
    cp "$FILE" "$NAME" ;;
  tar.bz2)
    /usr/bin/tar -cjf "$NAME" "@$FILE" ;;
  top=*)
    WANT=${OP#top=}
    HAVE=$(/usr/bin/tar -tzf "$FILE" | head -n 1 | cut -d / -f 1)
    /usr/bin/tar -czf "$NAME" -s "|^$HAVE|$WANT|" "@$FILE" ;;
  *)
    echo "fetch-from-bundle: unknown way to hand over $FILE: $OP" >&2; exit 1 ;;
esac
echo "fetch-from-bundle: from this archive ($OP): $URL <- ${FILE#"$BUNDLE"/}" >&2
