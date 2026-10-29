"""Tampilkan TELEGRAM_CHAT_ID dari getUpdates (token dibaca dari backend/.env).

Token TIDAK pernah dicetak. Kirim dulu satu pesan ke bot, lalu jalankan:
    python backend\\get_chat_id.py
"""

from __future__ import annotations

import sys

import requests

try:
    from .config import ENV_PATH
except ImportError:
    from config import ENV_PATH

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


def main() -> int:
    if load_dotenv is not None and ENV_PATH.is_file():
        load_dotenv(ENV_PATH, override=False)

    import os

    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        print("TELEGRAM_BOT_TOKEN belum diisi di backend/.env.")
        return 2

    url = f"https://api.telegram.org/bot{token}/getUpdates"
    try:
        response = requests.get(url, timeout=15)
    except requests.RequestException as exc:
        print(f"Gagal menghubungi Telegram: {type(exc).__name__}")
        return 1

    if response.status_code != 200:
        print(f"Telegram menolak permintaan (HTTP {response.status_code}). Periksa token bot.")
        return 1

    try:
        data = response.json()
    except ValueError:
        print("Respons Telegram bukan JSON.")
        return 1
    if not data.get("ok"):
        print("Telegram mengembalikan status gagal. Periksa token bot.")
        return 1

    updates = data.get("result") or []
    if not updates:
        print("Belum ada update. Kirim satu pesan ke bot di Telegram, lalu jalankan ulang.")
        return 1

    seen: set[int] = set()
    for update in updates:
        message = update.get("message") or update.get("channel_post") or {}
        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None or chat_id in seen:
            continue
        seen.add(chat_id)
        name = chat.get("title") or chat.get("username") or chat.get("first_name") or "?"
        print(f"chat_id={chat_id}  nama={name}  tipe={chat.get('type', '?')}")
    if not seen:
        print("Update ada, tetapi tidak berisi chat id. Kirim pesan langsung ke bot.")
        return 1
    print("\nSalin chat_id ke TELEGRAM_CHAT_ID di backend/.env (jangan bagikan token).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
