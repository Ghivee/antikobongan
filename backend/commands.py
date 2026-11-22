"""Perintah Telegram AntiKobongan.

Bot membaca pesan lewat long polling (getUpdates), lalu membalas teks polos
(tanpa Markdown/HTML) berisi data terbaru dari Supabase. Bot bersifat publik:
semua chat boleh bertanya. Bila perlu dibatasi, setel
TELEGRAM_ALLOW_UNKNOWN=0 agar hanya chat id di TELEGRAM_CHAT_ID yang dilayani.

Perintah yang tersedia juga dipasang sebagai menu bot (setMyCommands) agar
muncul di tombol menu Telegram.
"""

from __future__ import annotations

import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import requests

try:
    from .labels import LEVEL_ACTION, level_text
except ImportError:
    from labels import LEVEL_ACTION, level_text

WIB = timezone(timedelta(hours=7))
MONTHS = ("Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des")

METRICS: dict[str, dict[str, Any]] = {
    "suhu": {"label": "Suhu udara", "unit": "°C", "dec": 1, "field": "suhu"},
    "rh": {"label": "Kelembapan udara", "unit": "%", "dec": 1, "field": "kelembapan"},
    "gas": {"label": "Gas dan asap", "unit": "ADC", "dec": 0, "field": "gas"},
    "tanah": {"label": "Kelembapan tanah", "unit": "%", "dec": 0, "field": "kelembapan_tanah"},
    "tekanan": {"label": "Tekanan udara", "unit": "hPa", "dec": 2, "field": "tekanan"},
    "risiko": {"label": "Skor risiko", "unit": "", "dec": 0, "field": "risk_score"},
}

ALIASES = {
    "status": "status", "kondisi": "status", "sekarang": "status",
    "risiko": "risiko", "risk": "risiko", "bahaya": "risiko",
    "suhu": "suhu", "temperature": "suhu",
    "kelembapan": "rh", "kelembaban": "rh", "lembap": "rh", "rh": "rh", "humidity": "rh",
    "gas": "gas", "asap": "gas",
    "tanah": "tanah", "soil": "tanah",
    "tekanan": "tekanan", "pressure": "tekanan",
    "tren": "tren", "ringkasan": "tren", "grafik": "tren",
    "harian": "harian", "24jam": "harian",
    "riwayat": "riwayat", "histori": "riwayat", "terakhir": "riwayat",
    "node": "node", "alat": "node", "perangkat": "node",
    "waktu": "waktu", "jam": "waktu",
    "id": "id", "chatid": "id",
    "bantuan": "bantuan", "help": "bantuan", "start": "bantuan",
    "mulai": "bantuan", "perintah": "bantuan",
}

# Daftar menu bot (dipasang lewat setMyCommands).
BOT_COMMANDS: list[tuple[str, str]] = [
    ("status", "Ringkasan kondisi terkini"),
    ("risiko", "Indeks risiko kebakaran"),
    ("suhu", "Suhu udara terakhir"),
    ("kelembapan", "Kelembapan udara terakhir"),
    ("gas", "Kadar gas dan asap terakhir"),
    ("tanah", "Kelembapan tanah terakhir"),
    ("tekanan", "Tekanan udara terakhir"),
    ("tren", "Ringkasan 1 jam terakhir"),
    ("harian", "Ringkasan 24 jam terakhir"),
    ("riwayat", "5 pembacaan terakhir"),
    ("node", "Status node dan koneksi"),
    ("waktu", "Waktu server dan umur data"),
    ("id", "Chat id untuk menambah grup"),
    ("bantuan", "Daftar perintah"),
]

HELP_TEXT = "\n".join(
    [
        "Perintah AntiKobongan",
        "Kirim salah satu perintah berikut:",
        "/status : ringkasan kondisi terkini",
        "/risiko : indeks risiko kebakaran",
        "/suhu : suhu udara terakhir",
        "/kelembapan : kelembapan udara terakhir",
        "/gas : kadar gas dan asap terakhir",
        "/tanah : kelembapan tanah terakhir",
        "/tekanan : tekanan udara terakhir",
        "/tren : ringkasan 1 jam terakhir",
        "/harian : ringkasan 24 jam terakhir",
        "/riwayat : 5 pembacaan terakhir",
        "/node : status node dan koneksi",
        "/waktu : waktu server dan umur data",
        "/id : chat id untuk menambah grup",
        "/bantuan : daftar perintah ini",
        "Anda juga bisa bertanya dengan kalimat biasa, misalnya: berapa suhu sekarang",
        "Bot ini terbuka untuk semua orang. Di grup, awali dengan / atau sebut nama bot.",
    ]
)
UNKNOWN_COMMAND_TEXT = "Perintah tidak dikenal.\nKirim /bantuan untuk melihat daftar perintah."
UNKNOWN_TEXT = "Saya belum mengerti pertanyaan itu.\nKirim /bantuan untuk melihat daftar perintah.\nContoh: /status"
NO_DATA_TEXT = (
    "Belum ada data sensor yang tersimpan.\n"
    "Pastikan node sudah mengirim ke broker dan pencatat sedang berjalan."
)


