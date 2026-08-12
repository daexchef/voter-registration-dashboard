# Voter Registration Dashboard

Interactive US dashboard comparing **Eligible voters (VEP 2024)** with **Registered voters (2026 estimates)** by state — national aggregates, live choropleth map, charts, searchable table, and drill-down to source methodology.

**Repository:** [github.com/daexchef/voter-registration-dashboard](https://github.com/daexchef/voter-registration-dashboard)

---

## Disclaimer (read this first)

This project is an **independent compilation and visualization tool** for public research and civic education. It is **not** an official product of any election office, political party, or government agency.

| | |
|---|---|
| **Not official election data** | Figures are estimates and snapshots from third-party compilations. They can differ from a state’s live voter rolls. |
| **Not for legal / operational use** | Do **not** rely on these numbers for ballot qualification, campaign compliance, or official reporting. |
| **Timing mismatch** | Eligible population (VEP) is anchored to **2024**. Registration estimates reflect **2025–mid-2026** compilations. Rates above 100% usually mean inactive or moved voters remain on rolls — not more registrants than eligible adults. |
| **North Dakota** | ND does **not** require voter registration. Its “registered” value is a placeholder; registration rate is **N/A**. |
| **Source of truth** | For the latest operational count in any state, use that state’s **Secretary of State / elections division**. Start here: [usa.gov — state election offices](https://www.usa.gov/state-election-office). Rolls change daily. |
| **Scraping** | The optional pipeline fetches public web pages. Respect site terms of use and rate limits; scrapers use a descriptive user-agent and modest schedules. |

Authors and hosters of this dashboard make **no warranty** of accuracy, completeness, or fitness for a particular purpose. Third-party data remains the property of its respective publishers.

---

## Data sources

| Metric | Source | What we use | Link |
|--------|--------|-------------|------|
| **Eligible (VEP 2024)** | United States Elections Project methodology (Michael McDonald) / Census-aligned citizen voting-age adjustments | State-level **Voting-Eligible Population** snapshot seeded in `data/states.json` | [electproject.org](http://www.electproject.org/) |
| **Registered (2026 est.)** | Independent Voter Project (IVP) estimates, published via World Population Review | State registered totals; **live pipeline** re-scrapes WPR when the API is running | [WPR — Registered voters by state](https://worldpopulationreview.com/state-rankings/registered-voters-by-state) |
| **National alternate** | USAFacts | National registered total used for comparison (~204.6M as of their April 2026 article) | [USAFacts voter registration article](https://usafacts.org/articles/how-many-voters-have-a-party-affiliation/) |
| **Map geometry** | PublicaMundi US states GeoJSON | State boundaries for the choropleth | [GeoJSON source](https://github.com/PublicaMundi/MappingAPI) |
| **Seed report** | Local compilation (`grok_report.pdf`) | Initial table used to bootstrap VEP + registration pairs | Bundled into `data/states.json` |

**Registration rate** = Registered (2026 est.) ÷ Eligible (VEP 2024).

National benchmarks cited in the UI (approx.): VEP ~240.7M · IVP registered ~217.2M · USAFacts ~204.6M · overall rate roughly **85–90%** of VEP depending on which registered total is used.

---

## Features

- National KPI cards (totals recompute as you filter)
- US map: rate / eligible / registered / gap
- Grouped bar chart (Eligible vs Registered + rate overlay)
- Sortable table, CSV export, state drill-down with source links
- Optional scrape pipeline + auto-refresh (`data_revision`)

---

## How to use (local)

### Requirements

- Python **3.10+**
- Network access (for map tiles, Chart.js/Leaflet CDNs, and optional scrapes)

### Install & run

```bash
git clone https://github.com/daexchef/voter-registration-dashboard.git
cd voter-registration-dashboard

python -m pip install -r backend/requirements.txt
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8080
```

Open **http://127.0.0.1:8080**

> Use this FastAPI server (not `python -m http.server`) so `/api/*`, the map GeoJSON proxy, and the refresh pipeline work.

### Windows (PowerShell)

```powershell
git clone https://github.com/daexchef/voter-registration-dashboard.git
cd voter-registration-dashboard
python -m pip install -r backend/requirements.txt
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8080
```

### What you’ll see

1. **KPIs** — aggregates for the current filter  
2. **Map** — click a state for drill-down  
3. **Chart & table** — sort, search, export CSV  
4. **Run pipeline now** — re-scrape WPR / USAFacts (needs outbound HTTPS)  
5. Auto-poll every ~20s when `data_revision` changes  

### Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `PIPELINE_INTERVAL_MINUTES` | `15` | How often the scheduler re-scrapes |
| `PIPELINE_RUN_ON_STARTUP` | `1` | Set to `0` to skip scrape on boot |
| `PORT` | `8080` | Used if you run `python main.py` |

Example:

```bash
set PIPELINE_INTERVAL_MINUTES=30
set PIPELINE_RUN_ON_STARTUP=0
python -m uvicorn main:app --host 0.0.0.0 --port 8080
```

---

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Liveness + data revision |
| `GET` | `/api/states` | Full dataset + pipeline snapshot |
| `GET` | `/api/status` | Last scrape / errors / change counts |
| `POST` | `/api/refresh` | Trigger scrape pipeline now |
| `GET` | `/api/geo/us-states` | Cached US states GeoJSON |

Machine-readable seed: [`data/states.json`](data/states.json)

---

## Deploy publicly (quick options)

The app is a single process (FastAPI serves UI + API + scheduler).

### Render / Railway / Fly.io (recommended)

1. Create a new **Web Service** from this GitHub repo.  
2. **Root directory:** repository root (or set start command from `backend/`).  
3. **Build:** `pip install -r backend/requirements.txt`  
4. **Start:** `cd backend && uvicorn main:app --host 0.0.0.0 --port $PORT`  
5. Open the public HTTPS URL.

A sample [`render.yaml`](render.yaml) is included for [Render](https://render.com).

### Docker (optional)

```bash
docker build -t voter-dashboard .
docker run -p 8080:8080 voter-dashboard
```

### Static-only caveat

GitHub Pages can host `index.html`, but **without** the Python API the live pipeline, `/api/refresh`, and GeoJSON proxy will not run. Prefer a small always-on web service for the full experience.

---

## Project layout

```
voter-registration-dashboard/
  index.html              # UI shell
  css/styles.css
  js/app.js               # map, charts, poll, drill-down
  data/states.json        # canonical metrics (pipeline may update registered fields)
  backend/
    main.py               # FastAPI + static files + scheduler
    pipeline.py           # merge scrapers → states.json
    requirements.txt
    scrapers/
      wpr_registered.py   # IVP via World Population Review
      usafacts.py         # national alternate total
      electproject_vep.py # Elect Project probe (VEP stays on snapshot)
  render.yaml             # one-click Render blueprint
  Dockerfile
  LICENSE
  README.md
```

---

## License

MIT — see [LICENSE](LICENSE). Third-party data and trademarks remain with their owners; this license covers the dashboard code only.
