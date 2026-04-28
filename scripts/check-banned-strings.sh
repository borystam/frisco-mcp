#!/usr/bin/env bash
# Item 15 — banned-string gate.
#
# This fork is public. Any commit that names a specific deployment
# target (private hostnames, vault names, internal subnets, …) leaks
# reconnaissance for free. This script greps the working tree for a
# small list of strings that should never appear in this repo and
# fails CI on any hit.
#
# The list is deliberately narrow: false positives waste reviewer
# time. Each entry is a regex. Add an entry only when there is a
# concrete leak you have caught.
#
# This script is allowed to be edited; the regex list IS the policy.

set -euo pipefail

# Files to skip — even a discussion of the policy itself would trip
# the regexes if we scanned this script and the workflow.
IGNORES=(
  ":(exclude)scripts/check-banned-strings.sh"
  ":(exclude).github/workflows/secrets-and-leaks.yml"
  ":(exclude)package-lock.json"
  ":(exclude)node_modules"
  ":(exclude)dist"
  ":(exclude).git"
)

# Regexes — case-insensitive grep. Tune carefully; a 1-letter prefix
# slip can murder a release.
PATTERNS=(
  # Words that have only ever appeared as deployment-specific names.
  # If you ever add legitimate uses, add a more specific exclude above
  # rather than relaxing the pattern.
  '\bnanao\b'
  '\bsenkaimon\b'
  '\bhermes-?(agent|gateway)\b'
  '\btoolbox\b'
  '\binference\b'
  # Tailscale-style internal TLDs.
  '\.tailnet\b'
  '\.ts\.net\b'
  # Common 1Password CLI invocation hint that has only appeared
  # in homelab contexts here.
  '\bop read "op://'
  # RFC1918 ranges except the doc-default 127.0.0.1.
  '\b10\.[0-9]+\.[0-9]+\.[0-9]+\b'
  '\b192\.168\.[0-9]+\.[0-9]+\b'
  '\b172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]+\.[0-9]+\b'
)

EXIT=0
for pat in "${PATTERNS[@]}"; do
  # `git grep -I` skips binary; `--cached` would only check the index.
  # We scan the working tree — that's what gets pushed.
  if git grep --no-color -nIE -i "${pat}" -- "${IGNORES[@]}" >/tmp/banned-hits.$$; then
    if [ -s /tmp/banned-hits.$$ ]; then
      echo "❌ banned pattern '${pat}' matched:" >&2
      sed 's/^/    /' /tmp/banned-hits.$$ >&2
      EXIT=1
    fi
  fi
  rm -f /tmp/banned-hits.$$
done

if [ "${EXIT}" -ne 0 ]; then
  cat <<'MSG' >&2

This is a public fork. The strings above are deployment-specific and
must not be committed here. Move them to your private deployment
repo, then push a fix-up commit that replaces the values with
placeholders (127.0.0.1, changeme, .invalid, etc.).
MSG
  exit 1
fi

echo "✅ banned-string gate clean"
