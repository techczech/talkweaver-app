---
title: "TalkWeaver Layout Sampler"
author: Dominik Lukeš
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

### Nobody can change your brain for you
{statement}

### Statement default variant — current treatment
{statement=default}

The default statement remains an oversized claim with a centred block.

### Statement tint variant — panel and accent bar
{statement=tint}

The tint panel gives a claim **presence** without turning it into a quote.

### Statement poster variant — oversized boxed claim
{statement=poster}

One **boxed phrase** can carry the whole poster.

### The knowledge you need today
{list}

- How your computer works
- Principles of software architecture
- The developer-tools landscape
- How AI agents work
- What is possible with software

### The LLM is a universal translator (icon list)
{iconlist}

- language-to-language {icon=lucide:message-square}
- style-to-style {icon=lucide:pen-line}
- unstructured to structured {icon=lucide:boxes}
- text to code {icon=lucide:terminal}
- image to text {icon=lucide:image}
- question to answer {icon=lucide:message-circle-question-mark}
- problem-to-plan {icon=lucide:puzzle}

### Icon list boxes variant — cards and mono numbers
{iconlist=boxes}

- Translate {icon=lucide:languages}
- Structure {icon=lucide:boxes}
- Build {icon=lucide:hammer}

### Icon list list variant — plain icon rows
{iconlist=list}

- Translate {icon=lucide:languages}
- Structure {icon=lucide:boxes}
- Build {icon=lucide:hammer}

### Background cobalt variant — readable cobalt tint
{bg=cobalt}

- The slide uses the cobalt tint
- The section accent remains independent

### Background emerald variant — readable emerald tint
{bg=emerald}

- The slide uses the emerald tint
- The section accent remains independent

### Background vermilion variant — readable vermilion tint
{bg=vermilion}

- The slide uses the vermilion tint
- The section accent remains independent

### Background forest variant — readable forest tint
{bg=forest}

- The slide uses the forest tint
- The section accent remains independent

### How to work with an agent (numbered)
{numbered}

- Describe the outcome, not the steps
- Give it the context a new colleague would need
- Let it work, then verify the result end to end
- Capture what you learned for the next run

### Quote
{quote}

> AI democratises **capability**. It does not democratise **judgment**.

- Alex LeBlanc, "AI amplifies expertise, not replaces it"

### contrast-cards — what changed with agents
{contrast=cards}

- Complex algorithms / How your computer works
- Syntax of computer languages / Principles of software architecture
- Variables, functions, etc. / The developer-tools landscape
- How to use developer tools / How AI agents work

### What kind of judgment do you need (annotated)
{annotated}

- Fast judgment — recognising what something is, sensing a problem
- Slow judgment — backtracking through a problem step by step
- Taste — knowing which of two working answers is better
- Calibration — knowing when to trust the model and when to check

### Why are you studying at university (sidebar title)
{sidebar}

- Change your brain
- Change the world
- Prove to the authorities you can pass an exam

### Image
{media}

![](assets/sample-image.png)

### Image beside copy — left
{list}{image=left}

![](assets/sample-image.png)

- Copy stays vertically balanced beside the media slot

### Image beside copy — right
{list}{image=right}

![](assets/sample-image.png)

- The registered media-placement option flips the slot

### Quiet layout title restored
{quote}{title=show}

> A title can be visible when the layout normally keeps it for navigation only.

### Compact title
{cards}{title=compact}

- Compact
- Registered

### Contrast: cognition vs tools
{contrast}

- Judgement and knowledge / Precision and exact retrieval
- Comparison and estimation / Complex conditionals
- Recognising patterns / Precise calculation

### Contrast ledger variant
{contrast=ledger}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### Contrast rows variant
{contrast=rows}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### Contrast tint variant
{contrast=tint}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### Contrast flip variant
{contrast=flip}

- Chat window / Working environment
- Prompting / Delegating
- Single answers / Long-running work
- Copy-paste / Files and tools

### What LLMs can and cannot do (compare)
{compare}

#### What LLMs can do for you

Be a **ramp** to higher learning.

#### What LLMs cannot do for you

The learning.

### Use AI as a ramp to higher learning (copy + visual)
{copy-visual}

![](assets/sample-image.png)

The amount of time and effort required to change your brain is constant. AI can clear the ramp — finding resources, building scaffolding, giving feedback — but nobody can climb it for you.

### Three roles of AI (cards)
{cards}{icons}

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
{cards=rows}

#### AI as Oracle {icon=lucide:brain-circuit}

- Capabilities: answer questions, summarise, translate
- Chatbots: ChatGPT, Gemini, Claude
- Specialist apps: NotebookLM, Elicit, Consensus

#### AI as Tool Maker {icon=lucide:hammer}

- Capabilities: write code, manage a code base
- Outcomes: scripts, dashboards, simulations, workflows
- Tools: Cursor, Lovable, Google AI Studio

#### AI as Tool User {icon=lucide:bot}

- Capabilities: plan, work with files, run utilities
- Outcomes: ambitious projects, manage data, replicate analyses
- Desktop agents: Codex, Claude Code, Antigravity

