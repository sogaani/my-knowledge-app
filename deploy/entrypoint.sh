#!/usr/bin/env bash
# Clone the data repo on first start, unlock git-crypt, then exec the API.
set -euo pipefail
: "${KB_GIT_URL:?set KB_GIT_URL (ssh url of the data repo)}"
mkdir -p /root/.ssh "$DATA_DIR"
if [ -f /secrets/ssh/deploy_key ]; then
  cp /secrets/ssh/deploy_key /root/.ssh/id_ed25519 && chmod 600 /root/.ssh/id_ed25519
  ssh-keyscan -H "$(echo "$KB_GIT_URL" | sed -E 's#^(ssh://)?[^@]*@([^:/]+).*#\2#')" >> /root/.ssh/known_hosts 2>/dev/null || true
fi
if [ ! -d "$KB_ROOT/.git" ]; then
  git clone --branch "${KB_GIT_BRANCH:-main}" "$KB_GIT_URL" "$KB_ROOT"
fi
cd "$KB_ROOT"
git config user.name "${GIT_USER_NAME:-kb-web}"
git config user.email "${GIT_USER_EMAIL:-kb-web@local}"
# Unlock once per clone. `git-crypt unlock` stores the key under .git/git-crypt/keys/ and that survives on the PVC;
# testing `git-crypt status -e` here was wrong (it lists encrypted paths whether or not the repo is unlocked, so an
# already-encrypted repo was never unlocked and 202/203/207 + the encrypted Gold views stayed unreadable to the API).
if [ -f /secrets/git-crypt/key ]; then
  if [ -f .git/git-crypt/keys/default ]; then
    echo "git-crypt: already unlocked"
  elif git-crypt unlock /secrets/git-crypt/key; then
    echo "git-crypt: unlocked"
  else
    echo "git-crypt: unlock FAILED; encrypted notes (202/203/207, Gold 302/303/308) will be missing from the index" >&2
  fi
else
  echo "git-crypt: no key mounted; encrypted notes will be missing from the index" >&2
fi
# Bring an existing clone up to date before the API starts: it reads schemas and folders at import time, before its
# own first sync, so a layout change in the data repo (e.g. the 2026-10 three-digit renumbering) would crash-loop it.
if git pull --ff-only --quiet; then
  echo "git: $(git rev-parse --short HEAD)"
else
  echo "git: pull failed; starting on $(git rev-parse --short HEAD)" >&2
fi
cd /app
exec "$@"
