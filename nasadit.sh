#!/usr/bin/env bash
# Nasadí aktuální stav kokpitu na web (GitHub Pages).
# Dat v privátním repu poutnik-data se tohle netýká.
set -euo pipefail
cd "$(dirname "$0")"
git add -A
if git diff --cached --quiet; then echo "Nic se nezměnilo."; exit 0; fi
git commit -m "${1:-Úprava kokpitu}"
git push origin main
echo
echo "Nasazeno. Za chvíli živé na:"
echo "  https://frantisekdron.github.io/poutnik-kokpit/"
