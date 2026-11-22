"""Tes topic status (LWT), default stale, dan dedupe notifikasi (tanpa jaringan)."""

from __future__ import annotations

import logging
import unittest

from backend.config import Config
from backend.validator import status_topic, validate_status

try:
    from backend.main import BackendApp
except ImportError as exc:  # paho-mqtt / dependensi backend belum terpasang
    BackendApp = None
    BACKEND_IMPORT_ERROR = exc
else:
    BACKEND_IMPORT_ERROR = None

PREFIX = "antikobongan/prototipe-gx7q4m"
NODE = "esp32-01"


class StatusValueTests(unittest.TestCase):
    def test_accepts_online_offline(self):
        self.assertEqual(validate_status("online"), "online")
        self.assertEqual(validate_status("offline"), "offline")
        self.assertEqual(validate_status(b"online"), "online")
        self.assertEqual(validate_status(" offline \n"), "offline")

    def test_rejects_other_values(self):
        for value in ("", "ONLINE", "Offline", "mati", "online2", "1", "online/offline", None):
            with self.subTest(value=value):
                self.assertIsNone(validate_status(value))

    def test_rejects_invalid_utf8(self):
        self.assertIsNone(validate_status(b"\xff\xfe"))

    def test_topic_shape(self):
        self.assertEqual(status_topic(PREFIX, NODE), f"{PREFIX}/{NODE}/status")


class ConfigDefaultsTests(unittest.TestCase):
    def test_stale_default_15_seconds(self):
        self.assertEqual(Config().stale_seconds, 15)

    def test_config_status_topic(self):
        self.assertEqual(Config().status_topic, f"{PREFIX}/{NODE}/status")


@unittest.skipIf(BackendApp is None, f"dependensi backend belum terpasang: {BACKEND_IMPORT_ERROR}")
class StatusDedupeTests(unittest.TestCase):
    """LWT + watchdog tidak boleh mengirim notifikasi ganda untuk transisi sama."""

    def setUp(self):
        self.app = BackendApp(Config(), logging.getLogger("test-status"))

    def test_same_transition_suppressed_within_cooldown(self):
        self.assertTrue(self.app._announce_once("NODE_OFFLINE"))
        self.assertFalse(self.app._announce_once("NODE_OFFLINE"))

    def test_opposite_transition_allowed(self):
        self.assertTrue(self.app._announce_once("NODE_OFFLINE"))
        self.assertTrue(self.app._announce_once("NODE_ONLINE"))

    def test_new_offline_after_online_allowed(self):
        self.assertTrue(self.app._announce_once("NODE_OFFLINE"))
        self.assertTrue(self.app._announce_once("NODE_ONLINE"))
        self.assertTrue(self.app._announce_once("NODE_OFFLINE"))


if __name__ == "__main__":
    unittest.main()
