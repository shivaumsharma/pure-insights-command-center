# Design system

The UI takes its **palette from the Everpure website** (a single orange accent, near-black, pill buttons) and its **layout manner from a public
dashboard concept** the owner supplied as a reference (dribbble.com/shots/25605570): a white side menu with grouped items, soft white cards on a
light canvas, a smooth orange chart over a gradient with a dark tooltip. It is a family resemblance, not a copy: no logo, imagery, copy or font
files from either source are used (see decision D41).
Tokens live in [`frontend/src/styles/theme.css`](../frontend/src/styles/theme.css); components must read them and never hard-code colours.

## Where the tokens come from

Read from the colour variables and stylesheet of a locally saved copy of the Everpure homepage (not rendered; the page could not
be opened in the preview browser, so layout was inferred from CSS and markup, not seen). Key values: brand orange `#ff7023`
(pressed `#d55d1d`), dark `#2d2a27`, cream `#fff5e3`, warm greys `#f6f4f1`-`#68645d`, card radius 16px, pill radius 26px.

## Deliberate departures from the source palette

Measured with the WCAG relative-luminance formula:

| Pairing | Ratio | Decision |
|---|---|---|
| White text on `#ff7023` | **2.77:1 (fails AA)** | Buttons use dark `#2d2a27` text instead (5.16:1) |
| Orange `#d55d1d` as text on cream | 3.59:1 (fails) | Orange text uses `#aa4b17` (5.21:1) |
| Warm grey `#8b857c` on cream | 3.38:1 (fails) | Secondary text uses `#68645d` (5.44:1) |
| Body `#2d2a27` on cream | 13.19:1 | OK |
| Dark text on the *pressed* orange `#d55d1d` | 3.68:1 (fails) | Pressed buttons keep the base orange and add a dark border |
| Each status colour on its light background | 5.9-6.8:1 | OK |
| Brand orange `#ff7023` as a chart colour on white | 2.77:1 (graphics need 3:1) | Charts use `#e8601c` (3.43:1); text keeps `#aa4b17` |
| Muted text on the light canvas | was 5.4:1 | now `#5f5b55`, 6.2:1 |

## Components (built, in `frontend/src/components`)

- **App shell:** a white side menu (252 px) grouped into Monitor, Money and Validate, the current page marked by an orange bar on its edge and a tinted row; the account and Sign out at the bottom. The content area has a greeting and the live-alerts status above the page. Below 900 px the menu becomes a bar across the top (brand and account, then the links on their own scrollable row).
- **Card:** `--pi-surface` (white), 1px `--pi-border`, 14px radius, 24px padding, a very light shadow. Summary cards and KPI callouts (36px Inter numerals) use it.
- **Buttons:** primary = orange pill with dark text; secondary = outlined pill; both at least 44px tall; visible 2px focus ring in `--pi-focus-ring`.
- **Severity badge:** text colour + light background + an icon or label, never colour alone.
- **Tables:** sunken stripe on alternate rows, mono font for IDs and numbers, a caption for screen readers, and horizontal scrolling inside the table (never the page).
- **States:** every list and chart has loading, empty and error states.

Contrast is enforced by `frontend/src/styles/contrast.test.js`, which reads the real tokens and asserts 4.5:1 for every pairing the UI uses.
Touch targets are at least 44 px and no page scrolls sideways at 375 px (measured in a real browser on every page).

Fonts: Inter (everything, including headings and figures) and Space Mono (report IDs). Both are free Google Fonts. The condensed uppercase heading font used at first was dropped.

## Charts and the visual layer (`frontend/src/components/charts`, `styles/charts.css`)

Charts are drawn by hand as SVG and CSS (no charting library, so no new dependency and a small bundle). Each is a small component with its
arithmetic in `lib/chartMath.js` and `lib/summaries.js`, where it is unit-tested.

| Chart | Draws | Where | Who sees it |
|---|---|---|---|
| Ring (`Donut`) | Latest refresh status; credits vs hosting; spend with and without an owner | Overview | all; the two spend rings need cost access |
| Bars (`StackBars`, `BarList`) | Open alerts by severity; biggest spenders (idle part marked); cost per view and idle spend rankings; rows used vs set aside and why; AI verdicts by writer; how breaching readings became alerts | Overview, Alerts, Costs, Data quality, AI review | by the page's own role rules |
| Line (`LineChart`) | Load time with the 15 s limit and failed refreshes marked; views; peak concurrent users | Report detail | all |
| Scatter | Claimed against implied credits, with the "they agree" diagonal | Costs | admin |
| Fleet map | One tile per report: latest refresh, and a dot when its latest load time is over the limit | Overview | all (an owner sees only their reports) |

Rules every chart follows:
- **Never colour alone.** Every value is also written as text beside it. Statuses have symbols (tick, cross, clock, question mark on the map;
  diamond for a failed refresh and a hollow circle for unknown on the line; diamond for a disagreeing report on the scatter).
- **Readable without sight.** Each chart has a text summary of its numbers as its accessible name; decorative bars and legends are hidden from
  assistive technology so nothing is read twice; the cost chart has a "View the numbers as a table" disclosure (built only when opened).
- **Colour contrast.** Chart colours are the "ink" tokens in `charts.css`, each checked for 3:1 against the card (the bar for graphics) in
  `contrast.test.js`. The brand orange itself is too pale to draw with on a card (2.8:1), so charts use the strong orange.
- **Real size.** SVG charts are drawn at their real pixel width (measured, with a resize observer), so axis text stays 11-12 px on a phone instead
  of shrinking with the picture.
- **Motion** is a short grow or fade, and is switched off for people who ask for reduced motion.

The page also has a line-icon set (`Icon.jsx`) for the menu, KPI cards and empty states, small meters under the KPI figures, and a severity edge on
alert rows. A line chart shows a dark tooltip for the reading under the mouse, a touch, or the arrow keys, and says the reading aloud for screen readers.

## Intellectual-property rules

- No Everpure/Pure Storage logo, product imagery, marketing copy, or the proprietary "Pure Sans" font.
- The product is named "Pure Insights Command Center" and described as a candidate project, never as an official Everpure product.
- Colours and spacing are reproduced only as a visual style. Check the built UI for any copied asset before sharing it (Phase 7).
