#!/usr/bin/env bash
# Banned-string gate.
#
# This fork is public. Any commit that names a specific deployment
# target (private hostnames, vault names, internal subnets, …) leaks
# reconnaissance for free. This script greps the working tree for a
# small list of strings that should never appear in this repo and
# fails CI on any hit.
#
# Policy: keep this file FREE of deployment-specific identifiers.
# Anything we list here is itself committed to a public repo, so a
# regex like `\bmy-private-host\b` is the very leak it claims to
# prevent. The list below is therefore restricted to generic patterns
# (RFC1918 ranges, well-known LAN TLDs) that apply to anyone.
#
# To extend with deployment-specific patterns, set BANNED_STRINGS_FILE
# to a path that lives outside this repo (or inside a gitignored dir).
# That file should assign a bash array named EXTRA_PATTERNS, e.g.:
#   EXTRA_PATTERNS=('\bmy-private-host\b' '\binternal-service\b')
# It is sourced before the scan and its entries are appended to the
# pattern list.

set -euo pipefail

# Files to skip — a discussion of the policy itself would trip the
# regexes if we scanned this script and the workflow.
IGNORES=(
  ":(exclude)scripts/check-banned-strings.sh"
  ":(exclude).github/workflows/secrets-and-leaks.yml"
  ":(exclude)package-lock.json"
  ":(exclude)node_modules"
  ":(exclude)dist"
  ":(exclude).git"
)

# Generic patterns — case-insensitive grep. Safe to commit because
# they are universal: every deployment that leaks an RFC1918 IP or a
# `.local` hostname into a public repo wants this caught.
PATTERNS=(
  # RFC1918 ranges (the doc-default 127.0.0.1 is loopback and never
  # matches these).
  '\b10\.[0-9]+\.[0-9]+\.[0-9]+\b'
  '\b192\.168\.[0-9]+\.[0-9]+\b'
  '\b172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]+\.[0-9]+\b'
  # Common LAN TLDs.
  '\.local\b'
  '\.lan\b'
  '\.home\.arpa\b'
)

# Optional: load deployment-specific patterns from a path supplied by
# the operator. The file must define a bash array EXTRA_PATTERNS.
# It is NOT version-controlled here; CI plumbs it via a secret or a
# private mount.
if [ -n "${BANNED_STRINGS_FILE:-}" ]; then
  if [ ! -f "${BANNED_STRINGS_FILE}" ]; then
    echo "BANNED_STRINGS_FILE=${BANNED_STRINGS_FILE} does not exist" >&2
    exit 2
  fi
  # shellcheck source=/dev/null
  source "${BANNED_STRINGS_FILE}"
  if declare -p EXTRA_PATTERNS >/dev/null 2>&1; then
    PATTERNS+=("${EXTRA_PATTERNS[@]}")
  fi
fi

EXIT=0
for pat in "${PATTERNS[@]}"; do
  # `git grep -I` skips binary; `--cached` would only check the index.
  # We scan the working tree — that's what gets pushed.
  if git grep --no-color -nIE -i "${pat}" -- "${IGNORES[@]}" >/tmp/banned-hits.$$; then
    if [ -s /tmp/banned-hits.$$ ]; then
      echo "banned pattern '${pat}' matched:" >&2
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

echo "banned-string gate clean"
