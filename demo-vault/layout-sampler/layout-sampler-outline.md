---
title: "TalkWeaver **Layout Sampler**"
subtitle: "Every registered layout in one compiler-backed deck."
series: TalkWeaver
event: Layout sampler
author: TalkWeaver
date: 18 July 2026
colour: cobalt
outline_version: 2
---
# TalkWeaver Layout Sampler

<!--
Purpose (ADR-0006): every registry layout exactly once + structural variations.
This Talk is the visual-regression fixture, the manual QA deck for design changes,
and the layout demo. A registry entry without a slide here fails the parity test.
Content is REAL (drawn from the "AI and Expertise" keynote the ADR-0005 mockups
were designed against) so the design can be judged on realistic slides.
Coverage hooks: each registry entry name must appear in the slide id/title or be
the slide's layout — keep the entry term in the heading for modifier/element slides.
Trigger syntax is compiler-validated: keep the **Timeline:** blocks, the
"A / B" contrast pairs, and the {role=section-title} divider exactly as shaped.
-->

## Everyday
{id=tmjuq}

### Nobody can change your brain for you
{statement} {id=785m6}

### AI intern can help you draft your schedules and manage your calendar
{reveal}{id=w54t4}

### Clear thinking matters
{titletop}{id=2mifq}

### Statement default variant — current treatment
{statement=default} {id=zky0l}

The default statement remains an oversized claim with a centred block.

### Statement tint variant — panel and accent bar
{statement=tint} {id=lokzg}

The tint panel gives a claim **presence** without turning it into a quote.

### Statement poster variant — oversized boxed claim
{statement=poster} {id=gb2c3}

One **boxed phrase** can carry the whole poster.

### The knowledge you need today
{list} {id=kh0hy}

- How your computer works
- Principles of software architecture
- The developer-tools landscape
- How AI agents work
- What is possible with software

### The LLM is a universal translator (icon list)
{iconlist} {id=tapq4}

- language-to-language {icon=lucide:message-square}
- style-to-style {icon=lucide:pen-line}
- unstructured to structured {icon=lucide:boxes}
- text to code {icon=lucide:terminal}
- image to text {icon=lucide:image}
- question to answer {icon=lucide:message-circle-question-mark}
- problem-to-plan {icon=lucide:puzzle}

### Icon list boxes variant — cards and mono numbers
{iconlist=boxes} {id=udng3}

- Translate {icon=lucide:languages}
- Structure {icon=lucide:boxes}
- Build {icon=lucide:hammer}

### Icon list list variant — plain icon rows
{iconlist=list} {id=qm593}

- Translate {icon=lucide:languages}
- Structure {icon=lucide:boxes}
- Build {icon=lucide:hammer}

### Background cobalt variant — readable cobalt tint
{bg=cobalt} {id=e4giq}

- The slide uses the cobalt tint
- The section accent remains independent

### Background emerald variant — readable emerald tint
{bg=emerald} {id=lden4}

- The slide uses the emerald tint
- The section accent remains independent

### Background vermilion variant — readable vermilion tint
{bg=vermilion} {id=g8qsh}

- The slide uses the vermilion tint
- The section accent remains independent

### Background forest variant — readable forest tint
{bg=forest} {id=onme0}

- The slide uses the forest tint
- The section accent remains independent

### How to work with an agent (numbered)
{numbered} {id=c6kn3}

- Describe the outcome, not the steps
- Give it the context a new colleague would need
- Let it work, then verify the result end to end
- Capture what you learned for the next run

### Quote
{quote} {id=tqgix}

> AI democratises **capability**. It does not democratise **judgment**.

- Alex LeBlanc, "AI amplifies expertise, not replaces it"

### Quote width — about 100 characters
{quote}{id=quote-width-100}

> A short quotation should keep the full display type while using the narrowest panel in the responsive width ramp.

- Layout sampler, short quotation

### Quote width — about 220 characters
{quote}{id=quote-width-220}

> A somewhat longer quotation should gain horizontal room instead of losing type size. The panel should widen against the stage while the words retain the same readable display size, line height, mark, padding, rule and attribution proportions.

- Layout sampler, medium quotation

### Quote width — about 330 characters
{quote}{id=quote-width-330}

