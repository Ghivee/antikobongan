"""Tes bentuk baris readings dan pesan event (tanpa jaringan)."""

from __future__ import annotations

import json
import unittest

try:
    from backend.main import FORMULA_VERSION, reading_row, risk_summary
except ImportError as exc:  # paho-mqtt belum terpasang
    raise unittest.SkipTest(f"dependensi backend belum terpasang: {exc}")
from backend.validator import sensor_topic, validate_message

PREFIX = "antikobongan/prototipe-gx7q4m"
NODE = "esp32-01"
TOPIC = sensor_topic(PREFIX, NODE)
RECEIVED = "2026-10-25T16:54:00+00:00"


def validated(**fields):
    data = {"suhu": 33.1, "kelembapan": 48.0, "gas": 1290, "gas_excess": 120, "kelembapan_tanah": 24, "riskScore": 61}
    data.update(fields)
    return validate_message(TOPIC, json.dumps(data), PREFIX, NODE)


class ReadingRowTests(unittest.TestCase):
    def test_row_keeps_gas_excess_and_formula(self):
        row = reading_row(validated(), NODE, RECEIVED)
        self.assertEqual(row["gas_excess"], 120)
        self.assertEqual(row["formula_version"], FORMULA_VERSION)
        self.assertEqual(row["risk_score"], 61)
        self.assertEqual(row["received_at"], RECEIVED)

    def test_no_formula_without_score(self):
        data = validated()
        data.risk_score = None
        row = reading_row(data, NODE, RECEIVED)
        self.assertIsNone(row["formula_version"])


class RiskSummaryTests(unittest.TestCase):
    def test_high_message_is_specific(self):
        row = reading_row(validated(), NODE, RECEIVED)
        text = risk_summary("RISK_HIGH", "HIGH", 61, row)
        self.assertTrue(text.startswith("Risiko TINGGI 61/100"))
        self.assertIn("suhu 33.1 °C", text)
        self.assertIn("tanah 24 %", text)

    def test_recovered_message(self):
        row = reading_row(validated(), NODE, RECEIVED)
        self.assertEqual(risk_summary("RISK_RECOVERED", "NORMAL", 38, row), "Risiko kembali normal: skor 38/100")


if __name__ == "__main__":
    unittest.main()
