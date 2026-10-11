---
outline_version: 2
---
# AI chat and terminal slides: demo

## Simulations
{id=rdn2p}

### Chat plus behind the scenes
{chat-lanes model="Example model"} {id=3y4kj}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Behind the scenes, results open
{chat-lanes model="Example model" open=all} {id=ozwgo}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Behind the scenes, no sidebar
{chat-lanes model="Example model" sidebar=off} {id=f7sah}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Behind the scenes, step by step (press next)
{chat-lanes model="Example model" reveal=steps} {id=zlrdq}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Two questions on one slide
{chat-lanes model="Example model"} {id=68h5e}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
user: Does that apply to orders placed in August?
model-reasoning (2s): The change log should say when the new window took effect.
tool-call: get_change_log_entry {"policy": "refunds", "field": "effective_from"}
tool-results:
  effective_from: 2026-09-01
  Orders before this date keep 30 days
bot: No. Orders placed before 1 September keep the 30-day window.
```

### Behind the scenes, streaming (press next)
{chat-lanes} {model="Example model"} {stream=on} {reveal=steps} {id=863sa}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### A long conversation (scroll it)
{chat} {model="Example model"} {id=99bsx}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
user: Does that apply to orders placed in August?
model-reasoning (2s): The change log should say when the new window took effect.
bot: No. Orders placed before 1 September keep the 30-day window. The new rules apply to orders placed on or after that date.
user: What counts as unused for digital goods?
bot: A download that has not been opened, or a licence key that has not been activated. Once a file has been downloaded or a key activated, the purchase is final unless the product is faulty.
user: Who can give the manager sign-off?
bot: Any team lead or the duty manager on shift. The sign-off is recorded on the refund ticket before the payment goes out.
user: Can you draft a short note to customers about the change?
bot: Here is a draft. From 1 September, you can return most items within 14 days of delivery. Digital goods can be refunded if they have not been downloaded or activated. Refunds over £200 are checked by a manager, which can add a day to the process.
user: Make it friendlier and add a line about orders placed before September.
bot: Sure. We have updated our refund policy. From 1 September you have 14 days from delivery to send something back, and digital goods can be refunded as long as they have not been downloaded or activated. Anything you ordered before 1 September still has the full 30 days. Larger refunds, over £200, get a quick check from a manager, so they may take an extra day.
```

### Chat with rows to click open
{chat model="Example model"} {id=99z77}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Chat, all rows open
{chat model="Example model" open=all} {id=5oj2q}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Chat, no sidebar
{chat model="Example model" sidebar=off} {id=okxsp}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Plain terminal
{terminal window-title="policy — shell"} {id=8k0kx}

```terminal
~ $ cd policy
~/policy $ ls
change-log.md  refund-policy.md  shipping-policy.md
$ git log --oneline -3
a41c9e2 Cut refund window to 14 days
7d03b58 Digital goods: unused only
e90f1aa Add manager sign-off over £200
$ grep -n "refund window" refund-policy.md
12:The refund window is 14 days from delivery.
37:Outside the refund window, contact support.
```

### Agent in a terminal
{terminal-agent window-title="agent-cli · example-model · ~/policy" model="example-model"} {id=x9ffq}

```terminal
user: What changed in our refund policy last month?
model-reasoning (4s): check the policy and its change log first
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Agent, result opened
{terminal-agent window-title="agent-cli · example-model · ~/policy" model="example-model" open=all} {id=v5jdf}

```terminal
user: What changed in our refund policy last month?
model-reasoning (4s): check the policy and its change log first
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Agent, step by step (press next)
{terminal-agent window-title="agent-cli · example-model · ~/policy" model="example-model" reveal=steps} {id=m8g6y}

```terminal
user: What changed in our refund policy last month?
model-reasoning (4s): check the policy and its change log first
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Chat rows, step by step (press next)
{chat model="Example model" reveal=steps} {id=zqytc}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Plain terminal, step by step (press next)
{terminal window-title="policy — shell" reveal=steps} {id=hy0hv}

```terminal
~ $ cd policy
~/policy $ ls
change-log.md  refund-policy.md  shipping-policy.md
$ git log --oneline -3
a41c9e2 Cut refund window to 14 days
7d03b58 Digital goods: unused only
e90f1aa Add manager sign-off over £200
```

### Behind the scenes, larger text
{chat-lanes model="Example model" size=large} {id=m758p}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Chat rows, larger text
{chat}{stream=on}{model="Example model"}{size=large}{open=all}{id=1697r}

```chat
user: What changed in our refund policy last month?
model-reasoning (4s): They want last month’s changes. I should check the current refund policy and its change log before answering.
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```

### Plain terminal, larger text
{terminal}{reveal=steps}{window-title="policy — shell"}{size=large}{id=3gks8}

```terminal
~ $ cd policy
~/policy $ ls
change-log.md  refund-policy.md  shipping-policy.md
$ git log --oneline -3
a41c9e2 Cut refund window to 14 days
7d03b58 Digital goods: unused only
e90f1aa Add manager sign-off over £200
$ grep -n "refund window" refund-policy.md
12:The refund window is 14 days from delivery.
37:Outside the refund window, contact support.
```

### Agent, larger text
{terminal-agent window-title="agent-cli · example-model · ~/policy" model="example-model" size=large} {id=j2iie}

```terminal
user: What changed in our refund policy last month?
model-reasoning (4s): check the policy and its change log first
context-retrieval:
  Refund Policy v4.2 (September 2026)
  Policy change log, September 2026
tool-call: search_policy_docs {"topic": "refunds", "since": "2026-09-01"}
tool-results:
  Refund window cut from 30 to 14 days
  Digital goods: refundable only if unused
  Refunds over £200 need manager sign-off
bot: Last month the refund window shrank from 30 to 14 days, and digital goods are now refundable only if unused. Refunds over £200 also need manager sign-off.
```











