"""Tes perintah Telegram tanpa jaringan (data palsu)."""

from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from backend.commands import (
    BOT_COMMANDS,
    CommandHandler,
    TelegramCommandBot,
    detect_intent,
    parse_command,
    register_bot_commands,
)

NOW = datetime(2026, 11, 13, 1, 20, tzinfo=timezone.utc)  # 08:20 WIB
LATEST = {
    "received_at": (NOW - timedelta(seconds=5)).isoformat(),
    "sensor_ts": (NOW - timedelta(seconds=5)).isoformat(),
    "suhu": 27.8,
    "kelembapan": 75.0,
    "gas": 1949,
    "kelembapan_tanah": 23,
    "tekanan": 975.36,
    "risk_score": 45,
    "status": "SEDANG",
}


class FakeData:
    def __init__(self, latest=LATEST, status=None, rows=None, recent=None):
        self._latest = latest
        self._status = status if status is not None else {"node_id": "esp32-01", "online": True, "last_seen": LATEST["received_at"]}
        self._rows = rows if rows is not None else [
            {**LATEST, "received_at": (NOW - timedelta(minutes=10)).isoformat(), "suhu": 27.2, "risk_score": 30},
            LATEST,
        ]
        self._recent = recent if recent is not None else [LATEST]

    def latest(self):
        return self._latest

    def node_status(self):
        return self._status

    def readings_since(self, seconds):
        return self._rows

    def recent(self, limit=5):
        return self._recent[:limit]


def handler(data=None):
    return CommandHandler(
        data or FakeData(),
        "esp32-01",
        "antikobongan/prototipe-gx7q4m/esp32-01/sensor",
        15,
        now=lambda: NOW,
    )


class ParseTests(unittest.TestCase):
    def test_slash_commands_and_aliases(self):
        self.assertEqual(parse_command("/status"), "status")
        self.assertEqual(parse_command("/STATUS@antikobonganbot"), "status")
        self.assertEqual(parse_command(" /suhu "), "suhu")
        self.assertEqual(parse_command("/kelembapan"), "rh")
        self.assertEqual(parse_command("/bantuan"), "bantuan")
        self.assertEqual(parse_command("/tidakada"), "unknown")
        self.assertIsNone(parse_command("status"))

    def test_plain_questions(self):
        self.assertEqual(detect_intent("berapa suhu sekarang?"), "suhu")
        self.assertEqual(detect_intent("bagaimana kondisi di lokasi"), "status")
        self.assertEqual(detect_intent("kelembapan tanah berapa"), "tanah")
        self.assertEqual(detect_intent("apakah ada asap"), "gas")
        self.assertEqual(detect_intent("tekanan udaranya berapa"), "tekanan")
        self.assertEqual(detect_intent("apakah aman"), "status")
        self.assertEqual(detect_intent("tampilkan riwayat"), "riwayat")
        self.assertEqual(detect_intent("@antikobonganbot berapa suhu"), "suhu")
        self.assertEqual(detect_intent("@antikobonganbot apakah aman?"), "status")
        self.assertIsNone(detect_intent("halo"))

    def test_help_lists_every_command(self):
        reply = handler().reply("/bantuan")
        for name, _ in BOT_COMMANDS:
            self.assertIn(f"/{name}", reply)