# ── Utilitas format ────────────────────────────────────────────────────────
def parse_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def fmt_wib(moment: datetime) -> str:
    local = moment.astimezone(WIB)
    return f"{local.day} {MONTHS[local.month - 1]} {local.year} {local:%H:%M} WIB"


def fmt_clock(moment: datetime) -> str:
    local = moment.astimezone(WIB)
    return f"{local.day} {MONTHS[local.month - 1]} {local.year} {local:%H:%M:%S} WIB"


def fmt_age(seconds: float | None) -> str:
    if seconds is None:
        return "tidak diketahui"
    total = max(0, int(seconds))
    if total < 60:
        return "baru saja"
    if total < 3600:
        return f"{total // 60} menit lalu"
    if total < 86400:
        return f"{total // 3600} jam lalu"
    return f"{total // 86400} hari lalu"


def fmt_num(value: Any, decimals: int = 0) -> str:
    if value is None:
        return "—"
    return f"{float(value):.{decimals}f}".replace(".", ",")


def with_unit(text: str, unit: str) -> str:
    return f"{text} {unit}".strip()


def stats(rows: list[dict[str, Any]], field: str) -> dict[str, float] | None:
    values = [row[field] for row in rows if row.get(field) is not None]
    if not values:
        return None
    return {
        "min": min(values),
        "max": max(values),
        "avg": sum(values) / len(values),
        "n": len(values),
    }


def fmt_stats(block: dict[str, float], unit: str, decimals: int) -> str:
    low = with_unit(fmt_num(block["min"], decimals), unit)
    high = with_unit(fmt_num(block["max"], decimals), unit)
    average = with_unit(fmt_num(block["avg"], decimals), unit)
    return f"{low}–{high}, rata-rata {average}"


# ── Deteksi perintah / pertanyaan ─────────────────────────────────────────
def parse_command(text: str) -> str | None:
    """Kembalikan nama perintah dari teks berawalan '/', atau None."""
    raw = (text or "").strip()
    if not raw.startswith("/"):
        return None
    token = raw[1:].split()[0].split("@")[0].lower()
    return ALIASES.get(token, "unknown")


def detect_intent(text: str) -> str | None:
    """Perintah '/', kalimat biasa, atau None bila tidak dikenali."""
    command = parse_command(text)
    if command is not None:
        return command
    raw = (text or "").lower()
    if not raw.strip():
        return None
    # Di grup, pesan bebas biasanya menyebut bot: "@antikobonganbot berapa suhu".
    raw = re.sub(r"@[a-z0-9_]+", " ", raw)
    # Urutan penting: "kelembapan tanah" harus terbaca sebagai tanah.
    if "tanah" in raw:
        return "tanah"
    if "kelembapan" in raw or "kelembaban" in raw or "lembap" in raw or re.search(r"\brh\b", raw):
        return "rh"
    if "suhu" in raw or "temperature" in raw:
        return "suhu"
    if "gas" in raw or "asap" in raw:
        return "gas"
    if "tekanan" in raw or "pressure" in raw:
        return "tekanan"
    if "risiko" in raw or "bahaya" in raw or "kebakaran" in raw:
        return "risiko"
    if "harian" in raw or "24 jam" in raw:
        return "harian"
    if "riwayat" in raw or "histori" in raw or "terakhir" in raw:
        return "riwayat"
    if "tren" in raw or "grafik" in raw:
        return "tren"
    if "status" in raw or "kondisi" in raw or "gimana" in raw or "bagaimana" in raw or "sekarang" in raw or "aman" in raw:
        return "status"
    if "node" in raw or "alat" in raw or "perangkat" in raw:
        return "node"
    if "bantuan" in raw or "help" in raw or "perintah" in raw:
        return "bantuan"
    return None


