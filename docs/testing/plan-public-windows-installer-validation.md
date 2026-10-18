---
title: Public Windows installer validation
status: verified-on-hosted-windows-server
updated: 2026-10-18
---

# Bounded verification scope

Verify the existing official v0.39.0 Windows x64 NSIS installer on a disposable GitHub-hosted Windows runner. Pin the installer and demo URLs and independently verified SHA-256 values. Record Authenticode status without changing trust or security policies. Refuse an existing TalkWeaver installation, install per-user into a runner-temporary directory, and launch that installed executable with synthetic data and an isolated profile. Exercise local read/save/present, retain a screenshot and assertions, then uninstall in cleanup.

Use existing Node/Playwright dependencies and a manual-only job in the existing packaged workflow. Do not change production code, rebuild or publish a release, use a Cloudflare account or private vault, or create/import a signing certificate. Keep processes and the job bounded; preserve failure evidence. This tests the installer separately from directory packaging and does not establish Microsoft Store certification or a Windows 10/11 client verdict.

## Verified result

The exact public installer passed installation, five installed application checks and uninstall cleanup in [the Windows verification run](https://github.com/techczech/talkweaver-app/actions/runs/39114595091) at harness commit `17ad35d`. The runner was Windows Server 2025 Datacenter, build 26100. The installer and copied public demo retained their pinned SHA-256 values; Authenticode status was `NotSigned`.

The installed runtime reported packaged version 0.39.0 with its application and profile paths inside the isolated temporary directory. It opened a copied official demo, read and saved synthetic Markdown (checked on disk), compiled local slides, presented them and decoded a local SVG image. Installation and uninstallation exited with zero; both the installed executable and uninstall registration were removed. Logs, five assertion results and two synthetic screenshots are retained in that run's `talkweaver-public-nsis-validation` artifact.

An [earlier run](https://github.com/techczech/talkweaver-app/actions/runs/39114159403) failed before installation with `install exited with -1073741819` (`0xC0000005`), with empty redirected output. The controlled repeat removed installer stdout/stderr redirection and passed with the same release bytes, arguments and temporary installation layout. This supports an interaction with redirected process handles; it does not establish a deeper crash cause. The failing evidence is retained separately. Do not interpret it as a confirmed release-installer fault.

This is a disposable Server runner result, not a Windows 10/11 client, SmartScreen or Store certification result. No security setting was changed. The copied-demo test does not exercise first-run creation of the built-in example vault, which packaged E2E mode suppresses. No release was published and this draft branch remains unmerged.
