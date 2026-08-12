"""
Optional VEP fetch from United States Elections Project / Elect Project.

Full state-level VEP is not published as a stable machine-readable feed that
updates continuously. This module attempts known public endpoints and falls
back gracefully so the pipeline keeps using the last good VEP snapshot.
"""

from __future__ import annotations

from typing import Any

import httpx

CANDIDATE_URLS = [
    # CSV / data pages sometimes linked from electproject — may 404; that's OK.
    "https://www.electproject.org/election-data/voter-turnout-data",
    "http://www.electproject.org/2024g",
]
USER_AGENT = "VoterRegistrationDashboard/1.0 (+local research; respectful fetch)"


async def fetch_vep_status(timeout: float = 20.0) -> dict[str, Any]:
    """Probe Elect Project availability; does not replace VEP unless CSV found."""
    results = []
    async with httpx.AsyncClient(
        timeout=timeout,
        headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/csv,*/*"},
        follow_redirects=True,
    ) as client:
        for url in CANDIDATE_URLS:
            try:
                resp = await client.get(url)
                results.append(
                    {
                        "url": url,
                        "status": resp.status_code,
                        "bytes": len(resp.content),
                        "content_type": resp.headers.get("content-type", ""),
                    }
                )
            except Exception as exc:  # noqa: BLE001
                results.append({"url": url, "error": str(exc)})

    return {
        "source": "United States Elections Project (Elect Project) probe",
        "url": "http://www.electproject.org/",
        "note": (
            "State VEP 2024 remains anchored to the report snapshot unless a "
            "stable machine-readable update is published. Probe results only."
        ),
        "probes": results,
        "vep_updated": False,
        "by_abbr": {},
    }
