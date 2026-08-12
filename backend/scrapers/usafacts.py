"""Scrape USAFacts national registered-voter figure and article timestamp."""

from __future__ import annotations

import re
from typing import Any

import httpx

USAFACTS_URL = (
    "https://usafacts.org/articles/how-many-voters-have-a-party-affiliation/"
)
USER_AGENT = "VoterRegistrationDashboard/1.0 (+local research; respectful fetch)"


async def fetch_usafacts_national(timeout: float = 30.0) -> dict[str, Any]:
    """
    Best-effort national total from USAFacts narrative page.
    Returns millions as float when parseable.
    """
    async with httpx.AsyncClient(
        timeout=timeout,
        headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        follow_redirects=True,
    ) as client:
        resp = await client.get(USAFACTS_URL)
        resp.raise_for_status()
        html = resp.text

    # e.g. "204.6 million Americans are registered to vote"
    m = re.search(
        r"([\d.]+)\s*million\s+Americans\s+are\s+registered\s+to\s+vote",
        html,
        re.I,
    )
    millions = float(m.group(1)) if m else None

    # California / Texas / Florida mentions for sanity (optional)
    cal = re.search(r"California[^\d]{0,40}([\d.]+)\s*million", html, re.I)
    updated = re.search(r"Updated\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})", html)

    return {
        "source": "USAFacts voter registration article",
        "url": USAFACTS_URL,
        "registered_millions": millions,
        "california_millions": float(cal.group(1)) if cal else None,
        "article_updated": updated.group(1) if updated else None,
        "ok": millions is not None,
    }