### A month with agents (carousel)
{carousel}

#### Scheduled my calendar

Codex read the invitation thread, found the gaps, and booked the travel time around them.

#### Built my own slide tools

The presentation system this very deck runs on — outlines in, talks out.

#### Rescued old websites

Fifteen years of abandoned HTML, migrated and republished in an afternoon.

## Structural

### Title slide
{title}

TalkWeaver Layout Sampler

## Section divider
{role=section-title}

### Section divider child

- Every section carries its own accent colour — the audience always knows where they are.

### subsection — what a new expertise looks like
{sub}

#### Child slide

- The parent renders as a subsection divider under the current section.

### The ChatGPT timeline
{timeline}{reveal}

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

### Timeline — vertical
{timelinevertical}

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
{timelinehorizontal}

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
{timelinespine}

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
{timeline-pills}

**Timeline:**

- 2022
- 2023
- 2024
- 2025
- 2026

### sidebar-40 — pinned rail width
{sidebar-40}

- Wide rail shortens the text measure
- 30 and 35 and 50 are the other stops

### font-body — per-slide type override
{font-body=l}{font-title=s}

- Body steps up one size
- The title steps down one

### novalues — effort, shape only
{barchart}{novalues}

- Organising your life: 15
- Finding resources: 20
- Learning subject: 40

### Grid
{grid}{blocks:2x2}

- Chatbots — ChatGPT, Gemini, Claude
- Research apps — NotebookLM, Elicit, Consensus
- Builders — Cursor, Lovable, AI Studio
- Desktop agents — Codex, Claude Code, Antigravity

### System map: the AI agent
{system-map}

- Model — judgement and language
- Harness — tools and permissions
- Context — files, history, instructions
- Channel — where you meet it

## Specialised

### Strengths of cognition and tools (SmartArt)
{smartart}

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
{flow}

- Write the outline
- Compile the deck
- Rehearse with beats
- Present and record

### Flow — vertical
{flow}{flow=vertical}

- Outline
- Compile
- Present

### Flow — loop
{flow}{flow=loop}

- Draft
- Review
- Revise

### Flow — branch
{flow}{flow=branch}

- Source
- Slides
- Handout

### Intelligence as Grep and Grok (image + claim)
{image-claim}

![](assets/sample-image.png)

- Grep is retrieval — exact, literal, tireless
- Grok is understanding — fuzzy, contextual, judgemental
- You need both; so does the machine

### Try it on your own material (CTA + screenshots)
{cta-screenshots}

![](assets/sample-image.png)

