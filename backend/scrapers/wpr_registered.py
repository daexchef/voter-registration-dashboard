"""Scrape Independent Voter Project 2026 registration estimates from World Population Review."""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

WPR_URL = "https://worldpopulationreview.com/state-rankings/registered-voters-by-state"
USER_AGENT = "VoterRegistrationDashboard/1.0 (+local research; respectful fetch)"

# 50 states only (exclude DC and territories if present)
STATE_ABBRS = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
}


def _extract_state_objects(html: str) -> list[dict[str, Any]]:
    starts = list(re.finditer(r'\{"state":"[A-Za-z .]+","code":"[A-Z]{2}"', html))
    out: list[dict[str, Any]] = []
    for m in starts:
        i = m.start()
        depth = 0
        j = i
        while j < len(html):
            ch = html[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        try:
            obj = json.loads(html[i:j])
        except json.JSONDecodeError:
            continue
        if obj.get("code") in STATE_ABBRS:
            out.append(obj)
    # de-dupe by code (page may embed data twice)
    by_code: dict[str, dict[str, Any]] = {}
    for obj in out:
        by_code[obj["code"]] = obj
    return list(by_code.values())


async def fetch_registered(timeout: float = 45.0) -> dict[str, Any]:
    """
    Returns:
      {
        "source": "...",
        "url": "...",
        "total_2026": int,
        "by_abbr": { "CA": 23222034, ... },
        "raw_count": int,
      }
    """
    async with httpx.AsyncClient(
        timeout=timeout,
        headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        follow_redirects=True,
    ) as client:
        resp = await client.get(WPR_URL)
        resp.raise_for_status()
        html = resp.text

    rows = _extract_state_objects(html)
    if len(rows) < 45:
        raise RuntimeError(f"WPR scrape expected ~50 states, got {len(rows)}")

    by_abbr: dict[str, int] = {}
    for row in rows:
        val = row.get("RegisteredVotersIVPEstimate_2026")
        if val is None:
            continue
        by_abbr[row["code"]] = int(val)

    total = sum(by_abbr.values())
    return {
        "source": "World Population Review / Independent Voter Project (IVP) 2026 estimates",
        "url": WPR_URL,
        "total_2026": total,
        "by_abbr": by_abbr,
        "raw_count": len(by_abbr),
        "fields": ["RegisteredVotersIVPEstimate_2026"],
    }
