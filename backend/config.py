"""Konfigurasi backend AntiKobongan dari environment / backend/.env."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # python-dotenv opsional
    load_dotenv = None

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"


class ConfigError(Exception):
    """Kesalahan konfigurasi yang aman ditampilkan (tanpa nilai rahasia)."""


def _text(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _flag(name: str, default: bool = False) -> bool:
    raw = _text(name)
    if not raw:
        return default
    return raw.lower() in {"1", "true", "ya", "yes", "on"}


def _integer(name: str, default: int, minimum: int | None = None) -> int:
    raw = _text(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} harus berupa bilangan bulat.") from exc
    if minimum is not None and value < minimum:
        raise ConfigError(f"{name} minimal {minimum}.")
    return value


@dataclass(frozen=True)
class Config:
    mqtt_host: str = "broker.hivemq.com"
    mqtt_port: int = 1883
    mqtt_username: str = ""
    mqtt_password: str = field(default="", repr=False)
    mqtt_tls: bool = False
    topic_prefix: str = "antikobongan/prototipe-gx7q4m"
    node_id: str = "esp32-01"
    supabase_url: str = ""
    supabase_secret_key: str = field(default="", repr=False)
    telegram_bot_token: str = field(default="", repr=False)
    telegram_chat_id: str = field(default="", repr=False)
    stale_seconds: int = 30
    retention_days: int = 90
    alert_risk_high: int = 60
    alert_risk_critical: int = 80
    alert_cooldown_seconds: int = 300

    @property
    def sensor_topic(self) -> str:
        return f"{self.topic_prefix.rstrip('/')}/{self.node_id}/sensor"

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_secret_key)

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_bot_token and self.telegram_chat_id)


def load_config(env_path: Path | None = None) -> Config:
    """Muat .env (bila ada) dan environment. Tidak pernah mencetak nilai rahasia."""
    path = env_path or ENV_PATH
    if load_dotenv is not None and path.is_file():
        load_dotenv(path, override=False)

    prefix = _text("TOPIC_PREFIX", "antikobongan/prototipe-gx7q4m").rstrip("/")
    node_id = _text("NODE_ID", "esp32-01")
    if not prefix:
        raise ConfigError("TOPIC_PREFIX tidak boleh kosong.")
    if not node_id:
        raise ConfigError("NODE_ID tidak boleh kosong.")

    mqtt_tls = _flag("MQTT_TLS")
    mqtt_port = _integer("MQTT_PORT", 8883 if mqtt_tls else 1883, 1)
    if mqtt_port > 65535:
        raise ConfigError("MQTT_PORT maksimal 65535.")

    retention_raw = os.environ.get("RETENTION_DAYS")
    retention_days = 0 if retention_raw is not None and not retention_raw.strip() else _integer("RETENTION_DAYS", 90, 0)

    cfg = Config(
        mqtt_host=_text("MQTT_HOST", "broker.hivemq.com"),
        mqtt_port=mqtt_port,
        mqtt_username=_text("MQTT_USERNAME"),
        mqtt_password=_text("MQTT_PASSWORD"),
        mqtt_tls=mqtt_tls,
        topic_prefix=prefix,
        node_id=node_id,
        supabase_url=_text("SUPABASE_URL").rstrip("/"),
        supabase_secret_key=_text("SUPABASE_SECRET_KEY"),
        telegram_bot_token=_text("TELEGRAM_BOT_TOKEN"),
        telegram_chat_id=_text("TELEGRAM_CHAT_ID"),
        stale_seconds=_integer("STALE_SECONDS", 30, 1),
        retention_days=retention_days,
        alert_risk_high=_integer("ALERT_RISK_HIGH", 60, 0),
        alert_risk_critical=_integer("ALERT_RISK_CRITICAL", 80, 0),
        alert_cooldown_seconds=_integer("ALERT_COOLDOWN_SECONDS", 300, 0),
    )
    if cfg.alert_risk_critical < cfg.alert_risk_high:
        raise ConfigError("ALERT_RISK_CRITICAL tidak boleh lebih kecil dari ALERT_RISK_HIGH.")
    if not cfg.mqtt_host:
        raise ConfigError("MQTT_HOST tidak boleh kosong.")
    if cfg.supabase_url and not cfg.supabase_url.startswith("https://"):
        raise ConfigError("SUPABASE_URL harus memakai https://.")
    return cfg
