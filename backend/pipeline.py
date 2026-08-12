"""Orchestrate scrapers, merge into states.json, track pipeline status."""

from __future__ import annotations

import asyncio
import json
import logging
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scrapers.electproject_vep import fetch_vep_status
from scrapers.usafacts import fetch_usafacts_national
from scrapers.wpr_registered import fetch_registered

log = logging.getLogger("pipeline")

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "states.json"
STATUS_PATH = ROOT / "data" / "pipeline_status.json"

# Shared mutable status for the API
_status: dict[str, Any] = {
    "running": False,
    "last_run_started": None,
    "last_run_finished": None,
    "last_success": None,
    "last_error": None,
    "sources": {},
    "changes": {},
    "run_count": 0,
}
_lock = asyncio.Lock()
_data_revision = 0


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def get_status() -> dict[str, Any]:
    return deepcopy(_status)


def get_revision() -> int:
    return _data_revision


def load_data() -> dict[str, Any]:
    with DATA_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def save_data(data: dict[str, Any]) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    tmp.replace(DATA_PATH)


def _write_status_file() -> None:
    try:
        STATUS_PATH.write_text(
            json.dumps(_status, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        log.warning("Could not write status file: %s", exc)


def _recompute_rate(registered: int | None, vep: int | None) -> float | None:
    if registered is None or not vep:
        return None
    return round(registered / vep, 4)


async def run_pipeline(trigger: str = "schedule") -> dict[str, Any]:
    """
    Run all scrapers and merge results into states.json.
    VEP is preserved from the seed report unless Elect Project provides updates.
    Registered counts refresh from WPR/IVP when scrape succeeds.
    """
    global _data_revision

    async with _lock:
        if _status["running"]:
            return {"ok": False, "message": "Pipeline already running", "status": get_status()}

        _status["running"] = True
        _status["last_run_started"] = utc_now_iso()
        _status["last_error"] = None
        _status["run_count"] = int(_status.get("run_count") or 0) + 1
        _write_status_file()

    sources: dict[str, Any] = {}
    changes: dict[str, Any] = {
        "registered_updated": 0,
        "registered_unchanged": 0,
        "states_touched": [],
    }
    error: str | None = None

    try:
        data = load_data()
        states = data["states"]
        by_abbr = {s["abbr"]: s for s in states}

        # --- WPR registered ---
        try:
            wpr = await fetch_registered()
            sources["wpr"] = {
                "ok": True,
                "fetched_at": utc_now_iso(),
                "url": wpr["url"],
                "source": wpr["source"],
                "total_2026": wpr["total_2026"],
                "states": wpr["raw_count"],
            }
            for abbr, reg in wpr["by_abbr"].items():
                row = by_abbr.get(abbr)
                if not row or row.get("noRegistration"):
                    continue
                old = row.get("registered2026")
                if old != reg:
                    row["registered2026"] = reg
                    if not row.get("noRegistration"):
                        row["rate"] = _recompute_rate(reg, row.get("vep2024"))
                    changes["registered_updated"] += 1
                    changes["states_touched"].append(abbr)
                else:
                    changes["registered_unchanged"] += 1
            # National IVP total
            data.setdefault("meta", {}).setdefault("national", {})
            data["meta"]["national"]["registeredIvpApproxMillions"] = round(
                wpr["total_2026"] / 1e6, 1
            )
            data["meta"]["sources"]["registered"]["last_scraped"] = utc_now_iso()
            data["meta"]["sources"]["registered"]["scrape_url"] = wpr["url"]
            data["meta"]["sources"]["registered"]["scrape_total"] = wpr["total_2026"]
        except Exception as exc:  # noqa: BLE001
            log.exception("WPR scrape failed")
            sources["wpr"] = {"ok": False, "error": str(exc), "fetched_at": utc_now_iso()}
            error = f"WPR: {exc}"

        # --- USAFacts national ---
        try:
            uf = await fetch_usafacts_national()
            sources["usafacts"] = {
                "ok": bool(uf.get("ok")),
                "fetched_at": utc_now_iso(),
                "url": uf["url"],
                "registered_millions": uf.get("registered_millions"),
                "article_updated": uf.get("article_updated"),
            }
            if uf.get("registered_millions") is not None:
                data["meta"]["national"]["registeredUsafactsApproxMillions"] = uf[
                    "registered_millions"
                ]
                data["meta"]["sources"]["usafacts"]["last_scraped"] = utc_now_iso()
                data["meta"]["sources"]["usafacts"][
                    "scraped_millions"
                ] = uf["registered_millions"]
        except Exception as exc:  # noqa: BLE001
            log.exception("USAFacts scrape failed")
            sources["usafacts"] = {
                "ok": False,
                "error": str(exc),
                "fetched_at": utc_now_iso(),
            }

        # --- Elect Project probe (VEP usually unchanged) ---
        try:
            vep = await fetch_vep_status()
            sources["electproject"] = {
                "ok": True,
                "fetched_at": utc_now_iso(),
                "vep_updated": vep.get("vep_updated", False),
                "note": vep.get("note"),
                "probes": vep.get("probes"),
            }
        except Exception as exc:  # noqa: BLE001
            sources["electproject"] = {
                "ok": False,
                "error": str(exc),
                "fetched_at": utc_now_iso(),
            }

        data["meta"]["asOf"] = datetime.now(timezone.utc).strftime("%Y-%m")
        data["meta"]["last_pipeline_run"] = utc_now_iso()
        data["meta"]["last_pipeline_trigger"] = trigger
        data["meta"]["data_revision"] = int(data["meta"].get("data_revision") or 0) + 1

        save_data(data)
        _data_revision = data["meta"]["data_revision"]

        async with _lock:
            _status["sources"] = sources
            _status["changes"] = changes
            _status["last_success"] = utc_now_iso()
            if error and not sources.get("wpr", {}).get("ok"):
                _status["last_error"] = error
            else:
                # Partial failures are recorded in sources, not fatal
                _status["last_error"] = None if sources.get("wpr", {}).get("ok") else error
            _status["last_run_finished"] = utc_now_iso()
            _status["running"] = False
            _status["data_revision"] = _data_revision
            _status["trigger"] = trigger
            _write_status_file()

        log.info(
            "Pipeline OK trigger=%s updated=%s revision=%s",
            trigger,
            changes["registered_updated"],
            _data_revision,
        )
        return {"ok": True, "status": get_status(), "data_revision": _data_revision}

    except Exception as exc:  # noqa: BLE001
        log.exception("Pipeline failed")
        async with _lock:
            _status["running"] = False
            _status["last_error"] = str(exc)
            _status["last_run_finished"] = utc_now_iso()
            _status["sources"] = sources
            _status["changes"] = changes
            _write_status_file()
        return {"ok": False, "message": str(exc), "status": get_status()}


def bootstrap_revision() -> None:
    global _data_revision
    try:
        data = load_data()
        _data_revision = int(data.get("meta", {}).get("data_revision") or 0)
        if STATUS_PATH.exists():
            saved = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
            _status.update({k: saved[k] for k in saved if k in _status or k == "data_revision"})
    except Exception:  # noqa: BLE001
        _data_revision = 0
