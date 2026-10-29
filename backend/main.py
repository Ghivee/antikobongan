"""Backend AntiKobongan: MQTT -> Supabase, watchdog, alert Telegram, retensi.

Jalankan dari root proyek:
    python backend\\main.py
atau:
    backend\\jalankan.bat
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from typing import Any

import paho.mqtt.client as mqtt

try:  # dukung `python -m backend.main` maupun `python backend\main.py`
    from .alerts import RiskAlertTracker
    from .config import BASE_DIR, Config, ConfigError, load_config
    from .notifier import TelegramNotifier
    from .store import StorageWorker, SupabaseRest
    from .validator import ValidationResult, validate_message
except ImportError:
    from alerts import RiskAlertTracker
    from config import BASE_DIR, Config, ConfigError, load_config
    from notifier import TelegramNotifier
    from store import StorageWorker, SupabaseRest
    from validator import ValidationResult, validate_message

WIB = timezone(timedelta(hours=7))
LOGGER_NAME = "antikobongan"
# Versi rumus risiko firmware (lihat calcRiskScore di esp32_firmware.ino).
FORMULA_VERSION = 1
LEVEL_TEXT = {"HIGH": "TINGGI", "CRITICAL": "KRITIS", "NORMAL": "NORMAL"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def wib_now_text() -> str:
    return datetime.now(WIB).strftime("%Y-%m-%d %H:%M:%S WIB")


def setup_logging() -> logging.Logger:
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return logger
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")

    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    logger.addHandler(console)

    log_dir = BASE_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(
        log_dir / "backend.log",
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    return logger


def reading_row(result: ValidationResult, node_id: str, received_at: str) -> dict[str, Any]:
    values = result.values
    return {
        "node_id": node_id,
        "received_at": received_at,
        "sensor_ts": result.sensor_ts,
        "suhu": values["suhu"],
        "kelembapan": values["kelembapan"],
        "gas": values["gas"],
        "tekanan": values.get("tekanan"),
        "kelembapan_tanah": values.get("kelembapan_tanah"),
        "gas_excess": values.get("gas_excess"),
        "risk_score": result.risk_score,
        "status": result.status,
        "formula_version": FORMULA_VERSION if result.risk_score is not None else None,
    }


def risk_summary(kind: str, level: str, score: int, row: dict[str, Any]) -> str:
    """Kalimat satu baris untuk kolom events.message (dibaca dasbor)."""
    if kind == "RISK_RECOVERED":
        return f"Risiko kembali normal: skor {score}/100"
    parts = [f"suhu {row['suhu']:g} °C", f"kelembapan {row['kelembapan']:g} %", f"gas {row['gas']} ADC"]
    if row.get("kelembapan_tanah") is not None:
        parts.append(f"tanah {row['kelembapan_tanah']:g} %")
    return f"Risiko {LEVEL_TEXT.get(level, level)} {score}/100 — " + ", ".join(parts)


class BackendApp:
    def __init__(self, cfg: Config, logger: logging.Logger) -> None:
        self.cfg = cfg
        self.logger = logger
        self.supabase = SupabaseRest(cfg.supabase_url, cfg.supabase_secret_key, logger)
        self.worker = StorageWorker(self.supabase, logger)
        self.notifier = TelegramNotifier(cfg.telegram_bot_token, cfg.telegram_chat_id, logger)
        self.tracker = RiskAlertTracker(
            high=cfg.alert_risk_high,
            critical=cfg.alert_risk_critical,
            cooldown_seconds=cfg.alert_cooldown_seconds,
        )
        self.client = self._make_client()
        self._last_valid_mono: float | None = None
        self._last_valid_iso: str | None = None
        self._online: bool | None = None
        self._last_status_upsert: float = 0.0
        self._stop = threading.Event()
        self._retention_thread = threading.Thread(target=self._retention_loop, name="retention", daemon=True)

    def _make_client(self) -> mqtt.Client:
        client_id = f"ak-backend-{random.randrange(0x100000, 0x1000000):06x}"
        if hasattr(mqtt, "CallbackAPIVersion"):
            client = mqtt.Client(
                callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                client_id=client_id,
                protocol=mqtt.MQTTv311,
            )
        else:  # paho-mqtt 1.x
            client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311)
        client.on_connect = self.on_connect
        client.on_disconnect = self.on_disconnect
        client.on_message = self.on_message
        client.reconnect_delay_set(min_delay=2, max_delay=60)
        if self.cfg.mqtt_username:
            client.username_pw_set(self.cfg.mqtt_username, self.cfg.mqtt_password or None)
        if self.cfg.mqtt_tls:
            client.tls_set()
        return client

    @staticmethod
    def _reason_code(args: tuple[Any, ...], index: int) -> Any:
        if len(args) > index:
            return args[index]
        return None

    @property
    def status_topic(self) -> str:
        return f"{self.cfg.topic_prefix.rstrip('/')}/{self.cfg.node_id}/status"

    def on_connect(self, client: mqtt.Client, userdata: Any, *args: Any) -> None:
        reason = self._reason_code(args, 1) if len(args) >= 2 else (args[0] if args else None)
        code = getattr(reason, "value", reason)
        if code == 0:
            client.subscribe([(self.cfg.sensor_topic, 0), (self.status_topic, 1)])
            self.logger.info("MQTT terhubung; subscribe %s dan %s", self.cfg.sensor_topic, self.status_topic)
        else:
            self.logger.warning("MQTT gagal terhubung (rc=%s); akan mencoba ulang.", code)

    def on_disconnect(self, client: mqtt.Client, userdata: Any, *args: Any) -> None:
        reason = self._reason_code(args, 1) if len(args) >= 2 else (args[0] if args else None)
        code = getattr(reason, "value", reason)
        if not self._stop.is_set():
            self.logger.warning("MQTT terputus (rc=%s); reconnect otomatis.", code)

    def on_message(self, client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
        if message.topic == self.status_topic:
            status_text = message.payload.decode("utf-8", errors="ignore").strip().lower()
            if status_text == "offline":
                if self._online is not False:
                    silence = time.monotonic() - (self._last_valid_mono or time.monotonic())
                    self._mark_offline(silence)
                    self.logger.info("Status LWT diterima: node %s offline.", self.cfg.node_id)
            elif status_text == "online":
                if self._online is not True:
                    self._mark_online()
                    self.logger.info("Status diterima: node %s online.", self.cfg.node_id)
            return

        result = validate_message(message.topic, message.payload, self.cfg.topic_prefix, self.cfg.node_id)
        if not result.ok:
            self.logger.warning("Pesan diabaikan (%s): %s", message.topic, result.error)
            return

        received_at = utc_now_iso()
        now_mono = time.monotonic()
        self._last_valid_mono = now_mono
        self._last_valid_iso = received_at

        if self._online is None:
            self._online = True
            self._upsert_status(force=True)
            self.logger.info("Node %s terlihat online (data pertama sejak backend jalan).", self.cfg.node_id)
        elif self._online is False:
            self._mark_online()
        else:
            self._upsert_status(force=False)

        row = reading_row(result, self.cfg.node_id, received_at)
        self.worker.submit_reading(row)

        for warning in result.warnings:
            self.logger.info("Peringatan payload (%s): %s", message.topic, warning)

        self.logger.info(
            "Data valid: suhu=%s kelembapan=%s gas=%s riskScore=%s",
            row["suhu"],
            row["kelembapan"],
            row["gas"],
            row["risk_score"],
        )

        if result.risk_score is None:
            self.logger.info("riskScore tidak dikirim node; notifikasi risiko dilewati.")
            return

        for alert in self.tracker.process(result.risk_score, now=now_mono):
            self._handle_risk_alert(alert.kind, alert.level, alert.risk_score, row)

    def _handle_risk_alert(self, kind: str, level: str, score: int, row: dict[str, Any]) -> None:
        summary = risk_summary(kind, level, score, row)
        if kind == "RISK_RECOVERED":
            message = (
                f"AntiKobongan: kondisi membaik\n"
                f"Node: {self.cfg.node_id}\nSkor: {score}/100\nWaktu: {wib_now_text()}"
            )
        else:
            message = (
                f"AntiKobongan: {kind}\n"
                f"Node: {self.cfg.node_id}\n"
                f"Skor: {score}/100 ({LEVEL_TEXT.get(level, level)})\n"
                f"Suhu: {row['suhu']} C\n"
                f"Kelembapan: {row['kelembapan']} %\n"
                f"Gas: {row['gas']} ADC\n"
                f"Waktu: {wib_now_text()}"
            )
        self.logger.warning("Event %s (skor %s)", kind, score)
        self.worker.submit_event(
            {
                "node_id": self.cfg.node_id,
                "kind": kind,
                "message": summary,
                "meta": {
                    "risk_score": score,
                    "level": level,
                    "suhu": row["suhu"],
                    "kelembapan": row["kelembapan"],
                    "gas": row["gas"],
                    "gas_excess": row.get("gas_excess"),
                    "kelembapan_tanah": row.get("kelembapan_tanah"),
                },
            }
        )
        self.notifier.send(message)

    def _upsert_status(self, force: bool) -> None:
        if self._online is None:
            return
        now = time.monotonic()
        if not force and now - self._last_status_upsert < 30:
            return
        timestamp = utc_now_iso()
        last_seen = self._last_valid_iso or timestamp
        self.worker.submit_node_status(
            {
                "node_id": self.cfg.node_id,
                "online": self._online,
                "last_seen": last_seen,
                "updated_at": timestamp,
            }
        )
        self._last_status_upsert = now

    def _mark_online(self) -> None:
        self._online = True
        self._upsert_status(force=True)
        message = f"AntiKobongan: node {self.cfg.node_id} ONLINE kembali.\nWaktu: {wib_now_text()}"
        self.logger.info("Node %s online kembali.", self.cfg.node_id)
        self.worker.submit_event(
            {
                "node_id": self.cfg.node_id,
                "kind": "NODE_ONLINE",
                "message": f"Node {self.cfg.node_id} kembali mengirim data",
                "meta": {"last_seen": self._last_valid_iso or utc_now_iso()},
            }
        )
        self.notifier.send(message)

    def _mark_offline(self, age_seconds: float) -> None:
        self._online = False
        self._upsert_status(force=True)
        message = (
            f"AntiKobongan: node {self.cfg.node_id} OFFLINE.\n"
            f"Tidak ada data valid selama {age_seconds:.0f} detik.\n"
            f"Waktu: {wib_now_text()}"
        )
        self.logger.warning("Node %s offline (%.0f detik tanpa data).", self.cfg.node_id, age_seconds)
        self.worker.submit_event(
            {
                "node_id": self.cfg.node_id,
                "kind": "NODE_OFFLINE",
                "message": f"Node {self.cfg.node_id} berhenti mengirim data ({age_seconds:.0f} detik)",
                "meta": {"silent_seconds": round(age_seconds, 1)},
            }
        )
        self.notifier.send(message)

    def watchdog(self) -> None:
        now = time.monotonic()
        if not hasattr(self, "_last_heartbeat_at") or (now - self._last_heartbeat_at) >= 30:
            self.worker.submit_heartbeat("active", self.cfg.telegram_configured)
            self._last_heartbeat_at = now

        if self._last_valid_mono is None or self._online is not True:
            return
        age = now - self._last_valid_mono
        if age > self.cfg.stale_seconds:
            self._mark_offline(age)

    def _retention_once(self) -> None:
        if self.cfg.retention_days <= 0:
            self.logger.info("Retensi dilewati (RETENTION_DAYS=%s).", self.cfg.retention_days)
            return
        cutoff = (datetime.now(timezone.utc) - timedelta(days=self.cfg.retention_days)).isoformat()
        try:
            count = self.supabase.delete_readings_before(cutoff)
        except Exception as exc:
            self.logger.warning("Retensi gagal: %s", type(exc).__name__)
            return
        self.logger.info(
            "Retensi: %s baris readings lebih tua dari %s hari dihapus.",
            "?" if count is None else count,
            self.cfg.retention_days,
        )

    def _retention_loop(self) -> None:
        self._retention_once()
        while not self._stop.wait(24 * 60 * 60):
            self._retention_once()

    def run(self) -> int:
        if not self.cfg.supabase_configured:
            self.logger.error(
                "SUPABASE_URL dan SUPABASE_SECRET_KEY belum diisi di backend/.env. "
                "Backend berhenti (tidak mencetak nilai rahasia)."
            )
            return 2
        if not self.cfg.telegram_configured:
            self.logger.info("Telegram belum diisi: backend tetap menyimpan data tanpa notifikasi.")

        self.logger.info(
            "Mulai: MQTT %s:%s%s | topic %s | retensi %s hari",
            self.cfg.mqtt_host,
            self.cfg.mqtt_port,
            " (TLS)" if self.cfg.mqtt_tls else "",
            self.cfg.sensor_topic,
            self.cfg.retention_days,
        )
        self.worker.start()
        self._retention_thread.start()
        self.client.connect_async(self.cfg.mqtt_host, self.cfg.mqtt_port, keepalive=60)
        self.client.loop_start()
        try:
            while not self._stop.wait(5):
                self.watchdog()
        except KeyboardInterrupt:
            self.logger.info("Ctrl+C diterima; menghentikan backend...")
        finally:
            self._stop.set()
            try:
                self.client.disconnect()
            except Exception:
                pass
            self.client.loop_stop()
            self.worker.stop(flush_timeout=10)
            self.logger.info("Backend berhenti.")
        return 0


def run_test_telegram(cfg: Config, logger: logging.Logger) -> int:
    if not cfg.telegram_configured:
        print("Telegram belum dikonfigurasi: isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di backend/.env.")
        return 2
    notifier = TelegramNotifier(cfg.telegram_bot_token, cfg.telegram_chat_id, logger)
    ok = notifier.send(f"AntiKobongan: pesan uji Telegram.\nWaktu: {wib_now_text()}")
    print("Pesan uji Telegram terkirim." if ok else "Pesan uji Telegram GAGAL (lihat log).")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Backend AntiKobongan (MQTT -> Supabase + Telegram).")
    parser.add_argument("--test-telegram", action="store_true", help="kirim satu pesan uji Telegram lalu keluar")
    args = parser.parse_args(argv)

    logger = setup_logging()
    try:
        cfg = load_config()
    except ConfigError as exc:
        logger.error("Konfigurasi tidak valid: %s", exc)
        return 2

    if args.test_telegram:
        return run_test_telegram(cfg, logger)
    return BackendApp(cfg, logger).run()


if __name__ == "__main__":
    raise SystemExit(main())
