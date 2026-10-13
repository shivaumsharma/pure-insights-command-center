# Demo script (about five minutes)

One address: `http://localhost:3101`. The strongest moment is first: the app checking its own numbers and showing where they disagree.

## Before you start (once, takes about two minutes)

```bash
npm install && npm run web:install && npm run data:build && npm run web:build
JWT_SECRET=use-any-random-text-of-at-least-32-characters npm start
```

Setting `JWT_SECRET` keeps sign-ins valid if you restart the server during the demo. Open a second window for the viewer account, so you
do not have to sign out and in. Passwords are in `backend/config/demo-users.json`.

## The walk-through

1. **Costs, as admin (60 s).** "Can we trust these numbers?" shows six checks passing, one "for information", and one failing.
   Say: the failing one is on purpose. It compares what each report is *claimed* to cost with what its query workload implies. Here they are
   unrelated, so 64 of 100 disagree; that shows the check works. It is not evidence that a real report is mis-billed.
2. **Overview with the live feed (60 s).** Point at the "Alerts: Live" pill and the feed filling, then the fleet map: one tile per report, a symbol for
   its refresh, a dot when it is slow. Say: 74% of readings are over the limit, so repeats are held back. The "Alert noise" card (admin) shows
   about 60% of breaching readings held back instead of announced again.
3. **Roles (60 s).** In the viewer window: no Costs page in the menu. Open `/costs` by typing it: "No access". Say the server refuses it
   too (it returns 403), not just the screen.
4. **Orphaned reports (60 s).** Admin: 13 reports nobody owns and their spend. Assign one (try a bad email first: the error is inline), watch the
   count drop to 12, then Undo. Say: assignments are an overlay with an audit trail; the source data is never changed.
5. **A failure path (45 s).** Restart the server (Ctrl+C, run it again with the same `JWT_SECRET`). The pill goes to "Reconnecting…" and
   comes back to "Live" without a reload, and the alert lists refresh once. (Alerts raised during the restart are not replayed; the page
   refetches them instead.) Then show a wrong password on the sign-in page.
6. **Explain an alert (60 s).** On Alerts, choose Explain on an open alert: the suggestion appears with the evidence behind every claim and the
   words "Suggestions only. Nothing is done automatically." Say who wrote it (rules unless an AI is switched on) and that anything that cannot be
   checked against the data is held for an admin, and anything that contradicts the data is withheld. Open "How it was checked" to show the list. If the AI's answer is held, show that a viewer gets the rule-based explanation instead (labelled), and that an admin can Approve or Dismiss right on the alert (the AI review page lists the same decisions, and the statistics).
7. **Prove it (45 s).** In a terminal run `npm run validate`: a separate Python program re-derives the numbers from the raw CSV and compares them with the app
   (68 checks). Say what it does not show: same author, same written rules, and the SQL has not run on a real Snowflake account.
8. **Close (30 s).** Open `docs/brief-map.md`: every requirement in the brief and where it is met, including what is not done.

## If something goes wrong
- **Fonts do not load** (no internet): the page falls back to system fonts. It still works.
- **Port in use:** `PORT=3102 npm start`, then use that port.
- **Pill stuck on "Reconnecting…":** the page and server must be on the same address. Do not open the page from another port.
- **Signed out unexpectedly:** the server was restarted without `JWT_SECRET`, so old tokens stopped working. Sign in again.
