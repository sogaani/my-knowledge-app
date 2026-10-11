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
if [ -f /secrets/git-crypt/key ] && ! git-crypt status -e 2>/dev/null | grep -q .; then
  git-crypt unlock /secrets/git-crypt/key || echo "git-crypt unlock failed (repo may not be encrypted yet)"
fi
cd /app
exec "$@"
