#!/usr/bin/env bash
set -euo pipefail

pattern='(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,})'
files=()
while IFS= read -r -d '' path; do
  case "$path" in
    .github/scripts/secret-scan.sh|node_modules/*|*/node_modules/*|*/dist/*|.git/*)
      continue
      ;;
  esac
  files+=("$path")
done < <(git ls-files --cached --others --exclude-standard -z)

if ((${#files[@]} == 0)); then
  echo "Secret scan skipped: no repository files found."
  exit 0
fi

matches="$(rg --no-heading --line-number --hidden -I -e "$pattern" -- "${files[@]}" || true)"
if [[ -n "$matches" ]]; then
  printf '%s\n' "Potential credential material found:" >&2
  printf '%s\n' "$matches" >&2
  exit 1
fi

echo "Secret scan passed: no configured credential patterns found."