> A longer quotation still uses the same display type. More words increase the width of the panel, but the readable measure remains capped so the quotation gains lines instead of turning into one overlong line that is difficult to follow across the stage. The attribution remains inside the panel and keeps the same relationship to the quotation.

- Layout sampler, long quotation

### Quote width — about 600 characters
{quote}{id=quote-width-600}

> A substantially longer quotation reaches towards the wide end of the panel ramp while preserving the base display type whenever the complete panel still fits the stage. The width responds to the amount of text, not to a typography bucket. The line measure remains deliberately bounded, the quotation mark keeps its scale, the accent rule remains stable, and the attribution stays inside the panel. This fixture contains enough prose to expose the old behaviour in which a character threshold made both the type and the resulting panel smaller at once, even though the additional words needed more room rather than less.

- Layout sampler, very long quotation

### Quote width — about 900 characters
{quote}{id=quote-width-900}

> The longest sampler quotation reaches the maximum panel width before any reduction in type is allowed. At that point the renderer may step the quotation down only as far as the thirty-one pixel accessibility floor, and only when the panel would otherwise exceed the available stage height. The panel still keeps a readable measure, which means the extra words create additional lines instead of an excessively long scan. If the complete quotation, its proportional padding, its quotation mark and its attribution still cannot fit at the floor, the compiler must report quote-too-long for this slide. That warning makes the exceptional case visible to the author rather than silently shrinking the words below the design floor or relying on whole-slide zoom. This fixture is intentionally verbose enough to exercise that decision at both the sixteen-hundred by nine-hundred stage and the smaller twelve-eighty by seven-twenty stage used by TalkWeaver previews and captures.

- Layout sampler, maximum quotation

### Real-deck quote — Stephen King
{quote}{id=quote-real-stephen-king}

> "I want to suggest that to write to your best abilities, it behooves you to construct your own toolbox and then build up enough muscle so you can carry it with you. Then, instead of looking at a hard job and getting discouraged, you will perhaps seize the correct tool and get immediately to work."

- Stephen King, On Writing

### Real-deck quote — Dean W. Ball
{quote}{id=quote-real-dean-ball}

> "By the end of this year, the least important thing you will be able to do with frontier AI systems will be getting chatbots to answer questions."

- Dean W. Ball, Among the Agents, 9 Jan 2026

### Contrast — cards variant
{contrast=cards} {id=w4pwn}

- Complex algorithms / How your computer works
- Syntax of computer languages / Principles of software architecture
- Variables, functions, etc. / The developer-tools landscape
- How to use developer tools / How AI agents work

### What kind of judgment do you need (annotated)
{annotated} {id=g11jj}

- Fast judgment — recognising what something is, sensing a problem
- Slow judgment — backtracking through a problem step by step
- Taste — knowing which of two working answers is better
- Calibration — knowing when to trust the model and when to check

### Why are you studying at university (sidebar title)
{sidebar} {id=25h9z}

- Change your brain
- Change the world
- Prove to the authorities you can pass an exam

### Image
{media} {id=2uu9t}

![](assets/sample-image.png)

### Media row — video and image
{id=l7aie}

