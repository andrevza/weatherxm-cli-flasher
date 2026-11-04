#!/bin/sh
set -eu

if [ -z "${WG1200_PORT:-}" ]; then
  echo "WG1200_PORT must name the attached gateway serial device" >&2
  exit 2
fi
if [ ! -x "${WG1200_BINARY:-./dist/weatherxm-flash-linux-arm64}" ]; then
  echo "WG1200_BINARY must point to the built executable" >&2
  exit 2
fi

binary=${WG1200_BINARY:-./dist/weatherxm-flash-linux-arm64}
page_size=$(getconf PAGESIZE)
if [ "$page_size" != 16384 ]; then
  echo "Expected a 16 KB Linux page kernel for the Raspberry Pi 5 compatibility gate; found $page_size" >&2
  exit 1
fi

"$binary" --version
"$binary" --help >/dev/null
"$binary" firmware list --json
round=1
while [ "$round" -le 3 ]; do
  echo "Read-only WG1200 hardware pass $round/3"
  "$binary" info --port "$WG1200_PORT" --json --redact
  "$binary" verify --port "$WG1200_PORT" --json --redact
  "$binary" status --port "$WG1200_PORT" --json --redact
  round=$((round + 1))
done

# The monitor is passive and runs until interrupted. Give it a short bounded
# read window so the hardware gate exercises the command without hanging.
set +e
timeout --signal=INT --kill-after=2s 5s "$binary" monitor --port "$WG1200_PORT" --redact
monitor_status=$?
set -e
if [ "$monitor_status" -ne 124 ] && [ "$monitor_status" -ne 130 ]; then
  exit "$monitor_status"
fi