# ── Akses data ────────────────────────────────────────────────────────────
class DataService:
    """Ambil data terbaru dari Supabase dengan cache singkat."""

    def __init__(self, supabase: Any, node_id: str, stale_seconds: int, logger: logging.Logger | None = None, ttl: float = 15.0) -> None:
        self._supabase = supabase
        self._node_id = node_id
        self._stale_seconds = stale_seconds
        self._logger = logger or logging.getLogger("antikobongan")
        self._ttl = ttl
        self._rows_ttl = max(ttl, 30.0)
        self._latest_cache: tuple[float, dict[str, Any] | None] | None = None
        self._status_cache: tuple[float, dict[str, Any] | None] | None = None
        self._rows_cache: dict[int, tuple[float, list[dict[str, Any]]]] = {}
        self._recent_cache: dict[int, tuple[float, list[dict[str, Any]]]] = {}

    def _cached(self, cache: tuple[float, dict[str, Any] | None] | None) -> tuple[bool, dict[str, Any] | None]:
        if cache is None:
            return False, None
        saved_at, value = cache
        if time.monotonic() - saved_at <= self._ttl:
            return True, value
        return False, None

    def latest(self) -> dict[str, Any] | None:
        hit, value = self._cached(self._latest_cache)
        if hit:
            return value
        try:
            value = self._supabase.get_latest_reading(self._node_id)
        except Exception as exc:
            self._logger.warning("Bot perintah: gagal membaca data terbaru (%s).", type(exc).__name__)
            value = None
        self._latest_cache = (time.monotonic(), value)
        return value

    def node_status(self) -> dict[str, Any] | None:
        hit, value = self._cached(self._status_cache)
        if hit:
            return value
        try:
            value = self._supabase.get_node_status(self._node_id)
        except Exception as exc:
            self._logger.warning("Bot perintah: gagal membaca status node (%s).", type(exc).__name__)
            value = None
        self._status_cache = (time.monotonic(), value)
        return value

    def readings_since(self, seconds: int) -> list[dict[str, Any]]:
        now = time.monotonic()
        saved = self._rows_cache.get(seconds)
        if saved and now - saved[0] <= self._rows_ttl:
            return list(saved[1])
        since = datetime.now(timezone.utc) - timedelta(seconds=seconds)
        try:
            rows = self._supabase.get_readings_since(self._node_id, since.isoformat())
        except Exception as exc:
            self._logger.warning("Bot perintah: gagal membaca riwayat (%s).", type(exc).__name__)
            rows = []
        self._rows_cache[seconds] = (now, rows)
        return list(rows)

    def recent(self, limit: int = 5) -> list[dict[str, Any]]:
        now = time.monotonic()
        saved = self._recent_cache.get(limit)
        if saved and now - saved[0] <= self._ttl:
            return list(saved[1])
        try:
            rows = self._supabase.get_recent_readings(self._node_id, limit)
        except Exception as exc:
            self._logger.warning("Bot perintah: gagal membaca pembacaan terakhir (%s).", type(exc).__name__)
            rows = []
        result = list(reversed(rows))
        self._recent_cache[limit] = (now, result)
        return list(result)


