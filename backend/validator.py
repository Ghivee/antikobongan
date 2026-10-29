"""Validasi topic + payload sensor AntiKobongan (dipakai backend dan tes)."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

REQUIRED_RANGES = {
    "suhu": (-20.0, 80.0),
    "kelembapan": (0.0, 100.0),
    "gas": (0.0, 4095.0),
}
OPTIONAL_RANGES = {
    "tekanan": (300.0, 1100.0),
    "kelembapan_tanah": (0.0, 100.0),
    "gas_excess": (0.0, 4095.0),
}
VALID_STATUS = {"NORMAL", "SEDANG", "TINGGI", "KRITIS"}


@dataclass
class ValidationResult:
    ok: bool
    error: str | None = None
    values: dict[str, Any] = field(default_factory=dict)
    sensor_ts: str | None = None
    risk_score: int | None = None
    status: str | None = None
    timestamp_invalid: bool = False
    warnings: list[str] = field(default_factory=list)


def sensor_topic(prefix: str, node_id: str) -> str:
    return f"{prefix.rstrip('/')}/{node_id}/sensor"


def _reject_constant(value: str) -> None:
    raise ValueError(f"konstanta JSON tidak diizinkan: {value}")


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _parse_timestamp(value: Any) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    if not isinstance(value, str) or not value.strip():
        return None, True
    text = value.strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None, True
    if parsed.tzinfo is None:
        return None, True
    return parsed.isoformat(), False


def validate_message(topic: str, payload: bytes | str, prefix: str, node_id: str) -> ValidationResult:
    expected_topic = sensor_topic(prefix, node_id)
    if topic != expected_topic:
        return ValidationResult(ok=False, error="topic tidak persis sama dengan topic sensor node")

    if isinstance(payload, bytes):
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            return ValidationResult(ok=False, error="payload bukan UTF-8")
    else:
        text = payload

    try:
        data = json.loads(text, parse_constant=_reject_constant)
    except (ValueError, TypeError):
        return ValidationResult(ok=False, error="payload bukan JSON valid")

    if not isinstance(data, dict):
        return ValidationResult(ok=False, error="payload harus objek JSON")

    values: dict[str, Any] = {}
    for key, (minimum, maximum) in REQUIRED_RANGES.items():
        if key not in data:
            return ValidationResult(ok=False, error=f"field wajib '{key}' tidak ada")
        value = data[key]
        if not _is_number(value):
            return ValidationResult(ok=False, error=f"field '{key}' bukan angka finite")
        if value < minimum or value > maximum:
            return ValidationResult(ok=False, error=f"field '{key}' di luar rentang {minimum:g}..{maximum:g}")
        values[key] = int(round(float(value))) if key == "gas" else float(value)

    warnings: list[str] = []
    for key, (minimum, maximum) in OPTIONAL_RANGES.items():
        raw_val = data.get(key)
        if raw_val is None and key == "kelembapan_tanah":
            raw_val = data.get("tanah")
        if raw_val is None:
            values[key] = None
            continue
        value = raw_val
        if not _is_number(value):
            warnings.append(f"field '{key}' bukan angka finite; diabaikan")
            values[key] = None
            continue
        if value < minimum or value > maximum:
            warnings.append(f"field '{key}' di luar rentang {minimum:g}..{maximum:g}; diabaikan")
            values[key] = None
            continue
        values[key] = int(round(float(value))) if key == "gas_excess" else float(value)

    risk_score: int | None = None
    if data.get("riskScore") is not None:
        value = data["riskScore"]
        if not _is_number(value):
            warnings.append("field 'riskScore' bukan angka finite; diabaikan")
        elif value < 0 or value > 100:
            warnings.append("field 'riskScore' di luar rentang 0..100; diabaikan")
        elif float(value) != int(float(value)):
            warnings.append("field 'riskScore' bukan bilangan bulat; diabaikan")
        else:
            risk_score = int(value)

    status: str | None = None
    if data.get("status") is not None:
        value = data["status"]
        if isinstance(value, str) and value in VALID_STATUS:
            status = value
        else:
            warnings.append("field 'status' bukan NORMAL/SEDANG/TINGGI/KRITIS; diabaikan")

    sensor_ts, timestamp_invalid = _parse_timestamp(data.get("timestamp"))
    if timestamp_invalid:
        warnings.append("field 'timestamp' tidak valid; sensor_ts dikosongkan")

    return ValidationResult(
        ok=True,
        values=values,
        sensor_ts=sensor_ts,
        risk_score=risk_score,
        status=status,
        timestamp_invalid=timestamp_invalid,
        warnings=warnings,
    )
