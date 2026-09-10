---
name: IdentiK
description: A security architecture drawn as a live engineering sheet.
colors:
  paper: "#e8e9e3"
  paper-raised: "#f4f4ef"
  paper-inset: "#dfe1d9"
  ink: "#16181b"
  ink-secondary: "#3c424a"
  ink-tertiary: "#62686f"
  rule: "#b7bbb2"
  rule-strong: "#989e94"
  signal: "#b52c17"
  signal-bright: "#e2553c"
  field: "#0f1216"
  field-ink: "#e3e4dd"
typography:
  display:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Barlow, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Barlow Condensed, Barlow, sans-serif"
    fontSize: "0.68rem"
    fontWeight: 600
    letterSpacing: "0.11em"
  mono:
    fontFamily: "Martian Mono, ui-monospace, monospace"
    fontSize: "0.72rem"
    fontWeight: 400
    letterSpacing: "-0.01em"
rounded:
  none: "0"
  hairline: "2px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "26px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-raised}"
    rounded: "{rounded.hairline}"
    typography: "{typography.label}"
    padding: "11px 16px"
  button-primary-hover:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.paper-raised}"
  button-quiet:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline}"
    padding: "5px 10px"
  field-input:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline}"
    padding: "10px 12px"
  register-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper-raised}"
    rounded: "{rounded.hairline}"
    padding: "1px 5px"
  credential-row:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.hairline}"
    padding: "7px 10px"
---

# Design System: IdentiK

## Overview

**Creative North Star: "The Control Drawing"**

IdentiK's interface is a live engineering sheet: the Organization's security architecture drawn to scale. A title block heads the page, an indexed register runs down the left edge, and the field holds a single-line diagram of the trust boundary — two populations in separate lanes, Applications tapped off a bus, one Application expanded into its concurrent-secret credential tree. The drawing is not a metaphor pasted over a dashboard; it is the information architecture. Every audit event lands in a numbered revision log, and every revocation is a cut.

The world is paper, not glass. The ground is a cool drawing-paper gray-green, the ink is graphite, and depth is conveyed by hairlines and the one full-bleed dark instrument band that carries a live authentication trace. Against that restrained field a single revision-red signal does the work of authority: active state, the cut, the primary hover. It is infrastructure software for people who think in schematics; the design earns trust by being exact, legible, and unornamented, never by looking "secure" with dark chrome.

**Key Characteristics:**
- A drawing sheet — title block, indexed register, bounded field, revision log — not a sidebar-plus-cards admin shell.
- Drawing paper ground with graphite ink; exactly one saturated signal (revision red).
- Technical lettering: a squared grotesque for UI, a condensed face for drawing labels, a wide mono reserved for codes, serials, and measurements.
- Flat by construction: 1.5px black borders and hairline rules, no shadows, near-square corners.
- One authored motion: the cut.

## Colors

A three-role palette — paper, ink, and one signal — read at page scale.