# ── Penyusun balasan (murni, mudah dites) ─────────────────────────────────
class CommandHandler:
    def __init__(
        self,
        data: Any,
        node_id: str,
        sensor_topic: str,
        stale_seconds: int,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.data = data
        self.node_id = node_id
        self.sensor_topic = sensor_topic
        self.stale_seconds = stale_seconds
        self._now = now or (lambda: datetime.now(timezone.utc))

    def _age(self, row: dict[str, Any] | None) -> float | None:
        if not row:
            return None
        moment = parse_time(row.get("received_at") or row.get("sensor_ts"))
        if moment is None:
            return None
        return max(0.0, (self._now() - moment).total_seconds())

    def _when(self, row: dict[str, Any] | None) -> str:
        if not row:
            return "belum ada data"
        moment = parse_time(row.get("received_at") or row.get("sensor_ts"))
        if moment is None:
            return "waktu tidak diketahui"
        return f"{fmt_wib(moment)} ({fmt_age(self._age(row))})"

    def _stale_note(self, row: dict[str, Any] | None) -> str | None:
        age = self._age(row)
        if age is not None and age > self.stale_seconds:
            return f"Perhatian: data sudah basi ({fmt_age(age)}). Nilai di atas bukan kondisi sekarang."
        return None

    def _node_line(self, latest: dict[str, Any] | None) -> str:
        status = self.data.node_status() or {}
        online = status.get("online")
        if online is True:
            state = "online"
            if (self._age(latest) or 0) > self.stale_seconds:
                state = "online, tetapi data basi"
        elif online is False:
            state = "offline"
        else:
            state = "tidak diketahui"
        return f"Node: {self.node_id} {state}"

    def reply(self, text: str, chat: dict[str, Any] | None = None) -> str:
        intent = detect_intent(text)
        if intent is None:
            return UNKNOWN_TEXT
        if intent == "unknown":
            return UNKNOWN_COMMAND_TEXT
        if intent == "bantuan":
            return HELP_TEXT
        if intent == "id":
            return self._chat(chat or {})
        if intent == "waktu":
            return self._time()
        if intent == "node":
            return self._node()
        if intent in METRICS:
            return self._metric(intent)
        if intent == "status":
            return self._status()
        if intent == "tren":
            return self._trend(3600)
        if intent == "harian":
            return self._trend(24 * 3600)
        if intent == "riwayat":
            return self._recent()
        return UNKNOWN_TEXT

    def _status(self) -> str:
        latest = self.data.latest()
        if not latest:
            return NO_DATA_TEXT
        score = latest.get("risk_score")
        level = latest.get("status")
        lines = ["AntiKobongan", f"Status: {level_text(level) if level else 'tidak diketahui'}"]
        lines.append(f"Skor risiko: {fmt_num(score)} dari 100" if score is not None else "Skor risiko: belum dikirim node")
        lines.append(f"Suhu: {with_unit(fmt_num(latest.get('suhu'), 1), '°C')}")
        lines.append(f"Kelembapan udara: {with_unit(fmt_num(latest.get('kelembapan'), 1), '%')}")
        lines.append(f"Gas dan asap: {with_unit(fmt_num(latest.get('gas')), 'ADC')}")
        if latest.get("kelembapan_tanah") is not None:
            lines.append(f"Kelembapan tanah: {with_unit(fmt_num(latest.get('kelembapan_tanah')), '%')}")
        if latest.get("tekanan") is not None:
            lines.append(f"Tekanan udara: {with_unit(fmt_num(latest.get('tekanan'), 2), 'hPa')}")
        lines.append(f"Waktu data: {self._when(latest)}")
        lines.append(self._node_line(latest))
        action = LEVEL_ACTION.get(level or "")
        if action:
            lines.append(f"Saran: {action}")
        note = self._stale_note(latest)
        if note:
            lines.append(note)
        return "\n".join(lines)

    def _metric(self, key: str) -> str:
        meta = METRICS[key]
        latest = self.data.latest()
        if not latest:
            return NO_DATA_TEXT
        value = latest.get(meta["field"])
        lines = [meta["label"]]
        if value is None:
            lines.append("Nilai belum tersedia (sensor tidak mengirim bagian ini).")
        else:
            lines.append(f"Nilai: {with_unit(fmt_num(value, meta['dec']), meta['unit'])}")
        lines.append(f"Waktu: {self._when(latest)}")
        block = stats(self.data.readings_since(3600), meta["field"])
        if block:
            lines.append(f"Tren 1 jam: {fmt_stats(block, meta['unit'], meta['dec'])}")
        else:
            lines.append("Tren 1 jam: belum ada data")
        note = self._stale_note(latest)
        if note:
            lines.append(note)
        return "\n".join(lines)

    def _trend(self, seconds: int) -> str:
        label = "1 jam" if seconds <= 3600 else "24 jam"
        rows = self.data.readings_since(seconds)
        if not rows:
            return f"Belum ada pembacaan dalam {label} terakhir."
        lines = [f"Ringkasan {label} terakhir", f"Jumlah pembacaan: {len(rows)}"]
        for key, meta in METRICS.items():
            block = stats(rows, meta["field"])
            if block:
                lines.append(f"{meta['label']}: {fmt_stats(block, meta['unit'], meta['dec'])}")
        return "\n".join(lines)

    def _recent(self) -> str:
        rows = self.data.recent(5)
        if not rows:
            return "Belum ada pembacaan tersimpan."
        lines = [f"{len(rows)} pembacaan terakhir"]
        for index, row in enumerate(rows, start=1):
            moment = parse_time(row.get("received_at") or row.get("sensor_ts"))
            stamp = f"{moment.astimezone(WIB):%d %b %H:%M} WIB" if moment else "waktu tidak diketahui"
            parts = [
                with_unit(fmt_num(row.get("suhu"), 1), "°C"),
                with_unit(fmt_num(row.get("kelembapan"), 1), "%"),
                with_unit(fmt_num(row.get("gas")), "ADC"),
                f"skor {fmt_num(row.get('risk_score'))}",
            ]
            lines.append(f"{index}. {stamp} · " + " · ".join(parts))
        return "\n".join(lines)

    def _node(self) -> str:
        latest = self.data.latest()
        status = self.data.node_status() or {}
        lines = [f"Node {self.node_id}", self._node_line(latest)]
        lines.append(f"Data terakhir: {self._when(latest)}")
        if status.get("last_seen"):
            moment = parse_time(status.get("last_seen"))
            if moment:
                lines.append(f"Terakhir terlihat: {fmt_wib(moment)} ({fmt_age((self._now() - moment).total_seconds())})")
        lines.append(f"Ambang data basi: {self.stale_seconds} detik")
        lines.append(f"Topik sensor: {self.sensor_topic}")
        return "\n".join(lines)

    def _time(self) -> str:
        latest = self.data.latest()
        lines = [f"Waktu server: {fmt_clock(self._now())}"]
        lines.append(f"Data terakhir: {self._when(latest)}")
        note = self._stale_note(latest)
        if note:
            lines.append(note)
        return "\n".join(lines)

    def _chat(self, chat: dict[str, Any]) -> str:
        chat_id = chat.get("id") or "tidak diketahui"
        kind = chat.get("type") or "tidak diketahui"
        return "\n".join(
            [
                f"Chat id: {chat_id}",
                f"Tipe: {kind}",
                "Bot sudah publik: semua grup bisa langsung bertanya.",
                "Chat id ini bisa ditambahkan ke TELEGRAM_CHAT_ID bila ingin menerima notifikasi di sini.",
            ]
        )


# ── Bot long polling ──────────────────────────────────────────────────────
class ConflictError(Exception):
    """getUpdates bentrok dengan instance lain atau webhook aktif."""


class UnauthorizedError(Exception):
    """Token Telegram ditolak."""


def register_bot_commands(token: str, logger: logging.Logger | None = None) -> bool:
    """Pasang menu perintah di Telegram (setMyCommands)."""
    log = logger or logging.getLogger("antikobongan")
    url = f"https://api.telegram.org/bot{token}/setMyCommands"
    payload = {"commands": [{"command": name, "description": desc} for name, desc in BOT_COMMANDS]}
    try:
        response = requests.post(url, json=payload, timeout=8)
    except requests.RequestException as exc:
        if isinstance(exc, (requests.Timeout, requests.ConnectionError)):
            log.info("Menu perintah Telegram belum terpasang (%s); akan dicoba pada start berikutnya.", type(exc).__name__)
        else:
            log.warning("Menu perintah Telegram gagal dipasang (%s).", type(exc).__name__)
        return False
    if response.status_code != 200:
        log.warning("Menu perintah Telegram ditolak (HTTP %s).", response.status_code)
        return False
    log.info("Menu perintah Telegram dipasang (%d perintah).", len(BOT_COMMANDS))
    return True


class TelegramCommandBot:
    """Baca pesan lewat getUpdates lalu balas dengan CommandHandler."""

    def __init__(
        self,
        token: str,
        allowed_chat_ids: list[str],
        handler: CommandHandler,
        logger: logging.Logger | None = None,
        poll_timeout: int = 10,
        allow_unknown: bool = True,
        notifier: Any | None = None,
        min_interval: float = 1.2,
    ) -> None:
        self._token = (token or "").strip()
        self._allowed = {str(item) for item in allowed_chat_ids}
        self._handler = handler
        self._logger = logger or logging.getLogger("antikobongan")
        self._poll_timeout = poll_timeout
        self._allow_unknown = allow_unknown
        self._notifier = notifier
        self._min_interval = max(0.0, min_interval)
        self._last_reply: dict[str, float] = {}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="telegram-commands", daemon=True)

    @property
    def enabled(self) -> bool:
        return bool(self._token)

    def start(self) -> None:
        if not self.enabled:
            return
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=5.0)

    def _base(self) -> str:
        return f"https://api.telegram.org/bot{self._token}"

    def _webhook_active(self) -> bool:
        try:
            response = requests.get(f"{self._base()}/getWebhookInfo", timeout=8)
            data = response.json()
        except (requests.RequestException, ValueError):
            return False
        return bool((data.get("result") or {}).get("url"))

    def _initial_offset(self) -> int:
        try:
            response = requests.get(
                f"{self._base()}/getUpdates",
                params={"offset": -1, "limit": 1, "timeout": 0},
                timeout=10,
            )
            data = response.json()
        except (requests.RequestException, ValueError):
            return 0
        updates = data.get("result") or []
        if updates:
            return int(updates[-1].get("update_id", 0)) + 1
        return 0

    def _get_updates(self, offset: int) -> list[dict[str, Any]]:
        response = requests.get(
            f"{self._base()}/getUpdates",
            params={
                "offset": offset,
                "timeout": self._poll_timeout,
                "allowed_updates": '["message","channel_post"]',
            },
            timeout=self._poll_timeout + 10,
        )
        if response.status_code == 409:
            raise ConflictError("getUpdates bentrok")
        if response.status_code == 401:
            raise UnauthorizedError("token ditolak")
        if response.status_code != 200:
            raise requests.RequestException(f"HTTP {response.status_code}")
        data = response.json()
        if not data.get("ok"):
            raise requests.RequestException("respons Telegram tidak ok")
        return data.get("result") or []

    def reply_for_update(self, update: dict[str, Any]) -> tuple[str, str] | None:
        """Tentukan (chat_id, balasan) tanpa mengirim apa pun."""
        message = update.get("message") or update.get("channel_post") or {}
        sender = message.get("from") or {}
        if sender.get("is_bot"):
            return None
        text = (message.get("text") or message.get("caption") or "").strip()
        chat = message.get("chat") or {}
        chat_id = str(chat.get("id") or "")
        if not text or not chat_id:
            return None
        if not self._allow_unknown and chat_id not in self._allowed:
            return chat_id, "\n".join(
                [
                    "AntiKobongan",
                    "Chat ini belum terdaftar untuk perintah.",
                    f"Chat id: {chat_id}",
                    "Minta pemilik menambahkan id ini ke TELEGRAM_CHAT_ID.",
                ]
            )
        reply = self._handler.reply(text, {"id": chat_id, "type": chat.get("type", "")})
        return chat_id, reply

    def _dispatch(self, update: dict[str, Any]) -> None:
        pair = self.reply_for_update(update)
        if not pair:
            return
        chat_id, text = pair
        now = time.monotonic()
        last = self._last_reply.get(chat_id)
        if last is not None and now - last < self._min_interval:
            self._logger.info("Balasan ke chat %s dilewati (permintaan terlalu cepat).", chat_id)
            return
        self._last_reply[chat_id] = now
        if len(self._last_reply) > 500:
            cutoff = now - 60.0
            self._last_reply = {key: value for key, value in self._last_reply.items() if value >= cutoff}
        if self._notifier is not None:
            sent = self._notifier.send_to(chat_id, text)
        else:
            sent = False
        if sent:
            self._logger.info("Balasan perintah terkirim ke chat %s.", chat_id)
        else:
            self._logger.warning("Balasan perintah gagal dikirim ke chat %s.", chat_id)

    def _run(self) -> None:
        if self._webhook_active():
            self._logger.warning(
                "Bot perintah dimatikan: webhook bot masih aktif. Hapus webhook agar getUpdates bisa dipakai."
            )
            return
        register_bot_commands(self._token, self._logger)
        offset = self._initial_offset()
        self._logger.info("Bot perintah Telegram aktif; kirim /bantuan di chat.")
        backoff = 1
        while not self._stop.is_set():
            try:
                updates = self._get_updates(offset)
            except ConflictError:
                self._logger.warning(
                    "Bot perintah: getUpdates bentrok (409). Pastikan hanya satu backend berjalan."
                )
                self._stop.wait(30)
                continue
            except UnauthorizedError:
                self._logger.error("Bot perintah dimatikan: token Telegram ditolak (401).")
                return
            except requests.RequestException as exc:
                if isinstance(exc, (requests.Timeout, requests.ConnectionError)):
                    self._logger.info(
                        "Bot perintah: koneksi Telegram lambat (%s); mencoba lagi.", type(exc).__name__
                    )
                else:
                    self._logger.warning(
                        "Bot perintah: gagal menghubungi Telegram (%s); coba lagi.", type(exc).__name__
                    )
                self._stop.wait(min(backoff, 60))
                backoff = min(backoff * 2, 60)
                continue
            backoff = 1
            for update in updates:
                if self._stop.is_set():
                    break
                update_id = update.get("update_id")
                if isinstance(update_id, int):
                    offset = max(offset, update_id + 1)
                self._dispatch(update)
