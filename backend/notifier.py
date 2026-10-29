"""Notifikasi Telegram. Tidak pernah mencatat token/URL berisi token."""

from __future__ import annotations

import logging

import requests


class TelegramNotifier:
    def __init__(self, token: str, chat_id: str, logger: logging.Logger | None = None) -> None:
        self._token = (token or "").strip()
        self._chat_id = (chat_id or "").strip()
        self._logger = logger or logging.getLogger("antikobongan")
        self.enabled = bool(self._token and self._chat_id)
        self._disabled_logged = False

    def send(self, text: str) -> bool:
        if not self.enabled:
            if not self._disabled_logged:
                self._logger.info("Telegram nonaktif (token/chat id belum diisi).")
                self._disabled_logged = True
            return False

        url = f"https://api.telegram.org/bot{self._token}/sendMessage"
        payload = {"chat_id": self._chat_id, "text": text[:4000], "disable_web_page_preview": True}
        try:
            response = requests.post(url, json=payload, timeout=10)
        except requests.RequestException as exc:
            self._logger.warning("Telegram gagal dikirim: %s", type(exc).__name__)
            return False

        if response.status_code == 200:
            return True
        description = ""
        try:
            description = str(response.json().get("description", ""))[:120]
        except Exception:
            pass
        self._logger.warning("Telegram HTTP %s %s", response.status_code, description)
        return False
