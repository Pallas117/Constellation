#!/bin/bash
# scripts/setup-local-neo4j.sh
# Purpose: Setup Neo4j locally without Docker using Homebrew

echo "🚀 Setting up local Neo4j (No-Docker mode)..."

if ! command -v brew &> /dev/null; then
    echo "❌ Error: Homebrew is required for local setup on Mac."
    exit 1
fi

echo "📦 Installing Neo4j via Homebrew..."
brew install neo4j

echo "⚙️ Configuring Neo4j for project Gauss..."
# Start neo4j
neo4j start

echo "✨ Neo4j started! Access at http://localhost:7474"
echo "Username: neo4j"
echo "Default Password: password (you will be prompted to change it)"
echo ""
echo "Updating .env to point to local Neo4j..."
sed -i '' 's|bolt://localhost:7687|bolt://127.0.0.1:7687|g' .env

echo "✅ Local Neo4j setup complete."
