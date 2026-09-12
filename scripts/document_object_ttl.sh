#!/bin/sh
set -eu

# Seaweed stores TTL as an 8-bit count of minutes/hours/days/weeks/months/years.
# Round UP to a representable interval: its parser otherwise truncates larger
# minute counts, which could delete bytes before application metadata expires.
awk -v seconds="${1:-}" 'BEGIN {
  if (seconds !~ /^[0-9]+$/ || seconds + 0 <= 0 || seconds + 0 > 8041680000) {
    print "DOCUMENT_OBJECT_EXPIRY_SECONDS must be a positive integer no greater than 255 years" > "/dev/stderr"
    exit 1
  }
  split("60 3600 86400 604800 2592000 31536000", sizes, " ")
  split("m h d w M y", units, " ")
  for (i = 1; i <= 6; i++) {
    count = int((seconds + sizes[i] - 1) / sizes[i])
    if (count <= 255) {
      printf "%d%s\n", count, units[i]
      exit 0
    }
  }
  exit 1
}'
