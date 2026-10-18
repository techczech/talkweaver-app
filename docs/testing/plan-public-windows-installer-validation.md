---
title: Public Windows installer validation
status: test-harness-in-progress
updated: 2026-10-18
---

# Bounded verification scope

Verify the existing official v0.39.0 Windows x64 NSIS installer on a disposable GitHub-hosted Windows runner. Pin the installer and demo URLs and independently verified SHA-256 values. Record Authenticode status without changing trust or security policies. Refuse an existing TalkWeaver installation, install per-user into a runner-temporary directory, and launch that installed executable with synthetic data and an isolated profile. Exercise local read/save/present, retain a screenshot and assertions, then uninstall in cleanup.

Use existing Node/Playwright dependencies and a manual-only job in the existing packaged workflow. Do not change production code, rebuild or publish a release, use a Cloudflare account or private vault, or create/import a signing certificate. Keep processes and the job bounded; preserve failure evidence. This tests the installer separately from directory packaging and does not establish Microsoft Store certification or a Windows 10/11 client verdict.