- Bring one real presentation to the workshop
- Convert it to an outline and rebuild it live
- [Action: Get the starter kit → https://example.com]

### Trace (transcript)
{trace}

```trace
User: Reorganise my Downloads folder by project.
Agent: I found 1,482 files. Grouping by the six project names in your notes — shall I move screenshots into their matching projects too?
User: Yes, and delete the duplicates.
Agent: Done. 212 duplicates removed, structure written to a manifest you can undo.
```

### Code block (ELEMENT, not slide layout — ADR-0006)
{code}

```python
def judgement(time, effort, learning):
    """No shortcuts."""
    return time + effort + learning
```

### Three roles of AI (table)
{table}

- Capabilities
  - answer questions, summarise, translate
  - write code, manage a code base
  - plan, work with files, run utilities
- Where
  - ChatGPT, Gemini, Claude
  - Cursor, Lovable, AI Studio
  - Codex, Claude Code, Antigravity

### qr — QR code element

[QR: https://example.com | example.com]

### action — Action button element

[Action: Explore the deliberate practice guide → https://deliberatepractice.example.com]

### Embed element

[Embed: https://example.com]

### auto-embed (bare URL)

https://example.com

### Logo list
{logolist}

- OpenAI
- Anthropic
- Google
- GitHub
- Cloudflare

### Image + quote
{image-quote}

![](assets/sample-image.png)

> AI agents have crossed a threshold I didn't expect so soon. Not just impressive demos — but practical tools for daily use.

- Vivian Balakrishnan, Foreign Minister of Singapore

### Image grid
{image-grid}

![Daily use, not demos](assets/sample-image.png)

![The desktop agent at work](assets/sample-image.png)

![A month of agent output](assets/sample-image.png)

### Effort spent on learning (bar chart)
{barchart}

- Organising your life: 15
- Finding resources: 20
- Learning skills: 25
- Learning the subject: 40

### Where the week goes (pie chart)
{piechart}

- Deep work: 35
- Meetings: 25
- Email and admin: 20
- Learning: 20

### Weekly ChatGPT users (line chart)
{linechart}

- 2022: 1
- 2023: 100
- 2024: 400
- 2025: 1000

### Agent adoption (S-curve)
{sigmoid}

- Sceptics: 10
- Daily users: 50
- Toolmakers: 90

### Workshop day (timetable)
{timetable}

- 09:00 · Welcome and setup
- 09:30 · Outlines: from PowerPoint to Markdown
- 10:30 · Break
- 11:00 · Layouts and reveals, hands on
- 12:30 · Lunch
- 13:30 · Build your own talk
- 15:00 · Present to the room

## Diagrams

### columns
{2col}

#### Humans

- Mental checklists
- Focus
- Physical objects
- Computers
- Relationships

#### Large Language Models

- Shell commands
- CLIs
- APIs
- Scripts
- Search

### Effort spent on learning (pyramid)
{pyramid}

- Learning the subject
- Learning skills
- Finding resources
- Organising your life

### Org chart
{orgchart}

- AI Competency Centre
  - Research support
  - Teaching and courses
  - Tools and infrastructure

### Mind map
{mindmap}

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

### Concept map
{conceptmap}

- Model -powers- Agent
- Agent -uses- Tools
- Tools -act on- Files
- Agent -reports to- You
- You -teach- Agent

### Stats
{stats}

- 1 billion: people use ChatGPT weekly
- 5 days: to the first million users
- 3×: more people learning to code than 2022

### From idea to talk (process strip)
{process}

- Capture
- Outline
- Design
- Rehearse
- Deliver

### Learning any skill (steps)
{steps}

- Follow recipes
- Adapt recipes
- Write recipes
- Forget recipes

### Two parts of ChatGPT (icon row)
{iconrow}

- Large Language Model {icon=lucide:brain}
  - outputs tokens
  - rich knowledge and judgement
  - limited precision
- Orchestration {icon=lucide:computer}
  - parses tokens and runs them
  - absolute logic
  - no judgement at all

### How judgment is built (cycle)
{cycle}

- Repetition
- Reflection

### No shortcuts (equation)
{equation}

- Time
- Effort
- Learning

### Equation — circles
{equation=circle}

- Time
- Practice
- Fluency

### Equation — squares
{equation=square}

- Evidence
- Judgement
- Decision

### Equation — ovals
{equation=oval}

- Context
- Intent
- Meaning

## Modes

### Reveal: what agents change
{reveal}

- Work is amplified
- More people get access to that work
- Some jobs stop being jobs
- New jobs appear where judgement lives

### Group reveal
{group}{reveal}

- These three lines arrive together
- as a single beat
- because they make one point

### Focus mode: three claims worth dwelling on
{focus}

- You live in the golden age of learning
- It is now worth learning more, not less
- There are no excuses left

### Countdown element
{countdown-digits-90s}

Discuss with your neighbour: what was the last thing you used a chatbot for?

### trigger-line
{contrast}

- Trigger lines keep headings clean / The same compiler vocabulary applies

### notitle
{notitle}

You cannot act in the world and look up everything. You must know things in a special way.

### titletop
{titletop}

- The title rail moves to the top
- For content that needs the full width
- Wide tables, timelines, full-bleed media

### nostep
{nostep}{reveal}

- Everything stays visible
- Even with reveal mode active
- Useful for reference slides

### plainlist
{plainlist}

- Fluency in a language
- Participation in a game
- Playing a sport
- Making music

### stmt-list
{stmt-list}

Good slow judgment needs good fast judgment.

- Fast: what something is, that something is off
- Slow: how to backtrack, how to evaluate a plan

### links
{links}

[Deliberate Practice — a universal learning method](https://deliberatepractice.example.com)

[AI news round-up](https://ainewsroundup.pages.dev)

[example.com](https://example.com)

### chart
{chart}

- Reading: 40
- Practice: 35
- Feedback: 25

### table-outline
{table}

- You don't need
  - Complex algorithms
  - Language syntax
  - Developer tools training
- You do need
  - Computer literacy
  - Architecture judgement
  - Agent awareness

### trace-dialogue
{trace}

```trace
Student: Can I just use the chatbot to write the essay?
Tutor: You can. It will cost you exactly the learning the essay was for.
```

### 3col
{3col}

#### Oracle

- Ask
- Read
- Verify

#### Tool Maker

- Specify
- Generate
- Test

#### Tool User

- Delegate
- Review
- Ship

### grid-linear
{grid-linear}

#### Fast judgment

- What something is, at a glance

#### Slow judgment

- Backtracking through a problem

### grid-zoom
{grid-zoom}

#### Learning more

- Because the ramp is cleared

#### Doing more

- Because the tools compound

### contents
{contents}

#### Why we are here

- The question behind the whole talk

#### What changed

- Agents crossed the threshold

#### What to do

- Learn more, not less

### contents strip {contents=strip}

The filmstrip footer variant (ADR-0007) — a contact-sheet of child miniatures instead of the
thin agenda rail. For sections where seeing the slides matters more than their names.

#### Strip child one

- The slides speak for themselves

#### Strip child two

- Names would only get in the way

### timer-audience
{timer=10min}{timer-audience}

#### Timed child

- The section timer is visible to the room while you work.

### multicolour
{system-map}{multicolour}

- Repetition
- Reflection
- Feedback
- Time

## accent — pinned section colour
{accent=vermilion}

### Every slide in this section keeps vermilion

- The author chooses a name
- The compiler owns the accent and tint pair

## Closing

### Thank you
{closing}

**Thank you**

example.com
