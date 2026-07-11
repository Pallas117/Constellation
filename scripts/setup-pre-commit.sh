#!/bin/bash
# Setup pre-commit hooks for local development
# Run: bash scripts/setup-pre-commit.sh

set -e

echo "🔧 Setting up pre-commit hooks..."

# Check if Python is available
if ! command -v python3 &> /dev/null; then
  echo "❌ Python 3 is required. Install from https://www.python.org/downloads/"
  exit 1
fi

# Install pre-commit
echo "Installing pre-commit..."
pip install pre-commit --quiet || pip3 install pre-commit --quiet

# Install the git hook scripts
echo "Installing git hooks..."
pre-commit install --hook-type pre-commit
pre-commit install --hook-type commit-msg

echo "✅ Pre-commit hooks installed successfully"
echo ""
echo "ℹ️  To run hooks on all files:"
echo "   pre-commit run --all-files"
echo ""
echo "ℹ️  To run specific hook:"
echo "   pre-commit run detect-secrets --all-files"
echo "   pre-commit run trufflehog --all-files"
