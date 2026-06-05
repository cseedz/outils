#!/usr/bin/env bash
# Chiffre src/index.html → index.html avec StaticCrypt
# Usage : STATICRYPT_PASSWORD='...' bash encrypt.sh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/src"

export STATICRYPT_PASSWORD

npx staticrypt index.html \
  --config ../.staticrypt.json \
  -d "$SCRIPT_DIR" \
  --remember 30 \
  --template-color-primary "#111111" \
  --template-color-secondary "#f5f5f5" \
  --template-button "Entrer" \
  --template-placeholder "Mot de passe" \
  --template-remember "Se souvenir (30 jours)" \
  --template-error "Mot de passe incorrect." \
  --template-title "Outils — Charles Grenier" \
  --short

echo "✓ index.html chiffré"
