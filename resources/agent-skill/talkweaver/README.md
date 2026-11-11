# TalkWeaver content

Instructions for agents working with this app's content and existing operational surfaces. This package does not install the app, add an API or change application code.

## Install

Copy this entire skill directory, including `references/`, into your agent's skill location. For a project-local install, use `.claude/skills/talkweaver/` for Claude Code or `.agents/skills/talkweaver/` for Codex. Follow the host's current skill-discovery rules for a user-wide install.

Use `/talkweaver` in Claude Code or `$talkweaver` in Codex, or describe an appropriate task. Supply the actual workspace/data root when the agent cannot obtain it from configured context. The skill's plain Markdown instructions and references are portable; app access and permissions remain host-specific.

## Scope

The skill covers outline editing, Pathways, PowerPoint extraction and conversion, local audience handouts, recording transcription, faithful Script cleanup and rewritten lecture Notes. It includes the input/output contracts for the app's import and recording handoff packs.

Read [the skill](SKILL.md) for supported workflows and limitations. Existing commands are conditional on the installed version and actual exposed tools. No private machine paths, records, credentials or executable helpers are included in the published package.
