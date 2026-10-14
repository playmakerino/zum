# Cloning the Shopify admin (Polaris) look: guide for another project

Written 2026-10-14 from the 3 Meta Ads dashboards (`dashboards/shared/shared.css` + `shared.js` is a working reference implementation). All numbers below were **measured** on admin.shopify.com → Analytics → Reports with `getComputedStyle`, not guessed. Paste this file (or the "Rules" + "Tokens" sections) into the other project's CLAUDE.md or prompt.

## Rules (how to work)

1. **Measure, don't eyeball.** Open the real Shopify page (Claude in Chrome), read computed styles for every component you clone, then measure your own page the same way and compare the numbers in a table. "Looks close" is not done.
2. **Shopify uses web components with shadow DOM.** Walk shadow roots when measuring:
   ```js
   function* walk(root){const tw=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);let n=tw.currentNode;while(n){if(n.nodeType===1)yield n;if(n.shadowRoot)yield* walk(n.shadowRoot);n=tw.nextNode();}}
   const all=[...walk(document)];
   const own=el=>[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();
   const el=all.find(e=>own(e)==='Export');   // then climb parentElement || getRootNode().host
   ```
   The painted background is often on an inner `<span>` layer, not on the `<button>`; find elements with the same rect and read each one's `background-color` / `box-shadow`.
3. **Read Polaris tokens directly** from `:root` (`--p-color-*`, `--p-border-radius-*`, `--p-space-*`), e.g. `getComputedStyle(document.documentElement).getPropertyValue('--p-color-text-link')`.
4. **Check the small things too**: scrollbar, tooltip, menus/popovers, focus ring, link color, hover/active states, empty state, footer row, sticky behaviour, row hover (Shopify has none).
5. **Load Inter with the full weight range** (`family=Inter:wght@400..700`). A missing weight (450/600/650) gets faux-bolded and looks smeared. ShopifyInter is not public; Inter is the closest.
6. **Never write `font: 500 13px/20px inherit`**: `inherit` is not valid inside the `font` shorthand, the whole declaration is dropped and controls fall back to Arial. Use `font-family: inherit` separately.
7. **Native `<select>` menus cannot be styled.** Draw a custom pill + popover menu and keep the native select hidden as the source of truth (`.value`, `onchange`); see `dropdown` in `shared.js`.
8. **Don't use the native `title` tooltip**; draw a dark hover card (`data-tip` / `data-tip-title`).
9. **No em dashes in UI text.**

## Tokens

| What | Value |
|---|---|
| Font | Inter, 13px / 20px, letter-spacing −1% (`-.01em`) |
| Text | `#101010`; secondary `#616161`; placeholder `#4a4a4a` |
| Page background | `#fff` on Reports (cards are separated by shadow, not by a grey page) |
| Lines | row/header lines `#f2f2f2`; general border `#ddd` / `#e3e3e3` |
| Hover surface | `#f7f7f7`; selected `#ebebeb`; summary row `#f2f2f2` |
| Transparent hover / active | `rgba(0,0,0,.08)` / `rgba(0,0,0,.13)` |
| Link | `#1650d0`, hover `#1347b9` |
| Focus ring | `#5083f0` |
| Inverse surface (tooltip, toast) | `#1b1b1b` |
| Card | `background:#fff; border-radius:20px; box-shadow:0 0 2px rgba(0,0,0,.24),0 2px 12px rgba(0,0,0,.02),0 4px 16px rgba(0,0,0,.02),0 4px 48px rgba(0,0,0,.02)` |
| Page gutters | 16px; 12px between cards |

## Components

**Page header (top bar)**: 52px, sticky, transparent with no line at the top of the page; once scrolled it gets `background:#fff` and `box-shadow:0 1px 0 rgba(0,0,0,.07)` (toggle a `scrolled` class on `body` from a scroll listener). Left: title 13px/28px weight 500, letter-spacing −2%, then a grey 13px note ("Last refreshed …"). Right: actions.

**Header button** (Export / Print): height 28px, `border-radius:9999px`, `padding:4px 12px 4px 6px`, `gap:2px`, 16px icon in a 20px box (`margin:2px`), white, no border, `box-shadow:0 0 0 1px rgba(0,0,0,.07),0 2px 20px rgba(0,0,0,.03),0 5px 20px rgba(0,0,0,.03),0 8px 60px rgba(0,0,0,.03)`, text 13px weight 500.

