"""Tes mesin alert risiko (tanpa jaringan)."""

from __future__ import annotations

import unittest

from backend.alerts import RiskAlertTracker


class AlertTests(unittest.TestCase):
    def setUp(self):
        self.tracker = RiskAlertTracker(high=60, critical=80, cooldown_seconds=300)

    def test_normal_no_alert(self):
        self.assertEqual(self.tracker.process(20, now=0.0), [])

    def test_high_threshold(self):
        alerts = self.tracker.process(60, now=0.0)
        self.assertEqual([a.kind for a in alerts], ["RISK_HIGH"])

    def test_below_high_no_alert(self):
        self.assertEqual(self.tracker.process(59, now=0.0), [])

    def test_critical_threshold(self):
        alerts = self.tracker.process(80, now=0.0)
        self.assertEqual([a.kind for a in alerts], ["RISK_CRITICAL"])

    def test_cooldown_suppresses_repeat_high(self):
        self.tracker.process(70, now=0.0)
        self.assertEqual(self.tracker.process(70, now=10.0), [])
        self.assertEqual(self.tracker.process(70, now=299.0), [])

    def test_repeat_high_after_cooldown(self):
        self.tracker.process(70, now=0.0)
        alerts = self.tracker.process(70, now=300.0)
        self.assertEqual([a.kind for a in alerts], ["RISK_HIGH"])

    def test_escalation_bypasses_cooldown(self):
        self.tracker.process(65, now=0.0)
        alerts = self.tracker.process(90, now=5.0)
        self.assertEqual([a.kind for a in alerts], ["RISK_CRITICAL"])

    def test_critical_repeat_cooldown(self):
        self.tracker.process(90, now=0.0)
        self.assertEqual(self.tracker.process(90, now=5.0), [])
        self.assertEqual([a.kind for a in self.tracker.process(90, now=305.0)], ["RISK_CRITICAL"])

    def test_recovery_once(self):
        self.tracker.process(70, now=0.0)
        alerts = self.tracker.process(20, now=10.0)
        self.assertEqual([a.kind for a in alerts], ["RISK_RECOVERED"])
        self.assertEqual(self.tracker.process(20, now=20.0), [])

    def test_recovery_from_critical(self):
        self.tracker.process(90, now=0.0)
        alerts = self.tracker.process(10, now=10.0)
        self.assertEqual([a.kind for a in alerts], ["RISK_RECOVERED"])

    def test_high_down_to_high_no_recovery(self):
        self.tracker.process(90, now=0.0)
        self.assertEqual(self.tracker.process(65, now=5.0), [])
        self.assertEqual(self.tracker.process(24.0, now=1000.0)[0].kind, "RISK_RECOVERED")

    def test_missing_risk_score_keeps_state(self):
        self.tracker.process(70, now=0.0)
        self.assertEqual(self.tracker.process(None, now=10.0), [])
        self.assertEqual(self.tracker.level, "HIGH")
        self.assertEqual(self.tracker.process(20, now=20.0)[0].kind, "RISK_RECOVERED")

    def test_zero_cooldown_repeats(self):
        tracker = RiskAlertTracker(high=60, critical=80, cooldown_seconds=0)
        self.assertEqual(len(tracker.process(70, now=0.0)), 1)
        self.assertEqual(len(tracker.process(70, now=0.0)), 1)

    def test_invalid_thresholds(self):
        with self.assertRaises(ValueError):
            RiskAlertTracker(high=80, critical=60)

    def test_confirm_cycles_filters_spikes(self):
        tracker = RiskAlertTracker(high=60, critical=80, confirm_cycles=3)
        self.assertEqual(tracker.process(75, now=0.0), [])  # Cycle 1
        self.assertEqual(tracker.process(75, now=2.0), [])  # Cycle 2
        alerts = tracker.process(75, now=4.0)               # Cycle 3 -> Confirmed!
        self.assertEqual([a.kind for a in alerts], ["RISK_HIGH"])
        self.assertEqual(tracker.level, "HIGH")

    def test_hysteresis_prevents_premature_drop(self):
        tracker = RiskAlertTracker(high=60, critical=80, hysteresis=3)
        self.assertEqual([a.kind for a in tracker.process(65, now=0.0)], ["RISK_HIGH"])
        # Nilai 58 masih >= (60 - 3), jadi tetap HIGH karena hysteresis
        self.assertEqual(tracker.process(58, now=5.0), [])
        self.assertEqual(tracker.level, "HIGH")
        # Nilai 56 < (60 - 3), baru memicu pemulihan ke NORMAL
        alerts = tracker.process(56, now=10.0)
        self.assertEqual([a.kind for a in alerts], ["RISK_RECOVERED"])
        self.assertEqual(tracker.level, "NORMAL")


if __name__ == "__main__":
    unittest.main()

