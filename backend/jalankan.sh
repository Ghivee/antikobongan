#!/bin/sh
# Jalankan backend AntiKobongan (macOS/Linux) dari root proyek. Tidak berisi rahasia.
cd "$(dirname "$0")/.." || exit 1
if [ ! -x ".venv/bin/python" ]; then
  echo "Virtual environment .venv belum ada. Jalankan:"
  echo "  python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt"
  exit 1
fi
echo "Menjalankan backend AntiKobongan. Cegah Mac tidur selama pemantauan: caffeinate -i ./backend/jalankan.sh"
exec .venv/bin/python backend/main.py "$@"