[Video: https://example.com/media-row.mp4]

![Landscape screenshot](assets/placeholder-landscape.png)

### Media row — measured 4:3 video and image
{id=media-row-measured-video}

[Video: assets/media-row-4x3.mp4]

![Landscape screenshot](assets/placeholder-landscape.png)

### Media row — image, video and image
{id=gmfhb}

![First landscape screenshot](assets/sample-image.png)

[Video: https://example.com/media-row.mp4]

![Second landscape screenshot](assets/placeholder-landscape.png)

### Media row — portrait and landscape
{id=43l2a}

![Portrait screenshot](assets/placeholder-portrait.png)

![Landscape screenshot](assets/placeholder-landscape.png)

### Media gallery — four mixed media
{id=h4019}

![Portrait screenshot](assets/placeholder-portrait.png)

[Video: https://example.com/media-row.mp4]

[Embed: https://example.com]

![Landscape screenshot](assets/placeholder-landscape.png)

### Media slot — list, video and image
{id=5i55e}

- The video and image share the media column.
- The two figures remain stacked beside this list.

[Video: https://example.com/media-row.mp4]

![Landscape screenshot](assets/placeholder-landscape.png)

### Image beside copy — left
{list}{image=left} {id=l8q3x}

![](assets/sample-image.png)

- Copy stays vertically balanced beside the media slot

### Image beside copy — right
{list}{image=right} {id=1zgi1}

![](assets/sample-image.png)

- The registered media-placement option flips the slot

### Quiet layout title restored
{quote}{title=show} {id=ibrjl}

> A title can be visible when the layout normally keeps it for navigation only.

### Compact title
{cards}{title=compact} {id=1x63m}

- Compact
- Registered

### Contrast: cognition vs tools
{contrast} {id=xp2hi}

- Judgement and knowledge / Precision and exact retrieval
- Comparison and estimation / Complex conditionals
- Recognising patterns / Precise calculation

### Contrast ledger variant
{contrast=ledger} {id=oseoi}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### Contrast rows variant
{contrast=rows} {id=hu678}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### Contrast tint variant
{contrast=tint} {id=6hlqs}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### Contrast flip variant
{contrast=flip} {id=h8nn6}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### What LLMs can and cannot do (compare)
{compare} {carousel} {id=9s8gv}

#### What LLMs can do for you
{id=gb1oh}

Be a **ramp** to higher learning.

#### What LLMs cannot do for you
{id=q42im}

The learning.

### Use AI as a ramp to higher learning (copy + visual)
{copy-visual} {id=qwey9}

![](assets/sample-image.png)

The amount of time and effort required to change your brain is constant. AI can clear the ramp — finding resources, building scaffolding, giving feedback — but nobody can climb it for you.

### Three roles of AI (cards)
{cards}{icons} {id=ijfli}

- AI as Oracle {icon=lucide:brain-circuit}
  - answer questions, summarise, translate
- AI as Tool Maker {icon=lucide:hammer}
  - write code, build dashboards and workflows
- AI as Tool User {icon=lucide:bot}
  - plan, work with files, run utilities
- AI as Coach {icon=lucide:graduation-cap}
  - feedback, scaffolding, deliberate practice
- AI as Librarian {icon=lucide:library}
  - find, organise and connect sources
- AI as Simulator {icon=lucide:orbit}
  - rehearse conversations and scenarios

### Three roles of AI (rows)
{cards=rows} {carousel} {id=wh3f1}

#### AI as Oracle
{icon=lucide:brain-circuit}{id=kyxem}

- Capabilities: answer questions, summarise, translate
- Chatbots: ChatGPT, Gemini, Claude
- Specialist apps: NotebookLM, Elicit, Consensus

#### AI as Tool Maker
{icon=lucide:hammer}{id=osl3x}

- Capabilities: write code, manage a code base
- Outcomes: scripts, dashboards, simulations, workflows
- Tools: Cursor, Lovable, Google AI Studio

#### AI as Tool User
{icon=lucide:bot}{id=herfh}

- Capabilities: plan, work with files, run utilities
- Outcomes: ambitious projects, manage data, replicate analyses
- Desktop agents: Codex, Claude Code, Antigravity

### A month with agents (carousel)
{carousel} {id=z5qhq}

#### Scheduled my calendar
{id=i3mu4}

Codex read the invitation thread, found the gaps, and booked the travel time around them.

#### Built my own slide tools
{id=9tvp4}

The presentation system this very deck runs on — outlines in, talks out.

#### Rescued old websites
{id=dkste}

Fifteen years of abandoned HTML, migrated and republished in an afternoon.

## Structural
{id=51xol}

### Title slide
{title} {id=x1o0q}

TalkWeaver Layout Sampler

## Section divider
{role=section-title} {id=gbqut}

### Section divider child
{id=a2w0h}

- Every section carries its own accent colour — the audience always knows where they are.

### subsection — what a new expertise looks like
{sub} {carousel} {id=j98zh}

#### Child slide
{id=8bxj7}

- The parent renders as a subsection divider under the current section.

### Bare heading with children
{carousel} {id=080ky}

#### Bare heading child
{id=kbqzg}

- The bodyless parent remains a subsection divider because it has a child heading.

### The ChatGPT timeline — rail
{timeline=rail}{reveal} {id=71top}

- 30 Nov 2022
  - ChatGPT is released as a research preview
- 7 Dec 2022
  - 1 million people have used it — faster than any consumer product before
- 2023–2024
  - Hundreds of millions use it to code, write, translate, learn and cheat
- Sept 2025
  - 1 billion people use ChatGPT every week
- 2026
  - AI agents happen

### Timeline — columns
{timeline=columns} {id=byjc2}

**Timeline:**

- Research
  - 2022: ChatGPT launches
- Adoption
  - 2024: Mass use
- Scale
  - 2025: A billion weekly users
- Agents
  - 2026: Multi-step work

### Timeline — compact
{timeline=compact} {id=qnjl5}

- 2022: ChatGPT launches
- 2023: GPT-4 arrives
- 2024: Tool use expands
- 2025: Weekly use reaches a billion
- 2026: Agents take multi-step work

### Timeline — vertical
{timelinevertical} {id=rkkhs}

**Timeline:**

- 30 Nov 2022
  - ChatGPT released
- Dec 2022
  - 1 million users in five days
- Sept 2025
  - 1 billion weekly users
- 2026
  - AI agents happen

### Timeline — horizontal
{timelinehorizontal} {id=jz0qb}

**Timeline:**

- 2022
  - ChatGPT released
- 2024
  - Mass adoption
- 2025
  - 1 billion weekly users
- 2026
  - AI agents happen

### Timeline — spine
{timelinespine} {id=xto0c}

**Timeline:**

- 2022
  - Release
- 2024
  - Adoption
- 2025
  - A billion a week
- 2026
  - Agents

### Timeline — pills
{timeline-pills} {id=3bdkr}

**Timeline:**

- 2022
- 2023
- 2024
- 2025
- 2026

### Timeline — dynamic
{timelinedynamic}{reveal} {id=m0o3z}

- 2022
  - ChatGPT released as a research preview
  - A research preview becomes a product overnight
- 2023
  - GPT-4, plugins and the first tools
  - Tool use turns a chat box into a worker
- 2024
  - Agents take multi-step work
  - Long-running tasks stop needing a human at every step

### sidebar-40 — pinned rail width
{sidebar-40} {id=1cma0}

- Wide rail shortens the text measure
- 30 and 35 and 50 are the other stops

### font-body — per-slide type override
{font-body=l}{font-title=s} {id=f1hwb}

- Body steps up one size
- The title steps down one

### novalues — effort, shape only
{barchart}{novalues} {id=q5g1n}

- Organising your life: 15
- Finding resources: 20
- Learning subject: 40

### Grid
{grid}{blocks:2x2} {id=qbq3e}

- Chatbots — ChatGPT, Gemini, Claude
- Research apps — NotebookLM, Elicit, Consensus
- Builders — Cursor, Lovable, AI Studio
- Desktop agents — Codex, Claude Code, Antigravity

### System map: the AI agent
{system-map} {id=srgdd}

- Model — judgement and language
- Harness — tools and permissions
- Context — files, history, instructions
- Channel — where you meet it

## Specialised
{id=59n60}

### Timeline with a comment
{timeline-visual} {id=pk8to}

- 2024: First draft
- 2025: Registry
- 2026: The law

The chronology stays visible while the comment provides context beside it.

### Feature list with media
{list-visual} {id=628ms}

- One
- Two
- Three

![](assets/sample-image.png)

### Strengths of cognition and tools (SmartArt)
{smartart} {id=doiyc}

- Cognition
  - Judgement
  - Knowledge
  - Comparison
  - Estimation
- Tools
  - Precision
  - Exact retrieval
  - Complex conditionals
  - Precise calculation

### From outline to talk (flow)
{flow} {id=9b7o6}

- Write the outline
- Compile the deck
- Rehearse with beats
- Present and record

### Flow — vertical
{flow}{flow=vertical} {id=c05re}

- Outline
- Compile
- Present

### Flow — loop
{flow}{flow=loop} {id=son1d}

- Draft
- Review
- Revise

### Flow — branch
{flow}{flow=branch} {id=vxcu2}

- Source
- Slides
- Handout

### Intelligence as Grep and Grok (image + claim)
{image-claim} {id=opwab}

![](assets/sample-image.png)

- Grep is retrieval — exact, literal, tireless
- Grok is understanding — fuzzy, contextual, judgemental
- You need both; so does the machine

### Try it on your own material (CTA + screenshots)
{cta-screenshots} {id=vhr8o}

![](assets/sample-image.png)

- Bring one real presentation to the workshop
- Convert it to an outline and rebuild it live
- [Action: Get the starter kit → https://example.com]

### Trace (transcript)
{trace} {id=ilf67}

```trace
User: Reorganise my Downloads folder by project.
Agent: I found 1,482 files. Grouping by the six project names in your notes — shall I move screenshots into their matching projects too?
User: Yes, and delete the duplicates.
Agent: Done. 212 duplicates removed, structure written to a manifest you can undo.
```

### Code block (ELEMENT, not slide layout — ADR-0006)
{code} {id=a3z2y}

```python
def judgement(time, effort, learning):
    """No shortcuts."""
    return time + effort + learning
```

### Three roles of AI (table)
{table}{reveal} {id=g46me}

- Capabilities
  - answer questions, summarise, translate
  - write code, manage a code base
  - plan, work with files, run utilities
- Where
  - ChatGPT, Gemini, Claude
  - Cursor, Lovable, AI Studio
  - Codex, Claude Code, Antigravity

### qr — QR code element
{id=9s0q4}

[QR: https://talkweaver.app | talkweaver.app]

### action — Action button element
{id=j0rqp}

[Action: Visit the TalkWeaver website → https://talkweaver.app]

### Embed element
{id=kl7ck}

[Embed: https://example.com]

### auto-embed (bare URL)
{id=fyds2}

https://example.com

### Logo list
{logolist} {id=2pd0u}

- OpenAI
- Anthropic
- Google
- GitHub
- Cloudflare

### Image + quote
{image-quote}{id=image-quote-width-short}

![](assets/sample-image.png)

> AI agents have crossed a threshold I didn't expect so soon. Not just impressive demos — but practical tools for daily use.

- Vivian Balakrishnan, Foreign Minister of Singapore

### Image + long quote
{image-quote}{id=image-quote-width-long}

![](assets/sample-image.png)

> A long image quotation follows the same width-first rule inside its text column. The quotation first takes the available column width while keeping the shared display size, quotation mark, padding and attribution proportions. Only after the text column is full may the type step down, and the thirty-one pixel floor remains absolute. This fixture deliberately continues beyond a normal pull quote so the renderer has to exercise its overflow path rather than a character-count typography tier. If the words, image and attribution cannot fit together at the floor, the compiler reports quote-too-long and leaves the exceptional case visible to the author. The quote never becomes an arbitrarily small caption merely because it shares the stage with an image.

- Layout sampler, long image quotation

### Image grid
{image-grid} {id=8zm6v}

![Daily use, not demos](assets/sample-image.png)

![The desktop agent at work](assets/sample-image.png)

![A month of agent output](assets/sample-image.png)

### Effort spent on learning (bar chart)
{barchart} {id=lzbwm}

- Organising your life: 15
- Finding resources: 20
- Learning skills: 25
- Learning the subject: 40

### Where the week goes (pie chart)
{piechart} {id=85nbl}

- Deep work: 35
- Meetings: 25
- Email and admin: 20
- Learning: 20

### Weekly ChatGPT users (line chart)
{linechart} {id=h49r9}

- 2022: 1
- 2023: 100
- 2024: 400
- 2025: 1000

### Block-scoped bar chart
{id=block-chart-bar}

{chart=bar}

- Alpha: 40
- Beta: 25
- Gamma: 35

### Block-scoped pie chart
{id=block-chart-pie}

{piechart}

- Deep work: 35
- Meetings: 25
- Email and admin: 20
- Learning: 20

### Block-scoped line chart
{id=block-chart-line}

{chart=line}

- 2022: 1
- 2023: 100
- 2024: 400
- 2025: 1000

### Fenced bar chart
{id=fenced-chart-bar}

```chart=bar
- Alpha: 40
- Beta: 25
- Gamma: 35
```

### Fenced pie chart
{id=fenced-chart-pie}

```chart=pie
- Deep work: 35
- Meetings: 25
- Email and admin: 20
- Learning: 20
```

### Fenced line chart
{id=fenced-chart-line}

```chart=line
- 2022: 1
- 2023: 100
- 2024: 400
- 2025: 1000
```

### Agent adoption (S-curve)
{sigmoid} {id=3avze}

- Sceptics: 10
- Daily users: 50
- Toolmakers: 90

### Workshop day (timetable)
{timetable} {id=mx1zl}

- 09:00 · Welcome and setup
- 09:30 · Outlines: from PowerPoint to Markdown
- 10:30 · Break
- 11:00 · Layouts and reveals, hands on
- 12:30 · Lunch
- 13:30 · Build your own talk
- 15:00 · Present to the room

## Diagrams
{id=12k8g}

### columns
{2col} {carousel} {id=701xv}

#### Humans
{id=dqrbs}

- Mental checklists
- Focus
- Physical objects
- Computers
- Relationships

#### Large Language Models
{id=e1g1a}

- Shell commands
- CLIs
- APIs
- Scripts
- Search

### Effort spent on learning (pyramid)
{pyramid} {id=8kqzk}

- Learning the subject
- Learning skills
- Finding resources
- Organising your life

### Org chart
{orgchart} {id=jlj9r}

- AI Competency Centre
  - Research support
  - Teaching and courses
  - Tools and infrastructure

### Mind map
{mindmap}{reveal} {id=gkw62}

- AI as Oracle
  - Capabilities
    - answer questions
    - summarise
    - translate
  - Chatbots
    - ChatGPT
    - Gemini
    - Claude
  - Specialist apps
    - NotebookLM
    - Elicit
    - Consensus

### Mermaid diagram
{id=9409q}

```mermaid
flowchart LR
  A[Draft] --> B[Feedback]
```

### SVG illustration
{id=jq5sm}

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
  <rect width="320" height="180" rx="12" fill="#f2f0ea"/>
</svg>
```

### Concept map
{conceptmap} {id=igzd9}

- Model -powers- Agent
- Agent -uses- Tools
- Tools -act on- Files
- Agent -reports to- You
- You -teach- Agent

### Stats
{stats} {id=dg7sb}

- 1 billion: people use ChatGPT weekly
- 5 days: to the first million users
- 3×: more people learning to code than 2022

### From idea to talk (process strip)
{process} {id=4ztch}

- Capture
- Outline
- Design
- Rehearse
- Deliver

### Learning any skill (steps)
{steps} {id=x9iu2}

- Follow recipes
- Adapt recipes
- Write recipes
- Forget recipes

### Two parts of ChatGPT (icon row)
{iconrow} {id=tgr7k}

- Large Language Model {icon=lucide:brain}
  - outputs tokens
  - rich knowledge and judgement
  - limited precision
- Orchestration {icon=lucide:computer}
  - parses tokens and runs them
  - absolute logic
  - no judgement at all

### How judgment is built (cycle)
{cycle} {id=nb0xz}

- Repetition
- Reflection

### No shortcuts (equation)
{equation} {id=wt09o}

- Time
- Effort
- Learning

### Equation — circles
{equation=circle} {id=caitt}

- Time
- Practice
- Fluency

### Equation — squares
{equation=square} {id=4i0fr}

- Evidence
- Judgement
- Decision

### Equation — ovals
{equation=oval} {id=4wzb2}

- Context
- Intent
- Meaning

## Modes
{id=e9u52}

### Reveal: what agents change
{reveal} {id=vhxmf}

- Work is amplified
- More people get access to that work
- Some jobs stop being jobs
- New jobs appear where judgement lives

### Group reveal
{group}{reveal} {id=ib5ri}

- These three lines arrive together
- as a single beat
- because they make one point

### Focus mode: three claims worth dwelling on
{focus} {id=obl4v}

- You live in the golden age of learning
- It is now worth learning more, not less
- There are no excuses left

### Countdown element
{countdown-digits-90s} {id=3wamn}

Discuss with your neighbour: what was the last thing you used a chatbot for?

### Which tool do you reach for first?
{poll=single} {id=2qgl8}

- A notebook
- A chat assistant
- A search engine

### trigger-line
{contrast} {id=9p7ai}

- Trigger lines keep headings clean / The same compiler vocabulary applies

### notitle
{notitle} {id=s2t03}

You cannot act in the world and look up everything. You must know things in a special way.

### titletop
{titletop} {id=svfw8}

- The title rail moves to the top
- For content that needs the full width
- Wide tables, timelines, full-bleed media

### nostep
{nostep}{reveal} {id=bffn9}

- Everything stays visible
- Even with reveal mode active
- Useful for reference slides

### plainlist
{plainlist} {id=6ja53}

- Fluency in a language
- Participation in a game
- Playing a sport
- Making music

### stmt-list
{stmt-list} {id=gzkco}

Good slow judgment needs good fast judgment.

- Fast: what something is, that something is off
- Slow: how to backtrack, how to evaluate a plan

### links
{links} {id=ephdj}

[TalkWeaver website](https://talkweaver.app)

[Example link](https://example.com)

[Another example link](https://example.org)

### chart
{chart} {id=mhb3v}

- Reading: 40
- Practice: 35
- Feedback: 25

### table-outline
{table} {id=4h21u}

- You don't need
  - Complex algorithms
  - Language syntax
  - Developer tools training
- You do need
  - Computer literacy
  - Architecture judgement
  - Agent awareness

### trace-dialogue
{trace} {id=4sl1s}

```trace
Student: Can I just use the chatbot to write the essay?
Tutor: You can. It will cost you exactly the learning the essay was for.
```

### 3col
{3col} {carousel} {id=4me2u}

#### Oracle
{id=7jybz}

- Ask
- Read
- Verify

#### Tool Maker
{id=tr4p1}

- Specify
- Generate
- Test

#### Tool User
{id=gh495}

- Delegate
- Review
- Ship

### grid-linear
{grid-linear} {id=ytpfb}

#### Fast judgment
{id=ai5oe}

- What something is, at a glance

#### Slow judgment
{id=70wjg}

- Backtracking through a problem

### grid-zoom
{grid-zoom} {id=1q28h}

#### Learning more
{id=genqu}

- Because the ramp is cleared

#### Doing more
{id=r0l6i}

- Because the tools compound

### contents
{contents} {id=r8ixg}

#### Why we are here
{id=9mtl0}

- The question behind the whole talk

#### What changed
{id=z580j}

- Agents crossed the threshold

#### What to do
{id=n80vv}

- Learn more, not less

### contents strip
{contents=strip}{carousel} {id=3ngkv}

The filmstrip footer variant (ADR-0007) — a contact-sheet of child miniatures instead of the
thin agenda rail. For sections where seeing the slides matters more than their names.

#### Strip child one
{id=8f596}

- The slides speak for themselves

#### Strip child two
{id=7ay15}

- Names would only get in the way

### multicolour
{system-map}{multicolour} {id=2rtkj}

- Repetition
- Reflection
- Feedback
- Time

## timer-audience
{timer=10min}{timer-audience} {id=0xs1r}

### Timed child
{id=3c1s2}

- The section timer is visible to the room while you work.

## accent — pinned section colour
{accent=vermilion} {id=qk832}

### Every slide in this section keeps vermilion
{id=p41z2}

- The author chooses a name
- The compiler owns the accent and tint pair

## Rendered geometry doctor
{id=8e67f}

<!--
These six slides exercise the rendered Doctor's seams: sparse coverage, the type floor,
one-word lines, stage clipping, quote/figure measurements, and last-step reveal state.
They are examples for the report rather than new layout-registry entries.
-->

### Doctor fixture — sparse content coverage
{id=doctor-underfill}

A deliberately brief point.

### Doctor fixture — computed type floor
{id=doctor-type-floor}{quote}

> The rendered Doctor records the computed size of every visible text node so a dense composition cannot shrink silently below the thirty-one pixel presentation floor.

- Layout sampler

### Doctor fixture — one-word line
{id=doctor-one-word-line}{statement}

**Every multi-word claim should avoid a stranded final word**

### Doctor fixture — stage clipping
{id=doctor-stage-clip}{links}

[A deliberately long link label checks that link content stays inside the stage](https://example.org/a-deliberately-long-path-that-exercises-the-rendered-stage-edge-without-editing-the-compiler-layout)

### Doctor fixture — quote panel and figure geometry
{id=doctor-panel-figure}{image-quote}

![TalkWeaver handout at desktop size](assets/sample-image.png)

> Panel width and figure dimensions are recorded against the stage.

- Layout sampler

### Doctor fixture — last reveal step
{id=doctor-last-step}{reveal}

- The first point establishes the composition.
- The second point must be present in the final measurement.
- The last point proves that the Doctor did not stop at arrival state.

<!-- ticket-17-fixtures:start -->

### Type-floor fixture — nested content at every depth
{id=type-floor-nested}

- Group heading
  - First-level nested content stays readable
    - Second-level nested content stays readable too
- A second group
  - Nested content uses the same face and ink as its parent

### Type-floor fixture — key/value columns
{annotated}{id=type-floor-key-value}

- Computer commands
  - cd
  - ls
  - mkdir
- CLI tools
  - git
  - gh
  - wrangler
- API services
  - Lab notebooks
  - Canvas

### Type-floor fixture — table and inline code
{table}{id=type-floor-table}

| Element | Example |
| --- | --- |
| Command | Run `npm test` |
| Result | Every table cell stays readable |

### Type-floor fixture — quote cite
{quote}{id=type-floor-cite}

> A quotation and its attribution are both running content.

- Layout sampler

### Type-floor fixture — statement copy
{statement}{id=type-floor-statement}

Statement copy never falls below the presentation floor.

### Type-floor fixture — card copy
{cards}{id=type-floor-card}

- Card heading
  - Card copy remains readable.
- Code card
  - `inline code` remains readable too.

### Type-floor fixture — timeline labels
{timeline}{id=type-floor-timeline}

- 2025 — The first event establishes the sequence
- 2026 — The second event completes the sequence

### Type-floor fixture — portrait image containment
{media}{id=type-floor-portrait}

![Portrait screenshot](assets/placeholder-portrait.png)

### Type-floor fixture — compare column titles
{compare}{id=type-floor-compare} {carousel}

#### First column title
{id=p7zau}

The first comparison statement stays readable.

#### Second column title
{id=cnhu3}

The second comparison statement stays readable.

### Body-less cards use their labels as claims
{cards}{id=t19-cards-bare}

- AI as Oracle
- AI as Intern
- AI as Toolmaker

### Numbered body-less cards keep requested ordinals
{cards}{numbered}{id=t19-cards-numbered}

- Research
- Build
- Verify

### Ordered body-less cards keep requested ordinals
{cards}{id=t19-cards-ordered}

1. Research
2. Build
3. Verify

### Compare copy uses the body scale
{compare}{id=t19-compare-body} {carousel}

#### What TalkWeaver decides
{id=hg9eh}

Where the title goes, how wide a quote is, how pictures share a row, how big the type is.

#### What you decide
{id=rjiqo}

The words, the order, the pictures, and any override you write as a token.

### Nested list markers keep a readable gap
{id=t19-list-markers}

- Computer commands
  - cd
    - change directory
  - ls
- CLI tools
  - git

### Which layout would you write by hand?
{poll=single}{id=t19-poll-pending}

- A quote
- A list beside a picture
- A statement
- I let the slide decide

### Type-floor fixture — fenced code
{code}{id=type-floor-code}

```javascript
const floor = 31
render({ floor })
```

### Type-floor fixture — 80-character code lines wrap
{code}{id=type-floor-code-wrap}

```text
12345678901234567890123456789012345678901234567890123456789012345678901234567890
abcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghijabcdefghij
```

### Type-floor fixture — code that cannot fit at the floor
{code}{id=type-floor-code-too-long}

```javascript
line01()
line02()
line03()
line04()
line05()
line06()
line07()
line08()
line09()
line10()
line11()
line12()
line13()
line14()
line15()
line16()
line17()
line18()
line19()
line20()
line21()
line22()
line23()
line24()
line25()
line26()
line27()
line28()
line29()
line30()
line31()
line32()
line33()
line34()
line35()
line36()
line37()
line38()
line39()
line40()
```

### Type-floor fixture — links and URLs
{links}{id=type-floor-links}

[TalkWeaver](https://example.com/talkweaver)

<!-- ticket-17-fixtures:end -->

## Closing
{id=bziz3}

### Thank you
{closing} {id=oeemd}

**Thank you**

talkweaver.app
