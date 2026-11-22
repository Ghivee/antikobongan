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
import socket
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from typing import Any

import paho.mqtt.client as mqtt

try:  # dukung `python -m backend.main` maupun `python backend\main.py`
    from .alerts import RiskAlertTracker
    from .commands import (
        BOT_COMMANDS,
        CommandHandler,
        DataService,
        TelegramCommandBot,
        register_bot_commands,
    )
    from .config import BASE_DIR, Config, ConfigError, load_config
    from .labels import ALERT_LEVEL, LEVEL_ACTION, level_text
    from .notifier import TelegramNotifier, parse_chat_ids
    from .store import StorageWorker, SupabaseRest
    from .validator import ValidationResult, validate_message, validate_status
except ImportError:
    from alerts import RiskAlertTracker
    from commands import (
        BOT_COMMANDS,
        CommandHandler,
        DataService,
        TelegramCommandBot,
        register_bot_commands,
    )
    from config import BASE_DIR, Config, ConfigError, load_config
    from labels import ALERT_LEVEL, LEVEL_ACTION, level_text
    from notifier import TelegramNotifier, parse_chat_ids
    from store import StorageWorker, SupabaseRest
    from validator import ValidationResult, validate_message, validate_status

WIB = timezone(timedelta(hours=7))
LOGGER_NAME = "antikobongan"
# Versi rumus risiko firmware (lihat calcRiskScore di antikobongan-2.ino).
FORMULA_VERSION = 1


def num(value: Any, decimals: int = 0) -> str:
    """Angka gaya Indonesia: koma desimal, tanpa simbol tambahan."""
    if value is None:
        return ""
    text = f"{float(value):.{decimals}f}"
    return text.replace(".", ",")


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
        return f"Kembali Normal. Skor {score} dari 100."
    parts = [
        f"suhu {num(row['suhu'], 1)} °C",
        f"kelembapan udara {num(row['kelembapan'], 1)} %",
        f"gas dan asap {num(row['gas'])} ADC",
    ]
    if row.get("kelembapan_tanah") is not None:
        parts.append(f"tanah {num(row['kelembapan_tanah'])} %")
    if row.get("tekanan") is not None:
        parts.append(f"tekanan {num(row['tekanan'], 2)} hPa")
    return f"Status {level_text(level)}. Skor {score} dari 100. " + ", ".join(parts) + "."


CONTROL_HOST = "127.0.0.1"


