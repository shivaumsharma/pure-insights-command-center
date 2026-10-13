# Interview Q&A

The ten questions a panel is most likely to ask about this project, with an answer you can say in about a minute and where to check it.
**Read the answers, then close this file and answer out loud.** If you cannot explain a point without opening the code, read that code first.

The code was written by an AI assistant at your direction (see `AUTHORSHIP.md`). Say that plainly if asked. What you are defending is that
you understand it, chose its trade-offs, and checked it. Everything below is something that was actually checked.

## 1. Walk me through the architecture in a minute.
A CSV of 2,000 rows (100 reports, 20 readings each) is cleaned into a trusted set plus a ledger of what was set aside. From the trusted rows
I build simulated Snowflake usage tables. SQL scripts attribute warehouse credits to reports and compute cost per view. An Express API
serves that behind a login with three roles, an alert engine turns readings into alerts, a WebSocket pushes them live, and a React app shows it.
*Check:* `docs/architecture.md`.

## 2. How do you know your cost numbers are right?
Three ways. The SQL is tested on small inputs I worked out by hand. An independent Python script, sharing no code with the SQL, recomputed
the headline figures and matched. And the app runs checks on its own numbers (credits balance in every hour, no rows lost in joins). One
check is labelled "for information" because it agrees only by construction, and I say so.
*Check:* `docs/cost-allocation.md`, `backend/test/cost-sql.test.js`, decision D12.

## 3. Your reconciliation fails for 64 of 100 reports. Isn't that a bug?
No, and I would not have built it to pass. Each report's claimed credits and its query workload are independent in this synthetic data, so
they disagree. The check exists to catch exactly that. If I had generated workload to match the credits, it would pass and prove nothing.
It does not mean any real report is mis-billed, and the app says so on the page.
*Check:* decisions D5 and D12.

## 4. How did you decide what to throw away and what to keep?
Only what cannot be trusted leaves the trusted set: 24 rows with negative credits. Everything odd but plausible (no owner, unknown status,
zero views) stays and is flagged, because a report with no owner still costs money, and "unknown" is not "failed". Nothing is deleted:
every set-aside row is in a ledger with its reason and original line.
*Check:* decision D2, the Data quality page.

## 5. 74% of readings were over the 15-second limit. How did you handle alert noise, and did it work?
Partly. I only announce a problem when it first appears, when it gets worse, as a reminder every 6 hours, and when it clears (after two good
readings, so it does not flap). Repeats are counted, not hidden. On this data 2,026 breaching readings become 838 alerts needing attention, a
41% rate. That is modest, because the data is almost always in alert. My first design produced about one message per reading; I measured
that, fixed the flapping, and I am not claiming more than the number shows.
*Check:* decisions D20 and D21.

## 6. How do you know a viewer cannot see cost data?
The server enforces it, not the screen. A viewer's own token gets 403 from every cost and admin endpoint; I tested that in code, by breaking the
rule on purpose to confirm the test fails, and in a real browser. The UI also hides those pages, but that is only courtesy.
*Check:* `backend/test/api.test.js` (role matrix), decision D26.

## 7. What happens when the live connection drops?
The client reconnects with growing, randomised delays and tells the server the last alert it saw. The server sends exactly the missed ones,
once, in order, only those that role may see. If too many were missed it says so and the page reloads its lists. The token goes in the first
message, never the address.
*Check:* `docs/api-spec.md`, `frontend/src/lib/liveFeed.js`, decisions D22 and D23.

## 8. Why WebSocket and not server-sent events?
Either was allowed. Honestly, SSE would have been simpler for one-way alerts and reconnects natively. I chose WebSocket for the explicit
protocol (first-message auth, heartbeat, close codes) and because the brief names it first. The cost is that I wrote reconnect handling that
SSE would have given me.

