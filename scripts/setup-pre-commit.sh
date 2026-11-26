#!/bin/bash
# Installs the git hooks in .pre-commit-config.yaml (secrets, files that must never
# be committed, hygiene, ESLint, commit messages) for this clone and its worktrees.
#   npm run security:setup-hooks
# pre-commit comes from pipx when present, else a private venv in
# ~/.local/share/gauss-dev; never `pip install` into the system Python (Debian and
# Homebrew Python refuse it, PEP 668).
set -euo pipefail

PRE_COMMIT_VERSION=4.6.2
cd "$(git rev-parse --show-toplevel)"

if ! command -v pre-commit >/dev/null 2>&1; then
  echo "Installing pre-commit $PRE_COMMIT_VERSION..."
  if command -v pipx >/dev/null 2>&1; then
    pipx install --quiet "pre-commit==$PRE_COMMIT_VERSION"
  else
    command -v python3 >/dev/null 2>&1 || { echo "❌ Python 3 is needed for pre-commit." >&2; exit 1; }
    venv="$HOME/.local/share/gauss-dev/venv"
    python3 -m venv "$venv"
    "$venv/bin/pip" install --quiet "pre-commit==$PRE_COMMIT_VERSION"
    mkdir -p "$HOME/.local/bin"
    ln -sf "$venv/bin/pre-commit" "$HOME/.local/bin/pre-commit"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  command -v pre-commit >/dev/null 2>&1 || { echo "❌ pre-commit installed but not on PATH: add ~/.local/bin to PATH." >&2; exit 1; }
fi

if git config --get core.hooksPath >/dev/null 2>&1; then
  echo "❌ core.hooksPath is set ($(git config --get core.hooksPath)), so pre-commit can't install its hooks." >&2
  echo "   Unset it for this repo (git config --unset core.hooksPath) or add the hooks there yourself." >&2
  exit 1
fi

pre-commit install --install-hooks # pre-commit and commit-msg (default_install_hook_types)

if ! bash scripts/check-secrets-local.sh --check >/dev/null 2>&1; then
  echo "⚠️  TruffleHog 3 is missing, so the TruffleHog hook will fail every commit: brew install trufflehog" >&2
  echo "   (Linux: see docs/REMOTE_DEVELOPMENT.md). Check with: npm run dev:doctor" >&2
fi

echo "✅ Git hooks installed. Run them on everything: pre-commit run --all-files"
