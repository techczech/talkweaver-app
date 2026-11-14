---
title: Section colours overlays
subtitle: Everything that can sit on a lead ground
author: A. Speaker
event: Example Day
web: example.org
---

<!--
Neutral fixture for scripts/test-section-colours-overlays-dom.mjs. The test compiles it once per lead
(`section-colours: <lead>`), so every slide here is drawn in each of the five leads, and walks every state measuring
the contrast of each piece of text and each icon against the ground painted under it. The sections carry an
audience section timer, so the floating countdown sits over every slide below them.
-->

# Section colours overlays {icon=lucide:bot}

## The first section
{timer=5min}{timer-audience}

### A statement with a link, code and **key** words
{statement}

Read [the guide](https://example.org/guide), run `npm test` and keep the **notes** before Monday.

### Several statements in turn
{statement}{focus}

The model proposes the next step.

The harness checks that it is allowed.

The tool runs and reports back.

### A quote on the field
{statement}

> The loop is what makes a model an agent.
> — A. Person, *Notes on agents*

### The rail with a QR code
{sidebar}

- Scan the code to open the page
- The address sits under it

[QR: https://example.org/a-rather-long-address/for-the-qr-code | example.org/a-rather-long-address/for-the-qr-code]

### Icons beside the rail
{iconlist}{reveal}

- Search files {icon=lucide:search}
- Search the web {icon=lucide:globe}
- Run commands {icon=lucide:terminal}
- Write scripts {icon=lucide:file-code}

### A countdown under the title tab
{countdown-digits-90s}{titletop}

Discuss with your neighbour what you would hand to an agent first.

### Which tool do you reach for first?
{poll=single}

- A notebook
- A chat assistant
- A search engine

## The second section
{timer=5min}{timer-audience}

### A kicker title on the field
{statement}{titlelook=kicker}

Everything on the field takes the field's type colour.

### A title tab over a chart
{chart=bar}

- Model A: 71
- Model B: 64
