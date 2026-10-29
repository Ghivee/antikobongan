"""Mesin status notifikasi risiko (tanpa jaringan, mudah dites)."""

from __future__ import annotations

import time
from dataclasses import dataclass

RANK = {"NORMAL": 0, "HIGH": 1, "CRITICAL": 2}


@dataclass(frozen=True)
class RiskAlert:
    kind: str
    level: str
    risk_score: int


class RiskAlertTracker:
    """Menentukan event risiko dari riskScore firmware.

    Aturan:
    - Naik ke HIGH/CRITICAL -> butuh N pembacaan berturut-turut (confirm_cycles, default 1).
    - Eskalasi langsung menembus cooldown.
    - Level sama -> event lagi hanya setelah cooldown.
    - Hysteresis -> turun hanya setelah nilai melewati batas minus margin hysteresis.
    - Turun dari HIGH/CRITICAL ke NORMAL -> tepat satu RISK_RECOVERED.
    - riskScore tidak ada (None) -> tidak mengubah state dan tidak ada event.
    """

    def __init__(
        self,
        high: int = 60,
        critical: int = 80,
        cooldown_seconds: int = 300,
        confirm_cycles: int = 1,
        hysteresis: int = 0,
    ) -> None:
        if critical < high:
            raise ValueError("critical tidak boleh lebih kecil dari high")
        self.high = high
        self.critical = critical
        self.cooldown_seconds = cooldown_seconds
        self.confirm_cycles = max(1, confirm_cycles)
        self.hysteresis = max(0, hysteresis)
        self._level = "NORMAL"
        self._last_emit_at: float | None = None
        self._pending_target: str | None = None
        self._pending_count: int = 0

    @property
    def level(self) -> str:
        return self._level

    def process(self, risk_score: int | None, now: float | None = None) -> list[RiskAlert]:
        if risk_score is None:
            return []
        moment = time.monotonic() if now is None else now

        # 1. Tentukan raw target berdasarkan threshold
        if risk_score >= self.critical:
            raw_target = "CRITICAL"
        elif risk_score >= self.high:
            raw_target = "HIGH"
        else:
            raw_target = "NORMAL"

        # 2. Hysteresis saat penurunan
        if self._level == "CRITICAL" and raw_target != "CRITICAL":
            if risk_score >= (self.critical - self.hysteresis):
                raw_target = "CRITICAL"
            elif risk_score >= (self.high - self.hysteresis):
                raw_target = "HIGH"
            else:
                raw_target = "NORMAL"
        elif self._level == "HIGH" and raw_target == "NORMAL":
            if risk_score >= (self.high - self.hysteresis):
                raw_target = "HIGH"

        # 3. Konfirmasi N pembacaan untuk kenaikan level
        if RANK[raw_target] > RANK[self._level]:
            if raw_target == self._pending_target:
                self._pending_count += 1
            else:
                self._pending_target = raw_target
                self._pending_count = 1

            if self._pending_count >= self.confirm_cycles:
                target = raw_target
                self._pending_target = None
                self._pending_count = 0
            else:
                target = self._level
        else:
            self._pending_target = None
            self._pending_count = 0
            target = raw_target

        # 4. Tangani pemulihan ke NORMAL
        if target == "NORMAL":
            recovered = []
            if self._level in ("HIGH", "CRITICAL"):
                recovered.append(RiskAlert("RISK_RECOVERED", "NORMAL", risk_score))
                self._last_emit_at = moment
            self._level = "NORMAL"
            return recovered

        # 5. Tangani eskalasi dan cooldown
        escalated = RANK[target] > RANK[self._level]
        cooldown_ok = self._last_emit_at is None or (moment - self._last_emit_at) >= self.cooldown_seconds
        alerts: list[RiskAlert] = []
        if escalated or cooldown_ok:
            alerts.append(RiskAlert(f"RISK_{target}", target, risk_score))
            self._last_emit_at = moment
        self._level = target
        return alerts
