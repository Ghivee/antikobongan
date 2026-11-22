"""Tes notifier Telegram tanpa jaringan (token tidak dicetak)."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.notifier import TelegramNotifier, parse_chat_ids


class ParseChatIdsTests(unittest.TestCase):
    def test_accepts_comma_semicolon_and_space(self):
        self.assertEqual(parse_chat_ids(" -1001, -1002; @kanal "), ["-1001", "-1002", "@kanal"])
        self.assertEqual(parse_chat_ids(""), [])


class TelegramSendTests(unittest.TestCase):
    @patch("backend.notifier.requests.post")
    def test_sends_plain_text_to_every_chat(self, post):
        post.return_value.status_code = 200
        notifier = TelegramNotifier("token-uji", "-1001, -1002")
        self.assertTrue(notifier.send("AntiKobongan\nStatus: Normal"))
        self.assertEqual([c.kwargs["json"]["chat_id"] for c in post.call_args_list], ["-1001", "-1002"])
        payload = post.call_args_list[0].kwargs["json"]
        self.assertNotIn("parse_mode", payload)
        self.assertNotIn("@", payload["text"])

    @patch("backend.notifier.requests.post")
    def test_partial_failure_reports_false(self, post):
        responses = []
        for status in (200, 400):
            response = type("R", (), {"status_code": status, "json": lambda self: {"description": "gagal"}})()
            responses.append(response)
        post.side_effect = responses
        notifier = TelegramNotifier("token-uji", "1,2")
        self.assertFalse(notifier.send("halo"))


if __name__ == "__main__":
    unittest.main()
