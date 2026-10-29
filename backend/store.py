"""Akses Supabase lewat REST + antrean penulisan non-blocking."""

from __future__ import annotations

import logging
import queue
import threading
import time
from datetime import datetime, timezone
from typing import Any

import requests

_SENTINEL = object()
# Kolom dari sql/002_series.sql. Bila migrasi belum dijalankan, reading tetap
# disimpan tanpa kolom ini (bukan dibuang).
_NEW_READING_COLUMNS = ("gas_excess", "formula_version")


class SupabaseRest:
    def __init__(self, base_url: str, secret_key: str, logger: logging.Logger, timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._logger = logger
        self._headers = {
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
            "Content-Type": "application/json",
        }
        self._session = requests.Session()
        self._legacy_readings = False
        self._legacy_heartbeat = False

    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        headers = dict(self._headers)
        headers.update(kwargs.pop("headers", {}))
        return self._session.request(
            method,
            f"{self.base_url}{path}",
            headers=headers,
            timeout=self.timeout,
            **kwargs,
        )

    @staticmethod
    def _raise_for_status(response: requests.Response, action: str) -> None:
        if response.status_code >= 400:
            raise RuntimeError(f"{action} HTTP {response.status_code}")

    def insert_reading(self, row: dict[str, Any]) -> None:
        """Simpan reading; idempotent bila unique index (node_id, sensor_ts) ada."""
        if self._legacy_readings:
            row = {k: v for k, v in row.items() if k not in _NEW_READING_COLUMNS}
        response = self._post_reading(row)
        if (
            response.status_code == 400
            and not self._legacy_readings
            and any(col in response.text for col in _NEW_READING_COLUMNS)
        ):
            self._legacy_readings = True
            self._logger.warning(
                "Kolom gas_excess/formula_version belum ada; jalankan sql/002_series.sql. "
                "Sementara reading disimpan tanpa kolom tersebut."
            )
            row = {k: v for k, v in row.items() if k not in _NEW_READING_COLUMNS}
            response = self._post_reading(row)
        self._raise_for_status(response, "simpan reading")

    def _post_reading(self, row: dict[str, Any]) -> requests.Response:
        response = self._request(
            "POST",
            "/rest/v1/readings?on_conflict=node_id,sensor_ts",
            json=row,
            headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
        )
        # Skema lama belum punya unique index -> fallback ke insert biasa.
        if response.status_code == 400 and "42P10" in response.text:
            response = self._request(
                "POST",
                "/rest/v1/readings",
                json=row,
                headers={"Prefer": "return=minimal"},
            )
        return response

    def upsert_node_status(self, row: dict[str, Any]) -> None:
        response = self._request(
            "POST",
            "/rest/v1/node_status?on_conflict=node_id",
            json=row,
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
        )
        self._raise_for_status(response, "upsert node_status")

    def insert_event(self, row: dict[str, Any]) -> None:
        response = self._request(
            "POST",
            "/rest/v1/events",
            json=row,
            headers={"Prefer": "return=minimal"},
        )
        self._raise_for_status(response, "simpan event")

    def upsert_backend_heartbeat(self, status: str = "active", telegram: bool | None = None) -> None:
        row: dict[str, Any] = {"id": 1, "status": status, "ts": datetime.now(timezone.utc).isoformat()}
        if telegram is not None and not self._legacy_heartbeat:
            row["telegram"] = telegram
        try:
            response = self._request(
                "POST",
                "/rest/v1/backend_heartbeat?on_conflict=id",
                json=row,
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            )
            if response.status_code == 400 and "telegram" in response.text:
                self._legacy_heartbeat = True
                row.pop("telegram", None)
                self._request(
                    "POST",
                    "/rest/v1/backend_heartbeat?on_conflict=id",
                    json=row,
                    headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                )
        except Exception as exc:
            self._logger.debug("Heartbeat backend gagal disimpan: %s", exc)

    def count_old_readings(self, cutoff_iso: str) -> int | None:
        response = self._request(
            "GET",
            "/rest/v1/readings",
            params={"select": "id", "received_at": f"lt.{cutoff_iso}", "limit": "1"},
            headers={"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"},
        )
        self._raise_for_status(response, "hitung reading lama")
        content_range = response.headers.get("Content-Range", "")
        if "/" in content_range:
            total = content_range.rsplit("/", 1)[1]
            if total.isdigit():
                return int(total)
        return None

    def delete_readings_before(self, cutoff_iso: str) -> int | None:
        try:
            count = self.count_old_readings(cutoff_iso)
        except Exception:
            count = None
        response = self._request(
            "DELETE",
            "/rest/v1/readings",
            params={"received_at": f"lt.{cutoff_iso}"},
            headers={"Prefer": "return=minimal"},
        )
        self._raise_for_status(response, "hapus reading lama")
        return count

    def close(self) -> None:
        self._session.close()


class StorageWorker:
    """Antrean berbatas + pekerja terpisah agar loop MQTT tidak diblokir HTTP."""

    def __init__(self, client: SupabaseRest, logger: logging.Logger, max_queue: int = 1000) -> None:
        self._client = client
        self._logger = logger
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=max_queue)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="storage-worker", daemon=True)
        self._dropped = 0

    def start(self) -> None:
        self._thread.start()

    def submit_reading(self, row: dict[str, Any]) -> None:
        self._submit(("reading", row))

    def submit_event(self, row: dict[str, Any]) -> None:
        self._submit(("event", row))

    def submit_node_status(self, row: dict[str, Any]) -> None:
        self._submit(("node_status", row))

    def submit_heartbeat(self, status: str = "active", telegram: bool | None = None) -> None:
        self._submit(("heartbeat", {"status": status, "telegram": telegram}))

    def _submit(self, job: tuple[str, dict[str, Any]]) -> None:
        try:
            self._queue.put_nowait(job)
            return
        except queue.Full:
            pass
        try:
            self._queue.get_nowait()
            self._queue.task_done()
            dropped = True
        except queue.Empty:
            dropped = False
        try:
            self._queue.put_nowait(job)
        except queue.Full:
            self._logger.warning("Antrean penyimpanan penuh; job baru dibuang.")
            return
        self._dropped += 1
        if dropped:
            self._logger.warning("Antrean penyimpanan penuh; job TERLAMA dibuang (total %d).", self._dropped)

    def _run(self) -> None:
        while True:
            try:
                job = self._queue.get(timeout=0.5)
            except queue.Empty:
                if self._stop.is_set():
                    break
                continue
            if job is _SENTINEL:
                self._queue.task_done()
                break
            try:
                self._dispatch(job)
            finally:
                self._queue.task_done()

    def _dispatch(self, job: tuple[str, dict[str, Any]]) -> None:
        kind, row = job
        for attempt in range(1, 4):
            try:
                if kind == "reading":
                    self._client.insert_reading(row)
                elif kind == "event":
                    self._client.insert_event(row)
                elif kind == "node_status":
                    self._client.upsert_node_status(row)
                elif kind == "heartbeat":
                    self._client.upsert_backend_heartbeat(row.get("status", "active"), row.get("telegram"))
                else:
                    self._logger.warning("Jenis job penyimpanan tidak dikenal: %s", kind)
                return
            except Exception as exc:
                if attempt >= 3:
                    self._logger.error("Gagal menyimpan %s setelah 3 percobaan: %s", kind, type(exc).__name__)
                    return
                delay = min(2 ** attempt, 5)
                self._logger.warning(
                    "Gagal menyimpan %s (percobaan %d/3): %s; ulang dalam %d detik.",
                    kind,
                    attempt,
                    type(exc).__name__,
                    delay,
                )
                time.sleep(delay)

    def stop(self, flush_timeout: float = 10.0) -> None:
        self._stop.set()
        deadline = time.monotonic() + flush_timeout
        while self._queue.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.1)
        try:
            self._queue.put_nowait(_SENTINEL)
        except queue.Full:
            pass
        self._thread.join(timeout=2.0)
        self._client.close()
