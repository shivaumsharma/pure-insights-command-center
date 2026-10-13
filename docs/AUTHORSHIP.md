# Authorship note

The Phase 0-5 code (backend, frontend), tests, SQL, docs and decision log in this repository were written by Claude Code (an AI
assistant) at the direction of the project owner, not hand-written by the owner.

What the owner must do before submitting:
- Read every file in `backend/src/`, `frontend/src/` and `sql/` and be able to explain each rule in `docs/decisions.md` (D2, D10-D43) without opening the code.
- Re-run `npm test` and `npm run data:build` on a fresh clone.
- Rewrite or annotate any decision they disagree with, and record the change in the decision log.

## About the commit history

The code was built over several working sessions **before this repository existed**, so the history is not a replay of how it was written. It
groups the finished work by area (data, SQL, API, alerts, AI explanations, web, validation, CI, docs), and every commit carries the date it was
actually made. Nothing is backdated. The decision log (`docs/decisions.md`) is the better record of how and why the work went the way it did.

Update this note as the owner takes over more of the work, so it stays an accurate statement of who did what.
