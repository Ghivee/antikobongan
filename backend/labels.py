"""Label kelas risiko sesuai proposal (dipakai backend dan bot Telegram)."""

from __future__ import annotations

LEVEL_TEXT = {
    "NORMAL": "Normal",
    "SEDANG": "Siaga Cuaca Kering",
    "TINGGI": "Waspada Bara dan Asap",
    "KRITIS": "Kebakaran Aktif",
}
# Level lama dari firmware/alert tetap dipetakan agar kompatibel.
ALERT_LEVEL = {"NORMAL": "NORMAL", "HIGH": "TINGGI", "CRITICAL": "KRITIS"}
LEVEL_ACTION = {
    "SEDANG": "Tingkatkan pemantauan lokasi.",
    "TINGGI": "Pantau lokasi secara intensif dan siapkan tim tanggap.",
    "KRITIS": "Kirim tim tanggap ke lokasi dan siapkan protokol evakuasi.",
}


def level_text(level: str) -> str:
    return LEVEL_TEXT.get(ALERT_LEVEL.get(level, level), level)
