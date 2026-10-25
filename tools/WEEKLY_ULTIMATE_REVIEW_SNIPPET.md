# Weekly routine addition — sketch only (do NOT apply without Mike)

Target routine: `weekly-fan-off-prediction-review` (Saturday ~9am Perth).

## Add after the existing next-off / PREDICT section

### Ultimate cooling-done review
Also backtest the **ultimate** prediction (when parked cool *cycling* is done for good — last fan→off that holds in watching until the next drive or the 8 h cap — not the next single off).

1. Run:
   ```
   node tools/predict-ultimate-backtest.js --from <7-days-ago> --to <today>
   ```
   (same Pack log CSV source as `predict-backtest.js`)

2. Report for Mike in plain words:
   - How many parked cool sessions had a known ultimate-off in the last 7 days
   - Median |error| and p80 |error| (minutes)
   - Mean bias (+ = predicted too late / cycling went on longer than shown)
   - Coverage of the shown ± range (target ~80%)

3. Propose PREDICT_ULTIMATE tweaks (do **not** commit without Mike), pasting the backtest “Paste into PREDICT_ULTIMATE” lines:
   - `typicalSessionMin`, `typicalCycles`, `cycleOnMin`, `cycleIdleMin`
   - `bands:[...]` (± by predicted lead)
   - Optionally `fudge` / `blend` if bias is consistently early or late
   - Bump `version` (u1 → u2 …) when changing

4. Keep next-off (PREDICT) and ultimate (PREDICT_ULTIMATE) reviews side-by-side in the same Saturday note so Mike can approve both, either, or neither.

5. Remind: publish path is edit `app/index.html`, then mirror to root `index.html` on publish — do not push without Mike.
