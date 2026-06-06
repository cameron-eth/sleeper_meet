# sleeper_meet

An immersive, broadcast-style draft room for **Sleeper** fantasy football leagues — live picks, a primetime "on the clock" board, KeepTradeCut team values, and rookie highlight reels.

## Features

- **Live draft tracking** via the public Sleeper API (no login) — enter a username, pick a season → league → draft.
- **"Pick is in" chime** that fires only when a new pick is made.
- **On-the-clock card** with trade-aware ownership (shows the *current* owner of a pick, even if it was traded), a countdown, and the team's **KTC value + roster rank**.
- **2026 ↔ 2025 flashback** — the recent-picks panel cycles between live picks and the on-the-clock manager's prior-year draft class.
- **Best Available board** — rookies sorted by KTC (superflex) value, dropping off as they're drafted.
- **Rookie highlight reels** — drafted players auto-play their highlights; click any Best Available name to watch on demand.
- **Demo mode** — simulates a live snake draft so you can preview the whole flow.

## Run it

It's a static site (vanilla HTML/CSS/JS — no build step):

```bash
python3 -m http.server 3000
```

Then open <http://localhost:3000>.

- **Run Demo Draft** for a simulated draft, or
- enter a Sleeper username → pick a league → pick a draft to follow it live.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Setup / league + draft picker |
| `draft.html` | The live draft room |
| `app.js` | All app logic (Sleeper API, board, values, reels) |
| `styles.css` | Styling |
| `ktc_values.json` | Dynasty value snapshot (player → KTC superflex value) |
| `highlights.json` | Player → YouTube highlight link map |
| `chime.mp3` | The draft "pick is in" chime |

To refresh dynasty values, drop a newer export in as `ktc_values.json`. To add a highlight, append `"Player Name": "<youtube url>"` to `highlights.json`.

## Data sources

- [Sleeper public API](https://docs.sleeper.com/) — drafts, picks, leagues, rosters, players.
- KeepTradeCut dynasty values (snapshot in `ktc_values.json`).
- YouTube embeds for highlight reels.
