---
title: Understanding AI agents
subtitle: From simple assistants to autonomous systems
author: Dominik Lukeš
date: 10 November 2026
---
# Understanding AI agents

<!-- The round-1 test content (docs/design/2026-11-10-native-slide-redesign/round-1/brief.md), written
as an author would write it in TalkWeaver, for the 0.44 basics contact sheet. Ids k01… are the kinds. -->

## How do agents work?
{id=k-divider}

### What an agent is
{statement}{id=k-statement}

An agent is a model using **tools** in a **loop**.

### What an agent is
{statement}{statement-bg=rule}{id=k-statement-light}

An agent is a model using **tools** in a **loop**.

### Tools agents can use
{iconlist=boxes}{id=k01-six}

- Search files {icon=lucide:search}
  - finds and reads what is on your computer
- Search the web {icon=lucide:globe}
  - looks things up and reads pages
- Run commands {icon=lucide:terminal}
  - does what you would do by hand
- Use applications {icon=lucide:app-window}
  - clicks and types like a person
- Write scripts {icon=lucide:file-code}
  - makes its own tools when it needs them
- Ask other models {icon=lucide:bot}
  - hands off part of the job

### Tools agents can use
{iconlist=boxes}{id=k01-three}

- Search files {icon=lucide:search}
  - finds and reads what is on your computer
- Search the web {icon=lucide:globe}
  - looks things up and reads pages
- Run commands {icon=lucide:terminal}
  - does what you would do by hand

### Tools agents can use
{iconlist=boxes}{reveal}{id=k01-current}

- Search files {icon=lucide:search}
  - finds and reads what is on your computer
- Search the web {icon=lucide:globe}
  - looks things up and reads pages
- Run commands {icon=lucide:terminal}
  - does what you would do by hand
- Use applications {icon=lucide:app-window}
  - clicks and types like a person
- Write scripts {icon=lucide:file-code}
  - makes its own tools when it needs them
- Ask other models {icon=lucide:bot}
  - hands off part of the job

### Brain, hands, tools
{iconrow}{id=k02}

- Model {icon=lucide:brain}
  - decides what to do
- Harness {icon=lucide:hand}
  - carries it out
- Tools {icon=lucide:wrench}
  - do the work

### From chat to autonomous agent
{steps}{id=k03}

- Chat
- Chat with attachments
- Delegation: a task or a whole project
- Autonomous: an agent with its own computer

### Three things that should not meet
{equation}{id=k04}

- Private data
- Content from strangers
- A way to send things out
- Data can be stolen

### One agent or many
{orgchart}{id=k05}

- You
  - Lead agent
    - Helper: search
    - Helper: read
    - Helper: check

### What an agent reaches
{system-map}{id=k06}

- Agent
  - Your files
  - Email and calendar
  - The web
  - Other models

### What protects your data
{annotated}{id=k07}

- Guide
  - The model's own judgement
  - Your instructions
- Check
  - A monitor model
  - Your approval
- Enforce
  - An enforced gate
  - Isolation

### From chatbot to agent
{timeline}{id=k08}

- Nov 2022: ChatGPT is a chat
- Mar 2023: Plugins and BabyAGI
- Nov 2023: GPTs
- Late 2024: Deep research agents
- 2025: Coding agents
- Nov 2025: Agents become reliable

### Office tasks an agent can finish
{barchart}{id=k09}

- Model A: 71
- Model B: 64
- Model C: 58
- Model D: 41
- **Local model E**: 22
- **Local model F**: 15

### Chat and agent
{contrast}{id=k10}

- Chat
  - tells you how
  - one answer
  - you do the steps
- Agent
  - does it for you
  - many steps in a loop
  - you check the result

### The agentic loop
{cycle}{id=k11}

- Harness sends instructions
- Model makes a plan
- Model sends a command
- Computer runs it
- Harness returns the result