## 9. What would change with a real Snowflake account?
I never ran the SQL on real Snowflake; it runs on a local SQLite stand-in, written in the portable subset. Real usage views have their own
delays and column details that I would need to check, and per-query attribution would use real query tags instead of my simulated table. The
divide-by-zero guard is the one thing I could not test locally, because SQLite returns NULL where Snowflake raises an error.
*Check:* decision D9. (Verify any claim about real Snowflake's behaviour before you state it.)

## 10. What did the AI do, and how did you check its work?
The assistant wrote the code. What I did was set the direction, and verify: independent recomputation in a second language, mutation checks
(deliberately breaking the code to confirm tests fail; this found real gaps), a real-browser pass as each role, and measured accessibility. Those
checks found bugs the assistant's own tests missed: the live feed being refused its own origin, and alerts going silent after a server
restart because event numbers started over. Neither is visible to a unit test on one side alone.
*Check:* decision log D1 to D31, `AUTHORSHIP.md`.

## 11. You added AI. How do you know it is not making things up?
I do not trust it; I check it. The AI gets a small pack of numbered facts about the alert and must cite which fact each claim comes from, and
the value it read. A checker then compares every citation with the real data, tests each cause against a simple data rule, and rejects numbers
that are not in the evidence. A false suggestion is withheld, one that cannot be verified waits for a person, and only one that passes is shown,
with its evidence. It is also labelled as written by an AI. A rule-based version with no AI is the control, so a model can be compared with it.
*Be honest about:* I ran it on four small free models on my laptop, 10 alerts each. Passed the checks: Llama 3.1 8B 6, Gemma 2 9B 3, Qwen 7B 0 (8 rejected, 2 held),
Qwen 1.5B 0. The largest model was not the best one. The rule-based version passed 9 of the same 10. That is a small, untuned sample, not a claim about AI in general. I never ran a hosted
model (no key). The checker catches the mistakes I thought of, not every possible one, and "passed" means checked against the evidence, not
true of the real world.
*Check:* decisions D32 to D38, `npm run triage:eval`.

## 12. You added charts late. Why, and how do you know they are right?
They show data the API already served, so they are presentation, not a new feature: no backend change. A command center is read at a glance and
the first version was mostly tables. I drew them by hand as SVG and CSS rather than add a library, which means I own their arithmetic, so that
is in separate functions with their own tests, and I broke the chart code 33 ways to check the tests fail. Every number is also written as text,
status is a symbol as well as a colour, and the cost chart has a table behind it.
*Be honest about:* I added them late, and I tested for names and text, not with a screen reader. The wide layout was checked by measurement and an
early look, not page by page. The alert-noise totals grow because the replay loops; the ratio is the point.
*Check:* decision D39, `docs/design-system.md`.

## 13. How do you know your numbers are right?
I do not just trust them; a separate Python program, sharing no code with the app, re-derives them from the raw CSV and compares item by item: the
cleaning, every one of the alerts, the credit attribution, the cost per view, the hosting-cost flags and the explanations (`npm run validate`, 42
checks). I broke the app in 13 ways to check the validator fails when it should. It also checks every number my README quotes.
*Be honest about:* I wrote both sides from the same written rules, so it catches slips and drift, not a wrong reading of the brief; and the SQL was
compared through a SQLite stand-in, never on Snowflake (`docs/snowflake-run.md` is how to do that).
*Check:* decision D40, `validation/REPORT.md`.

## 14. The data has dollars. Why not rupees?
The cost column in the file is `aws_hosting_cost_usd`, so the data is in dollars and I kept it that way. A conversion would need an exchange rate the data
does not contain. Snowflake credits are a unit, converted at a placeholder $3 each, and every page that shows dollars says so (decision D42).

## Hard follow-ups to be ready for

- **"Did you test the AI part?"** The checker, rules, service and screens are tested hard (broken on purpose to confirm tests fail). The local
  model adapter is tested against a stand-in server and was run once against a real local model. The hosted model's adapter is tested only
  against a fake; `npm run triage:eval -- --llm` would run it with a key.
- **"Why did the model do so badly?"** It is a small 7B model with a prompt I did not tune, on 10 alerts. It copied values loosely and cited
  causes the data contradicts. The point is that none of that reached a reader. I did not test whether a bigger model, or a looser format
  rule, would do better.
- **"What stops it leaking data?"** Only the evidence pack is sent: no names, emails or costs. The AI is off unless explicitly switched on, and the default local model never leaves the machine.

- **"What is not finished?"** No real Snowflake run; CI has never run on GitHub; no linter; no review workflow (the "reports to review" list is
  read-only); no screen-reader test; the credit price is a placeholder.
- **"Where could the numbers mislead?"** The data is random, so any ranking ("most expensive report") reflects the generator, not behaviour.
- **"Why not use a charting or data library?"** Fewer dependencies to explain and audit; the chart is one small SVG.
- **"Is it secure?"** Server-enforced roles, hashed passwords, login throttling, a strict content policy, expiring tokens. Not done: logout
  that revokes a token, HTTPS (put it behind a proxy), a shared store for the throttle.

## Questions worth asking them
- How do deal strategists decide today whether an application's number can be trusted?
- What happens to a suggestion the tool is unsure about: is it paused, or shown with a warning?
- What does the first month of validation work look like?
