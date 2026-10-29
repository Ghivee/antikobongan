"""Tes validator backend (tanpa jaringan)."""

from __future__ import annotations

import json
import unittest

from backend.validator import sensor_topic, validate_message

PREFIX = "antikobongan/prototipe-gx7q4m"
NODE = "esp32-01"
TOPIC = sensor_topic(PREFIX, NODE)


def payload(**overrides):
    data = {
        "suhu": 28.4,
        "kelembapan": 72.0,
        "gas": 1350,
        "kelembapan_tanah": 41,
        "riskScore": 28,
        "status": "NORMAL",
        "timestamp": "2026-10-20T09:25:00+07:00",
    }
    data.update(overrides)
    return json.dumps(data)


class ValidatorTests(unittest.TestCase):
    def test_valid_without_pressure(self):
        result = validate_message(TOPIC, payload(), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.values["tekanan"])
        self.assertEqual(result.values["suhu"], 28.4)
        self.assertEqual(result.risk_score, 28)
        self.assertEqual(result.status, "NORMAL")
        self.assertIsNotNone(result.sensor_ts)
        self.assertFalse(result.timestamp_invalid)

    def test_valid_with_pressure(self):
        result = validate_message(TOPIC, payload(tekanan=1008.6), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.values["tekanan"], 1008.6)

    def test_valid_with_soil(self):
        result = validate_message(TOPIC, payload(kelembapan_tanah=41), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.values["kelembapan_tanah"], 41.0)

    def test_wrong_topic(self):
        result = validate_message(f"{PREFIX}/node-lain/sensor", payload(), PREFIX, NODE)
        self.assertFalse(result.ok)
        self.assertIn("topic", result.error)

    def test_topic_with_suffix(self):
        result = validate_message(TOPIC + "/extra", payload(), PREFIX, NODE)
        self.assertFalse(result.ok)

    def test_bad_json(self):
        result = validate_message(TOPIC, '{"suhu":28.4,"kelembapan":', PREFIX, NODE)
        self.assertFalse(result.ok)
        self.assertIn("JSON", result.error)

    def test_non_dict_json(self):
        result = validate_message(TOPIC, "[1,2,3]", PREFIX, NODE)
        self.assertFalse(result.ok)

    def test_non_numeric_required(self):
        result = validate_message(TOPIC, payload(suhu="panas"), PREFIX, NODE)
        self.assertFalse(result.ok)
        self.assertIn("suhu", result.error)

    def test_missing_required(self):
        data = json.loads(payload())
        del data["gas"]
        result = validate_message(TOPIC, json.dumps(data), PREFIX, NODE)
        self.assertFalse(result.ok)
        self.assertIn("gas", result.error)

    def test_out_of_range(self):
        for field, value in (("suhu", 200), ("kelembapan", -1), ("gas", 5000)):
            with self.subTest(field=field):
                result = validate_message(TOPIC, payload(**{field: value}), PREFIX, NODE)
                self.assertFalse(result.ok)
                self.assertIn("rentang", result.error)

    def test_optional_out_of_range_ignored(self):
        result = validate_message(TOPIC, payload(tekanan=50, kelembapan_tanah=150), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.values["tekanan"])
        self.assertIsNone(result.values["kelembapan_tanah"])
        self.assertEqual(len(result.warnings), 2)

    def test_invalid_timestamp_uses_null(self):
        result = validate_message(TOPIC, payload(timestamp="kemarin"), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.sensor_ts)
        self.assertTrue(result.timestamp_invalid)
        self.assertTrue(any("timestamp" in warning for warning in result.warnings))

    def test_naive_timestamp_is_invalid(self):
        result = validate_message(TOPIC, payload(timestamp="2026-10-20T09:25:00"), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.sensor_ts)
        self.assertTrue(result.timestamp_invalid)

    def test_risk_score_out_of_range_ignored(self):
        result = validate_message(TOPIC, payload(riskScore=150), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.risk_score)
        self.assertTrue(any("riskScore" in warning for warning in result.warnings))

    def test_status_invalid_ignored(self):
        result = validate_message(TOPIC, payload(status="PANAS"), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.status)
        self.assertTrue(any("status" in warning for warning in result.warnings))

    def test_without_risk_score(self):
        data = json.loads(payload())
        del data["riskScore"]
        result = validate_message(TOPIC, json.dumps(data), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.risk_score)

    def test_nan_rejected(self):
        text = '{"suhu":NaN,"kelembapan":72,"gas":1350}'
        result = validate_message(TOPIC, text, PREFIX, NODE)
        self.assertFalse(result.ok)

    def test_bool_is_not_number(self):
        result = validate_message(TOPIC, payload(suhu=True), PREFIX, NODE)
        self.assertFalse(result.ok)

    def test_gas_excess_saved_as_int(self):
        result = validate_message(TOPIC, payload(gas_excess=212.4), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.values["gas_excess"], 212)

    def test_gas_excess_optional(self):
        result = validate_message(TOPIC, payload(), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.values["gas_excess"])

    def test_gas_excess_out_of_range_ignored(self):
        result = validate_message(TOPIC, payload(gas_excess=9000), PREFIX, NODE)
        self.assertTrue(result.ok, result.error)
        self.assertIsNone(result.values["gas_excess"])
        self.assertTrue(any("gas_excess" in w for w in result.warnings))


if __name__ == "__main__":
    unittest.main()
