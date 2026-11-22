"""Notifikasi Telegram. Tidak pernah mencatat token/URL berisi token.

Pesan dikirim sebagai teks polos (tanpa Markdown/HTML) ke semua chat id.
Tidak ada mention, sehingga semua anggota grup/kanal dapat melihatnya.
"""

from __future__ import annotations

import logging
import re

import requests


def parse_chat_ids(raw: str) -> list[str]:
    """Pisahkan beberapa chat id dengan koma, titik koma, atau spasi."""
    return [part for part in re.split(r"[,;\s]+", (raw or "").strip()) if part]


class TelegramNotifier:
    def __init__(self, token: str, chat_id: str, logger: logging.Logger | None = None) -> None:
        self._token = (token or "").strip()
        self._chat_ids = parse_chat_ids(chat_id)
        self._logger = logger or logging.getLogger("antikobongan")
        self.enabled = bool(self._token and self._chat_ids)
        self._disabled_logged = False

    def _send_one(self, chat_id: str, text: str) -> bool:
        url = f"https://api.telegram.org/bot{self._token}/sendMessage"
        payload = {"chat_id": chat_id, "text": text[:4000], "disable_web_page_preview": True}
        try:
            response = requests.post(url, json=payload, timeout=10)
        except requests.RequestException as exc:
            self._logger.warning("Telegram gagal dikirim ke %s: %s", chat_id, type(exc).__name__)
            return False

        if response.status_code == 200:
            return True
        description = ""
        try:
            description = str(response.json().get("description", ""))[:120]
        except Exception:
            pass
        self._logger.warning("Telegram HTTP %s untuk %s %s", response.status_code, chat_id, description)
        return False

    def send(self, text: str) -> bool:
        if not self.enabled:
            if not self._disabled_logged:
                self._logger.info("Telegram nonaktif (token/chat id belum diisi).")
                self._disabled_logged = True
            return False

        results = [self._send_one(chat_id, text) for chat_id in self._chat_ids]
        return bool(results) and all(results)

    def send_to(self, chat_id: str, text: str) -> bool:
        """Kirim ke satu chat (dipakai balasan perintah bot)."""
        if not self._token or not str(chat_id or "").strip():
            return False
        return self._send_one(str(chat_id), text)