### Primary
- **Revision Red** (#b52c17): the single accent. Primary button hover, active navigation index, revoked state, the cut line, and focus rings. It marks authority and irreversible action, never decoration.
- **Signal Bright** (#e2553c): the red rendered for the dark instrument field only, where the base signal lacks contrast. Used for the live authentication trace and the live indicator.

### Neutral
- **Drawing Paper** (#e8e9e3): the page ground of every sheet.
- **Raised Paper** (#f4f4ef): the working surface inside a sheet — inputs, credential rows, node boxes.
- **Inset Paper** (#dfe1d9): secondary bands, the title-block cells, the schematic header.
- **Graphite Ink** (#16181b): primary text, the primary button fill, focused borders, and the fill of the dark instrument band.
- **Ink Secondary** (#3c424a): body copy, labels, secondary values.
- **Ink Tertiary** (#62686f): hints, disabled values, drawing annotations, placeholder text.
- **Steel Rule** (#b7bbb2) and **Steel Rule Strong** (#989e94): hairlines between rows, panels, and registration cells.
- **Instrument Field** (#0f1216): the one dark full-bleed band; the authentication trace's ground.
- **Field Ink** (#e3e4dd): text and trace on the dark band.

### Named Rules
**The One Signal Rule.** Exactly one saturated hue exists. Anything that needs a second accent is using state that should be a label, a line style, or weight instead. Accent covers well under a tenth of any screen.

**The Honest Ground Rule.** The ground is cool paper, never warm cream and never blue-black slate. Depth comes from hairlines and the one dark band, not from darkening the page.

## Typography

**Display Font:** Barlow (with system-ui fallback)
**Body Font:** Barlow (with system-ui fallback)
**Label Font:** Barlow Condensed (with Barlow fallback)
**Mono Font:** Martian Mono (with ui-monospace fallback)

**Character:** One squared grotesque carries the interface; a condensed cut handles drawing labels the way a title block is lettered; a wide, squarish mono is reserved strictly for machine data — client IDs, secret labels, UUIDs, timestamps, validity windows.

### Hierarchy
- **Display** (600, 1.5rem, 1.15, -0.015em): sheet headings (`Trust Boundary`, `Applications`). One per field.
- **Headline** (600, 1.125rem, 1.15): section heads within a sheet.
- **Title** (600, 1rem, 1.15): Application names, lane names.
- **Body** (400, 15px, 1.5): explanatory copy, entity names, revision actions.
- **Label** (600, 0.68rem, 0.11em, uppercase): drawing labels, form labels, title-block keys, state tags.
- **Mono** (400, 0.72rem, -0.01em): Client IDs, secret labels, actor IDs, and every stamp.

### Named Rules
**The Measurement Rule.** Monospace is not a costume for "technical". It appears only where the value is a code, a serial, a duration, or a timestamp — never for prose, headings, or labels that the condensed face owns.

## Layout

Every dashboard page is one bordered sheet at a 1340px maximum, inset from the viewport, with an inner hairline border 5px inside the edge. A title block spans the head: the Organization at left, then `SHEET`, `REV`, `DATE`, and `STATUS` cells separated by rules. Below it the sheet splits into a 236px register rail and a fluid field. The field is a single column; content groups under section heads separated by full-width rules. Sheets run on a 4/8/16/26/40 rhythm, with more space above a heading than below it.

Responsive behavior is structural, not fluid type. At 860px the register becomes a wrapping row above the field, the title-block cells reflow to a two-column grid the drawing can read at mobile width, the schematic lanes stack, credential and secret rows place their validity and state on their own lines, and the revision log collapses to two columns. Type sizes never change with viewport.

## Elevation & Depth

Flat by construction. There are no shadows anywhere in the system; a zero-offset glow or a soft drop shadow would read as a different world. Depth is conveyed by rule weight — a 1.5px black sheet and panel border against 1px steel hairlines against the single dark instrument band — and by the paper's three tonal steps. Focus is a 2px revision-red outline with a 1–2px offset, never a shadow.

### Named Rules
**The Hairline Rule.** Declare elevation once: a border or a rule, never both around the same element. Cards, panels, and rows are flat at rest and do not lift on hover; hover changes fill, never height.

## Shapes

Near-square drafting geometry. Radii cap at 2px (`{rounded.hairline}`); the sheet border is 1.5px and everything else is a 1px hairline. There are no pills, no rounded-corner cards, no circular avatars. The recurring silhouettes are the ruled band (title block, signal band, section head), the bracketed panel (boundary, lane, node), and the ruled row (revision log, credential, secret). A revoked credential is the one deliberate exception: a 1.5px revision-red break-line animates across it — the cut.

## Components

### Buttons
- **Shape:** near-square (2px radius), 1.5px ink border, no shadow.
- **Primary:** solid graphite ink on raised paper, uppercase condensed label at 0.82rem with 0.06em tracking, 11px × 16px padding. Full width in forms; auto width inline.
- **Hover / Focus:** fill and border shift to revision red; focus is a 2px red outline with 2px offset. Disabled drops to 50% opacity and does not redden.
- **Secondary (quiet):** transparent with a 1px ink border, 0.68rem uppercase; inverts to solid ink on hover. Reserved for row-level actions like `Revoke`.

### Inputs / Fields
- **Style:** raised paper fill, 1px steel-strong border, 2px radius, 10px × 12px padding; labels are condensed uppercase above the control.
- **Focus:** 2px revision-red outline with a 1px offset and an ink border.
- **Disabled:** inset paper fill, tertiary text, not-allowed cursor. Placeholders are tertiary, never lower-contrast.

### Navigation
- **Style:** the register rail is a vertical index of sheets, each entry a mono index character (`A`–`E`) and a label. The active sheet is marked by inverting its index cell to solid ink — never a colored side stripe. The rail is separated from the field by the same 1.5px sheet border. Below the index, a sign-out cell carries the signed-in Administrator Role.

### Sheet & Title Block
- **Style:** the title block is a ruled band of key/value cells (`SHEET`, `REV`, `DATE`, `STATUS`) with the Organization at left. Revision count and issue date are live. This is the page header; there is no separate app bar.

### Credential Tree & The Cut
- **Style:** an Application's concurrent secrets render as ruled rows: a stroke ink mark, the label, the validity window in mono (`created → open` or `created → revoked`), and a state tag. A revoked row dims to tertiary and, on entry, draws a 1.5px revision-red break-line across itself with `cubic-bezier(0.16, 1, 0.3, 1)` over 320ms. A cut is confirmed by a mono note pointing to the revision log.

## Do's and Don'ts

### Do:
- **Do** frame every dashboard surface as a sheet with a title block and a live revision count.
- **Do** reserve revision red for authority and irreversible action; let state elsewhere be carried by weight, line style, and labels.
- **Do** set every Client ID, secret label, timestamp, and duration in mono with tabular numerals.
- **Do** keep the schematic grid only on measurement surfaces — the trust-boundary diagram and the hosted sheet ground — where it functions as drafting paper.
- **Do** give every state a text or line-style equivalent so color is never the sole signal.

### Don't:
- **Don't** introduce a second accent, a gradient, glass, or a blur; the ground is paper and the ink is flat.
- **Don't** add drop shadows, halos, or hover lift; elevation is borders and rules only.
- **Don't** round corners past 2px or use pills; the form language is drafted, not friendly-rounded.
- **Don't** use a colored side stripe to mark selection; invert the index cell instead.
- **Don't** set prose in monospace, or a display face in labels and data.