def acquire_control_socket(port: int) -> socket.socket | None:
    """Kunci satu-instance: hanya satu backend yang boleh memakai port ini."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((CONTROL_HOST, port))
    except OSError:
        sock.close()
        return None
    sock.listen(5)
    sock.settimeout(1.0)
    return sock


def request_stop(port: int) -> int:
    """Minta backend yang sedang berjalan berhenti dengan rapi."""
    try:
        with socket.create_connection((CONTROL_HOST, port), timeout=3) as conn:
            conn.sendall(b"stop\n")
            conn.settimeout(3)
            try:
                conn.recv(64)
            except OSError:
                pass
    except OSError:
        print("Tidak ada backend AntiKobongan yang sedang berjalan.")
        return 0
    print("Permintaan berhenti dikirim; menunggu backend selesai...")
    for _ in range(60):
        time.sleep(0.5)
        try:
            with socket.create_connection((CONTROL_HOST, port), timeout=1):
                pass
        except OSError:
            print("Backend sudah berhenti.")
            return 0
    print("Backend belum berhenti; hentikan manual dengan Ctrl+C di jendelanya.")
    return 1


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
        self.commands = self._make_commands()
        self._last_valid_mono: float | None = None
        self._last_valid_iso: str | None = None
        self._online: bool | None = None
        self._last_status_upsert: float = 0.0
        self._last_status_notice: tuple[str, float] | None = None
        self._stop = threading.Event()
        self._control: socket.socket | None = None
        self._control_thread: threading.Thread | None = None
        self._retention_thread = threading.Thread(target=self._retention_loop, name="retention", daemon=True)

    def _make_commands(self) -> TelegramCommandBot | None:
        """Bot perintah Telegram (long polling) bila token terisi.

        Bot bersifat publik, jadi tidak wajib ada TELEGRAM_CHAT_ID.
        """
        if not self.cfg.telegram_bot_ready:
            return None
        data = DataService(self.supabase, self.cfg.node_id, self.cfg.stale_seconds, self.logger)
        handler = CommandHandler(data, self.cfg.node_id, self.cfg.sensor_topic, self.cfg.stale_seconds)
        return TelegramCommandBot(
            self.cfg.telegram_bot_token,
            parse_chat_ids(self.cfg.telegram_chat_id),
            handler,
            self.logger,
            allow_unknown=self.cfg.telegram_allow_unknown,
            notifier=self.notifier,
        )

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
            raw_text = message.payload.decode("utf-8", errors="replace").strip()
            status_text = validate_status(message.payload)
            if status_text is None:
                self.logger.warning(
                    "Status diabaikan: nilai %r tidak sah (hanya online/offline).", raw_text[:32]
                )
                return
            if status_text == "offline":
                if self._online is not False:
                    silence = (time.monotonic() - self._last_valid_mono) if self._last_valid_mono else None
                    self._mark_offline(silence)
                    self.logger.info("Status LWT diterima: node %s offline.", self.cfg.node_id)
            elif status_text == "online":
                if self._online is None:
                    # Status retained saat backend baru mulai bukan transisi nyata.
                    self._online = True
                    self._upsert_status(force=True)
                    self.logger.info("Status retained: node %s online (tanpa notifikasi).", self.cfg.node_id)
                elif self._online is not True:
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
        label = level_text(level)
        if kind == "RISK_RECOVERED":
            message = (
                "AntiKobongan\n"
                "Status: Normal\n"
                f"Node: {self.cfg.node_id}\n"
                f"Skor risiko: {score} dari 100\n"
                f"Waktu: {wib_now_text()}\n"
                "Kondisi kembali di bawah ambang Waspada Bara dan Asap."
            )
        else:
            lines = [
                "AntiKobongan",
                f"Status: {label}",
                f"Node: {self.cfg.node_id}",
                f"Skor risiko: {score} dari 100",
                f"Suhu: {num(row['suhu'], 1)} °C",
                f"Kelembapan udara: {num(row['kelembapan'], 1)} %",
                f"Gas dan asap: {num(row['gas'])} ADC",
            ]
            if row.get("kelembapan_tanah") is not None:
                lines.append(f"Kelembapan tanah: {num(row['kelembapan_tanah'])} %")
            if row.get("tekanan") is not None:
                lines.append(f"Tekanan udara: {num(row['tekanan'], 2)} hPa")
            lines.append(f"Waktu: {wib_now_text()}")
            action = LEVEL_ACTION.get(ALERT_LEVEL.get(level, level))
            if action:
                lines.append(f"Tindakan: {action}")
            message = "\n".join(lines)
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
                    "tekanan": row.get("tekanan"),
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

    def _announce_once(self, kind: str) -> bool:
        """Satu notifikasi per transisi; transisi sama dalam cooldown dibuang.

        LWT dan watchdog bisa sama-sama melaporkan offline untuk kejadian yang
        sama; penanda ini mencegah pesan Telegram ganda.
        """
        now = time.monotonic()
        last_kind, last_at = self._last_status_notice or (None, 0.0)
        if last_kind == kind and now - last_at < self.cfg.alert_cooldown_seconds:
            return False
        self._last_status_notice = (kind, now)
        return True

    def _mark_online(self) -> None:
        self._online = True
        self._upsert_status(force=True)
        if not self._announce_once("NODE_ONLINE"):
            self.logger.info("Node %s online (notifikasi ditahan cooldown).", self.cfg.node_id)
            return
        message = (
            "AntiKobongan\n"
            "Status: Node kembali mengirim data\n"
            f"Node: {self.cfg.node_id}\n"
            f"Waktu: {wib_now_text()}"
        )
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

    def _mark_offline(self, age_seconds: float | None = None) -> None:
        self._online = False
        self._upsert_status(force=True)
        if not self._announce_once("NODE_OFFLINE"):
            self.logger.info("Node %s offline (notifikasi ditahan cooldown).", self.cfg.node_id)
            return
        if age_seconds is None:
            reason = "Broker melaporkan node offline (LWT)."
            meta = {"source": "lwt"}
        else:
            reason = f"Tidak ada data valid selama {age_seconds:.0f} detik."
            meta = {"silent_seconds": round(age_seconds, 1)}
        message = (
            "AntiKobongan\n"
            "Status: Node berhenti mengirim data\n"
            f"Node: {self.cfg.node_id}\n"
            f"Alasan: {reason}\n"
            f"Waktu: {wib_now_text()}"
        )
        self.logger.warning("Node %s offline (%s)", self.cfg.node_id, reason)
        self.worker.submit_event(
            {
                "node_id": self.cfg.node_id,
                "kind": "NODE_OFFLINE",
                "message": f"Node {self.cfg.node_id} berhenti mengirim data ({reason.rstrip('.')})",
                "meta": meta,
            }
        )
        self.notifier.send(message)

    def watchdog(self) -> None:
        now = time.monotonic()
        if not hasattr(self, "_last_heartbeat_at") or (now - self._last_heartbeat_at) >= 30:
            self.worker.submit_heartbeat("active", self.cfg.telegram_configured or self.cfg.telegram_bot_ready)
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

    def _control_loop(self) -> None:
        """Terima perintah 'stop' dari skrip peluncur (localhost saja)."""
        assert self._control is not None
        while not self._stop.is_set():
            try:
                conn, _ = self._control.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                conn.settimeout(2.0)
                try:
                    data = conn.recv(64)
                except OSError:
                    data = b""
                if data.strip().lower() == b"stop":
                    self.logger.info("Permintaan berhenti dari peluncur diterima.")
                    self._stop.set()
                    try:
                        conn.sendall(b"stopping\n")
                    except OSError:
                        pass
            finally:
                conn.close()

    def run(self) -> int:
        if not self.cfg.supabase_configured:
            self.logger.error(
                "SUPABASE_URL dan SUPABASE_SECRET_KEY belum diisi di backend/.env. "
                "Backend berhenti (tidak mencetak nilai rahasia)."
            )
            return 2
        self._control = acquire_control_socket(self.cfg.control_port)
        if self._control is None:
            self.logger.error(
                "Backend lain sudah berjalan (port kontrol %s). Hentikan dulu dengan "
                "`backend\\main.py --stop`, lalu jalankan lagi. Ini mencegah bentrok 409 di Telegram.",
                self.cfg.control_port,
            )
            return 3
        self._control_thread = threading.Thread(target=self._control_loop, name="control", daemon=True)
        self._control_thread.start()
        if not self.cfg.telegram_configured:
            if self.cfg.telegram_bot_ready:
                self.logger.info("Telegram notifikasi belum diisi; bot perintah tetap aktif (publik).")
            else:
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
        if self.commands is not None:
            self.commands.start()
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
            if self.commands is not None:
                self.commands.stop()
            self.worker.stop(flush_timeout=10)
            if self._control is not None:
                self._control.close()
            self.logger.info("Backend berhenti.")
        return 0


def run_test_telegram(cfg: Config, logger: logging.Logger) -> int:
    if not cfg.telegram_configured:
        print("Telegram belum dikonfigurasi: isi TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di backend/.env.")
        return 2
    notifier = TelegramNotifier(cfg.telegram_bot_token, cfg.telegram_chat_id, logger)
    ok = notifier.send(
        "AntiKobongan\n"
        "Status: Pesan uji Telegram\n"
        f"Waktu: {wib_now_text()}\n"
        "Jika pesan ini terlihat, notifikasi aktif untuk semua anggota chat.\n"
        "Kirim /bantuan di chat ini untuk melihat perintah."
    )
    print("Pesan uji Telegram terkirim." if ok else "Pesan uji Telegram GAGAL (lihat log).")
    return 0 if ok else 1


def run_test_commands(cfg: Config, logger: logging.Logger) -> int:
    """Cetak contoh balasan perintah memakai data nyata (tanpa mengirim)."""
    if not cfg.supabase_configured:
        print("SUPABASE_URL dan SUPABASE_SECRET_KEY belum diisi di backend/.env.")
        return 2
    supabase = SupabaseRest(cfg.supabase_url, cfg.supabase_secret_key, logger)
    try:
        data = DataService(supabase, cfg.node_id, cfg.stale_seconds, logger)
        handler = CommandHandler(data, cfg.node_id, cfg.sensor_topic, cfg.stale_seconds)
        samples = ["/status", "/risiko", "/suhu", "/tren", "/riwayat", "/node", "/id", "/bantuan", "berapa suhu sekarang"]
        for text in samples:
            print(f"> {text}")
            print(handler.reply(text, {"id": "uji", "type": "private"}))
            print()
    finally:
        supabase.close()
    return 0


def run_setup_telegram(cfg: Config, logger: logging.Logger) -> int:
    """Pasang menu perintah di Telegram (setMyCommands)."""
    if not cfg.telegram_bot_token:
        print("TELEGRAM_BOT_TOKEN belum diisi di backend/.env.")
        return 2
    ok = register_bot_commands(cfg.telegram_bot_token, logger)
    if ok:
        print(f"Menu perintah Telegram dipasang ({len(BOT_COMMANDS)} perintah).")
        return 0
    print("Menu perintah Telegram GAGAL dipasang (lihat log).")
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Backend AntiKobongan (MQTT -> Supabase + Telegram).")
    parser.add_argument("--test-telegram", action="store_true", help="kirim satu pesan uji Telegram lalu keluar")
    parser.add_argument("--test-commands", action="store_true", help="cetak contoh balasan perintah (tanpa mengirim)")
    parser.add_argument("--setup-telegram", action="store_true", help="pasang menu perintah bot di Telegram lalu keluar")
    parser.add_argument("--stop", action="store_true", help="hentikan backend yang sedang berjalan lalu keluar")
    args = parser.parse_args(argv)

    logger = setup_logging()
    try:
        cfg = load_config()
    except ConfigError as exc:
        if args.stop:
            return request_stop(47831)
        logger.error("Konfigurasi tidak valid: %s", exc)
        return 2

    if args.stop:
        return request_stop(cfg.control_port)
    if args.test_telegram:
        return run_test_telegram(cfg, logger)
    if args.test_commands:
        return run_test_commands(cfg, logger)
    if args.setup_telegram:
        return run_setup_telegram(cfg, logger)
    return BackendApp(cfg, logger).run()


if __name__ == "__main__":
    raise SystemExit(main())