**Filter pill** ("Last 30 days ⌄"): same geometry as the header button, `background:#ebebeb`, hover `#e3e3e3`, open `#d4d4d4`, 16px leading icon, 12px chevron, text 13px weight 450.

**Menu / option list**: popover `background:#fff; border-radius:16px; padding:6px; box-shadow:0 0 0 1px rgba(0,0,0,.08),0 4px 12px rgba(0,0,0,.08),0 12px 32px rgba(0,0,0,.1)`. Items 32px tall (`padding:6px 8px`), 13px/20px, `border-radius:12px`, hover `#f2f2f2`, selected `#ebebeb` + weight 600 + a ✓ on the right.

**Search field** ("Search dimensions"): height 30px, `border-radius:12px`, white, `padding:0 12px` with a 16px magnifier on the left, 13px/20px text, placeholder `#4a4a4a`, no border; `box-shadow:0 2px 3px -1px rgba(0,0,0,.04),0 3px 4px -1.5px rgba(0,0,0,.04),0 0 0 1px rgba(0,0,0,.13)`. Focus: `box-shadow:0 2px 3px -1px rgba(0,0,0,.04),0 3px 4px -1.5px rgba(0,0,0,.04),0 4px 5px -2px rgba(0,0,0,.04),0 0 0 1px #5083f0,0 0 0 3px rgba(53,115,246,.06),0 4px 20px 2px rgba(53,115,246,.06),inset 0 0 8px 1px rgba(53,115,246,.05)`.

**Table (report)**:
- Card first row (e.g. flat/nested toggle, your filters/tabs): 44px, `padding:8px`.
- Header row 36px + 1px `#f2f2f2` line; text **12px/18px** weight 400, sorted column weight 600. The sortable label is a transparent button (`padding:1px 4px; border-radius:6px`, hover `rgba(0,0,0,.08)`) with a 16px up/down chevron shown on hover and on the sorted column.
- Summary (total) row directly under the header, inside the sticky header, `background:#f2f2f2`, weight 600, 36px + 1px line.
- Body rows exactly 36px: cells `padding:8px 12px`, text 12px/18px. Draw the row line as `box-shadow: inset 0 -1px 0 #f2f2f2` (not a border: borders add 1px and, with `border-collapse`, do not move with a sticky header and leave a see-through gap). No hover tint on rows.
- Numbers right-aligned, `font-variant-numeric: tabular-nums`. Every dimension (text) column has a 1px `#f2f2f2` divider on its right.
- Footer row ("39 rows"): `padding:8px`, top line `#f2f2f2`, 13px/20px `#101010`, centred. Give it a fixed min height so it does not jump when empty, and drop the last body row's line so there is only one line above it.
- Page scrolls, not the table; `thead { position: sticky; top: <top bar height> }`.

**Column filter card** (report "Filters"): header 32px, `#f7f7f7`, 13px weight 500. Condition chips 22px, `padding:2px 6px`, `border-radius:8px`, `#ddd`, 12px/18px. The value chip opens a popover: 30px input (13px/20px, `padding:5px 12px`, blue focus ring), footer "Clear" as a link and a dark 28px "Apply" button.

**Tooltip**: `position:fixed; max-width:280px; padding:12px; border-radius:12px; background:#1b1b1b; box-shadow:0 8px 24px rgba(0,0,0,.25)`; bold title 13px weight 600, body 13px/20px `#e3e3e3`; below the element, above when there is no room; no arrow.

**Scrollbar**: `::-webkit-scrollbar{width:11px;background:#fff}`; thumb `border:2px solid transparent; border-radius:12px; background-clip:content-box`, transparent until the area is hovered, then `#8c8c8c` (`:hover::-webkit-scrollbar-thumb`). Also set `::-webkit-scrollbar-thumb:hover, :active` so the thumb does not vanish while the pointer is on the scrollbar itself.

## Gotchas met on the way

- A Total row placed in `<thead>` with a `colspan` label shifts `td:nth-child(n)` rules onto the wrong columns. Scope column-width rules to `tbody td`.
- With `table-layout: fixed`, percentage widths on some columns spread the leftover width into the fixed columns. Give the short columns fixed widths and leave the long text columns without a width.
- `position: sticky` stops working under any ancestor with `overflow: hidden/auto`; if wide tables need sideways scroll on small screens, the header then sticks to the table, not the page.
- Shared CSS across several deploy targets: keep one source, copy it with a script, and load per-project overrides (breakpoints) after the shared file.
