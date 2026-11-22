"""Kirim contoh payload AntiKobongan ke broker MQTT (alat uji manual).

Contoh:
    python tools/publish_test.py --dry-run
    python tools/publish_test.py --scenario sensor
    python tools/publish_test.py --scenario no-pressure
    python tools/publish_test.py --scenario offline

Payload sensor memuat BME280: suhu, kelembapan udara, tekanan (hPa), gas
(ADC mentah MQ-2), dan gas_excess. Topik status memakai nilai sah
`online`/`offline` (retained), sama seperti LWT firmware.

Alat ini TIDAK dipakai oleh backend/dasbor. Default broker adalah broker
publik HiveMQ tanpa kredensial; jangan kirim data rahasia. Kredensial broker
(bila perlu) dibaca dari environment `MQTT_USERNAME`/`MQTT_PASSWORD` dan tidak
pernah dicetak.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

DEFAULT_HOST = "broker.hivemq.com"
DEFAULT_PORT = 1883
DEFAULT_PREFIX = "antikobongan/prototipe-gx7q4m"
DEFAULT_NODE = "esp32-01"

SENSOR_KINDS = ("sensor", "no-pressure")
STATUS_KINDS = ("online", "offline")


def build_payload(*, with_pressure: bool) -> dict[str, Any]:
    """Contoh pembacaan yang lolos validator (bukan data sensor nyata)."""
    data: dict[str, Any] = {
        "suhu": 29.4,
        "kelembapan": 65.0,
        "gas": 391,
        "gas_excess": 313,
        "kelembapan_tanah": 38.0,
        "riskScore": 48,
        "status": "SEDANG",
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    if with_pressure:
        data["tekanan"] = 1008.6
    return data


def payload_for(kind: str) -> str:
    if kind == "sensor":
        return json.dumps(build_payload(with_pressure=True))
    if kind == "no-pressure":
        return json.dumps(build_payload(with_pressure=False))
    return kind  # "online" / "offline"


def build_messages(name: str, sensor_topic: str, status_topic: str) -> list[tuple[str, str, str, bool]]:
    kinds = SENSOR_KINDS + STATUS_KINDS if name == "all" else (name,)
    messages = []
    for kind in kinds:
        sensor = kind in SENSOR_KINDS
        topic = sensor_topic if sensor else status_topic
        messages.append((kind, topic, payload_for(kind), not sensor))
    return messages


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Kirim payload uji AntiKobongan ke broker MQTT.")
    parser.add_argument(
        "--scenario",
        choices=("sensor", "no-pressure", "online", "offline", "all"),
        default="all",
        help="jenis pesan yang dikirim (default: all)",
    )
    parser.add_argument("--host", default=os.environ.get("MQTT_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MQTT_PORT", DEFAULT_PORT)))
    parser.add_argument("--tls", action="store_true", help="pakai TLS (biasanya port 8883)")
    parser.add_argument("--prefix", default=os.environ.get("TOPIC_PREFIX", DEFAULT_PREFIX))
    parser.add_argument("--node", default=os.environ.get("NODE_ID", DEFAULT_NODE))
    parser.add_argument("--dry-run", action="store_true", help="tampilkan payload tanpa menghubungi broker")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    prefix = args.prefix.rstrip("/")
    messages = build_messages(
        args.scenario,
        f"{prefix}/{args.node}/sensor",
        f"{prefix}/{args.node}/status",
    )

    if args.dry_run:
        for kind, topic, payload, retain in messages:
            print(f"[{kind}] topic={topic} retain={str(retain).lower()}")
            print(f"  {payload}")
        return 0

    try:
        import paho.mqtt.client as mqtt
    except ImportError:
        print("paho-mqtt belum terpasang: pip install -r backend/requirements.txt", file=sys.stderr)
        return 2

    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    else:  # paho-mqtt 1.x
        client = mqtt.Client()
    username = os.environ.get("MQTT_USERNAME", "")
    if username:
        client.username_pw_set(username, os.environ.get("MQTT_PASSWORD") or None)
    if args.tls:
        client.tls_set()

    try:
        client.connect(args.host, args.port, keepalive=30)
        client.loop_start()
        for kind, topic, payload, retain in messages:
            info = client.publish(topic, payload, qos=1, retain=retain)
            info.wait_for_publish(timeout=10)
            ok = info.is_published()
            print(f"[{kind}] {'OK' if ok else 'GAGAL'} topic={topic} retain={str(retain).lower()}")
        client.loop_stop()
        client.disconnect()
    except Exception as exc:  # jangan cetak kredensial
        print(f"Gagal menghubungi broker: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