class ReplyTests(unittest.TestCase):
    def test_status_reply(self):
        reply = handler().reply("/status")
        self.assertIn("Status: Siaga Cuaca Kering", reply)
        self.assertIn("Skor risiko: 45 dari 100", reply)
        self.assertIn("Suhu: 27,8 °C", reply)
        self.assertIn("Kelembapan udara: 75,0 %", reply)
        self.assertIn("Gas dan asap: 1949 ADC", reply)
        self.assertIn("Kelembapan tanah: 23 %", reply)
        self.assertIn("Tekanan udara: 975,36 hPa", reply)
        self.assertIn("baru saja", reply)
        self.assertIn("Saran: Tingkatkan pemantauan lokasi.", reply)
        self.assertNotIn("*", reply)
        self.assertNotIn("data sudah basi", reply)

    def test_metric_reply_has_hour_trend(self):
        reply = handler().reply("/suhu")
        self.assertIn("Suhu udara", reply)
        self.assertIn("Nilai: 27,8 °C", reply)
        self.assertIn("Tren 1 jam: 27,2 °C–27,8 °C, rata-rata 27,5 °C", reply)

    def test_trend_and_daily(self):
        reply = handler().reply("/tren")
        self.assertIn("Ringkasan 1 jam terakhir", reply)
        self.assertIn("Jumlah pembacaan: 2", reply)
        self.assertIn("Skor risiko: 30–45", reply)
        self.assertIn("Ringkasan 24 jam terakhir", handler().reply("/harian"))

    def test_recent(self):
        reply = handler().reply("/riwayat")
        self.assertIn("1 pembacaan terakhir", reply)
        self.assertIn("skor 45", reply)

    def test_node(self):
        reply = handler().reply("/node")
        self.assertIn("Node esp32-01", reply)
        self.assertIn("online", reply)
        self.assertIn("Ambang data basi: 15 detik", reply)
        self.assertIn("antikobongan/prototipe-gx7q4m/esp32-01/sensor", reply)

    def test_time_and_chat_id(self):
        self.assertIn("Waktu server: 13 Nov 2026 08:20:00 WIB", handler().reply("/waktu"))
        self.assertIn("Chat id: 7335894264", handler().reply("/id", {"id": "7335894264", "type": "private"}))

    def test_stale_data_warning(self):
        old = {**LATEST, "received_at": (NOW - timedelta(minutes=10)).isoformat()}
        reply = handler(FakeData(latest=old)).reply("/status")
        self.assertIn("data sudah basi", reply)
        self.assertIn("online, tetapi data basi", reply)

    def test_no_data(self):
        empty = FakeData(latest=None, rows=[], recent=[])
        self.assertIn("Belum ada data sensor", handler(empty).reply("/status"))
        self.assertIn("Belum ada pembacaan", handler(empty).reply("/tren"))

    def test_unknown_text(self):
        self.assertIn("/bantuan", handler().reply("/tidakada"))
        self.assertIn("/bantuan", handler().reply("halo"))


class BotRoutingTests(unittest.TestCase):
    def _bot(self, allow_unknown=True):
        return TelegramCommandBot("token-uji", ["7335894264"], handler(), allow_unknown=allow_unknown)

    @staticmethod
    def _update(text, chat_id="7335894264", chat_type="private", is_bot=False):
        return {
            "update_id": 1,
            "message": {
                "text": text,
                "from": {"is_bot": is_bot},
                "chat": {"id": chat_id, "type": chat_type},
            },
        }

    def test_allowed_chat_gets_reply(self):
        pair = self._bot().reply_for_update(self._update("/status"))
        self.assertEqual(pair[0], "7335894264")
        self.assertIn("Skor risiko: 45 dari 100", pair[1])

    def test_group_command_with_bot_suffix(self):
        pair = self._bot().reply_for_update(self._update("/suhu@antikobonganbot", chat_id="-100123", chat_type="group"))
        self.assertIn("Nilai: 27,8 °C", pair[1])

    def test_unknown_chat_rejected_with_id_when_restricted(self):
        bot = self._bot(allow_unknown=False)
        pair = bot.reply_for_update(self._update("/status", chat_id="-100999", chat_type="group"))
        self.assertIn("belum terdaftar", pair[1])
        self.assertIn("-100999", pair[1])

    def test_public_by_default(self):
        pair = self._bot().reply_for_update(self._update("/status", chat_id="-100999", chat_type="group"))
        self.assertIn("Skor risiko: 45 dari 100", pair[1])

    def test_group_mention_question(self):
        bot = TelegramCommandBot("token-uji", [], handler())
        pair = bot.reply_for_update(self._update("@antikobonganbot berapa suhu", chat_id="-100999", chat_type="group"))
        self.assertIn("Nilai: 27,8 °C", pair[1])

    def test_allow_unknown_switch(self):
        pair = self._bot(allow_unknown=True).reply_for_update(self._update("/status", chat_id="-100999", chat_type="group"))
        self.assertIn("Skor risiko", pair[1])

    def test_ignores_bots_and_empty(self):
        self.assertIsNone(self._bot().reply_for_update(self._update("/status", is_bot=True)))
        self.assertIsNone(self._bot().reply_for_update({"update_id": 2, "message": {"chat": {"id": 1}}}))


class MenuTests(unittest.TestCase):
    @patch("backend.commands.requests.post")
    def test_set_my_commands_payload(self, post):
        post.return_value.status_code = 200
        self.assertTrue(register_bot_commands("token-uji"))
        payload = post.call_args.kwargs["json"]
        names = [item["command"] for item in payload["commands"]]
        self.assertIn("status", names)
        self.assertIn("bantuan", names)
        self.assertEqual(len(names), len(BOT_COMMANDS))


if __name__ == "__main__":
    unittest.main()
