# Draft War Room — Worldwide League (2026-27, Yahoo 9-cat)

Mobile-first draft assistant for a 10-team, head-to-head 9-category Yahoo snake draft with a 1-minute clock.
No backend, no accounts, no paid APIs. State is saved in your browser (localStorage).

## Open it on your phone

1. **Hosted (easiest):** open the published artifact link from the Claude session, or
   `https://rawcdn.githack.com/travex-pixel/NBA-fantasy-/<branch>/dist/index.html`
   (replace `<branch>` with the branch name, e.g. `ccr-1b751505-sk0yh9`; `main` after merging).
2. **Offline:** download `dist/index.html` to your phone and open it in Chrome. It is fully self-contained.
3. **Locally:** `npm run serve` then open `http://localhost:8080/`.

## Using it during the draft

* **Setup:** tap your draft slot (1-10). Change it later under *Strategy → My draft slot* if the order is announced late.
* **Draft Now (default):** shows *BEST PICK NOW*, three reasons, category chips (green = strength, red = weakness),
  roster fit, risk flag, ADP note, confidence, and two backups. Tap **Draft ME** when you take a player.
* **Marking other teams' picks (fast):** type into the top box, e.g. `TAKEN: Anthony Edwards, Brunson, Wembanyama`
  and press *Mark taken*. Each name is assigned to the team on the clock in snake order. Ambiguous names (e.g. "Murray")
  pop a chooser; nothing is removed until you confirm. Or tap **Taken** on any player card.
* **Undo:** `↶ Undo last pick` reverses the last action (multi-level).
* **Players tab:** search by name/team/position; tap a row for details; mark **Not in pool** to hide a player.
* **Strategy tab:** draft plan, punt toggles (off by default), weight-by-games toggle, model board, sources, reset.
* **Timer:** tap `60s` in the header to run a pick countdown (turns red under 15 s).

## Fallback workflow if something breaks

Open the Players tab and use it as a ranked cheat sheet: it is sorted by 9-cat model value and shows ADP.
Mark players *Taken* as they go. If the page is lost, reopen it — the ledger is persisted in the browser.
If the player pool is wrong for a name, use *Players → Log a pick ... not in this list*.

## How the model works (transparent)

* Per-game 2026-27 estimates (see `src/data.js` header for provenance) → z-scores per category against a
  130-player "draftable" pool (two-pass).
* FG% and FT% use **volume-weighted impact**: `(player% − pool%) × attempts`.
* Turnovers are sign-flipped (fewer = better). Games-played scales counting value (toggle).
* Punted categories get weight 0 (never on by default).
* Recommendation = category value × roster-need weights + position fit (two C slots!) + "will they survive to
  your next pick" (ADP vs snake order) − flags. Confidence reflects the gap to the backups and risk flags.
* Missing stats → z = 0 and the player is flagged `fallback`; no fabricated numbers.

## Live NBA stats and injuries

`scripts/fetch-espn.mjs` pulls 2026-27 per-game stats for every player (ESPN `site.web.api.espn.com` byathlete API)
and the league injury report (ESPN `site.api.espn.com` injuries API) into `data/live-stats.json`. The hosted page
reads the same payload from its artifact database document `stats/latest` (written with the ArtifactData tool);
other copies read the JSON file over HTTP. The model blends live and preseason lines
`(preseason × 25 + live × games) ÷ (25 + games)` with percentages blended on makes and attempts (toggle under
*Strategy → Live NBA stats*), shows injury badges (OUT / GTD with return date) on every card, and the recommender
penalises OUT players.

Network requirements for the cloud environment: allow `site.web.api.espn.com` and `site.api.espn.com`.
`stats.nba.com` is allowed-but-useless from cloud addresses (it never answers), and `www.espn.com` sits behind a
bot challenge; `scripts/fetch-stats.mjs` (NBA Stats API) is kept for local use only.
A daily scheduled task ("Daily NBA live stats refresh", 3:47pm Sydney) runs the ESPN fetcher, commits the JSON and
writes the db document. Manual run:

```
node scripts/fetch-espn.mjs                                     # live
node scripts/fetch-espn.mjs --stats-fixture test/fixtures/espn-stats-sample.json --injury-fixture test/fixtures/espn-injuries-sample.json
```

## Yahoo integration

**Not connected.** Yahoo's Fantasy API requires a registered OAuth 2.0 app (client id/secret, redirect URI)
and a signed API agreement; none exist here, so the app runs in manual-assisted mode by design.

## Tests

```
npm test        # engine unit tests (node:test)
npm run build   # bundle to dist/index.html
node test/ui.smoke.mjs   # browser smoke test (needs Chromium + playwright-core)
```

## Data honesty

All ranking/news sites in the brief were blocked by the session's network policy on 20 Oct 2026; only
web-search summaries were readable. Player stats are analyst estimates from the 2025-26 baseline plus confirmed
offseason moves, ADP is quoted only where a snippet gave a number. See *Strategy → Data & sources*.

## Quick Pick from screenshot

In the Claude-hosted version, the Draft Now tab has **QUICK PICK FROM SCREENSHOT**. Pick a Yahoo draft-room
screenshot (Players list, Draft Results or My Team). The page sends the image to Claude through the artifact
runtime's `sample` capability (your Claude account; a one-time consent prompt) and asks for a strict JSON list of
legible names and their status. The app then:

* proposes ledger updates (Taken / My roster) that only apply after you confirm;
* shows BEST PICK NOW, BACKUP 1, BACKUP 2, a one-sentence WHY and a RISK line computed by the existing engine with
  the proposed updates applied tentatively;
* flags ambiguous names (you tap the right player), unreadable names, conflicts with the ledger, duplicate uploads,
  and a mismatch between the screenshot's pick number and the app's;
* never treats a partial list as the whole pool, and never recommends a player logged as drafted;
* logs your pick with one tap ("I drafted"); Undo reverts the whole batch.

The local/GitHub copy cannot send images to Claude, so it shows that limitation instead of an upload button.
Fallback: send the screenshot in the Claude Code chat and paste the names into the TAKEN box.
