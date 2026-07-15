// Pure timer-core guard. Loads the REAL runtime source (single source of truth) and
// exercises bigTimerState / fmtClock. Run: node scripts/test-timers.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "compiler", "assets", "runtime", "timer.js"), "utf8");
const { fmtClock, bigTimerState } = new Function(`${src}\nreturn { fmtClock, bigTimerState };`)();

const TH = { warnAtSeconds: 300, urgentAtSeconds: 60 };
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// fmtClock
ok("fmtClock rounds+pads", fmtClock(65) === "01:05");
ok("fmtClock clamps negative", fmtClock(-5) === "00:00");

// idle: not started -> shows target, no level, no milestone
{
  const s = bigTimerState(1000, { targetSeconds: 2700, elapsedMs: 0, runningSince: null }, TH, new Set());
  ok("idle status", s.status === "idle");
  ok("idle seconds == target", s.seconds === 2700);
  ok("idle no level", s.level === "");
  ok("idle no milestone", s.milestone === null);
}

// running normal band (>5 min left)
{
  const now = 100000;
  const s = bigTimerState(now, { targetSeconds: 2700, elapsedMs: 0, runningSince: now - 60000 }, TH, new Set());
  ok("running status", s.status === "running");
  ok("running remaining", s.seconds === 2640);
  ok("normal band no level", s.level === "");
}

// warn band (<=5 min, >1 min)
{
  const now = 100000;
  const s = bigTimerState(now, { targetSeconds: 300, elapsedMs: 0, runningSince: now - 10000 }, TH, new Set());
  ok("warn level", s.level === "warn"); // 290s left
}

// urgent band (<=1 min)
{
  const now = 100000;
  const s = bigTimerState(now, { targetSeconds: 60, elapsedMs: 0, runningSince: now - 20000 }, TH, new Set());
  ok("urgent level", s.level === "urgent"); // 40s left
}

// over band (<=0), counts negative
{
  const now = 100000;
  const s = bigTimerState(now, { targetSeconds: 60, elapsedMs: 0, runningSince: now - 90000 }, TH, new Set());
  ok("over level", s.level === "over");
  ok("over seconds negative", s.seconds === -30);
}

// paused: freezes elapsed, still bands, never announces a milestone
{
  const s = bigTimerState(999999, { targetSeconds: 300, elapsedMs: 250000, runningSince: null }, TH, new Set());
  ok("paused status", s.status === "paused");
  ok("paused remaining frozen", s.seconds === 50);
  ok("paused urgent band", s.level === "urgent");
  ok("paused no milestone", s.milestone === null);
}

// pause->resume accumulation: 40s run + pause + 20s run = 60s elapsed
{
  const now = 200000;
  const s = bigTimerState(now, { targetSeconds: 120, elapsedMs: 40000, runningSince: now - 20000 }, TH, new Set());
  ok("resume accumulates elapsed", s.seconds === 60);
}

// milestones: most-urgent-first, skip milestones above target, respect fired set
{
  const now = 100000;
  // 4:00 left of a 45-min talk crossing the 5-min... no: choose 5-min crossing
  const s = bigTimerState(now, { targetSeconds: 2700, elapsedMs: 0, runningSince: now - (2700 - 300) * 1000 }, TH, new Set());
  ok("fires 5-min milestone", s.milestone === 300);
  const s2 = bigTimerState(now, { targetSeconds: 2700, elapsedMs: 0, runningSince: now - (2700 - 300) * 1000 }, TH, new Set([300]));
  ok("does not refire fired milestone", s2.milestone === null);
  const s3 = bigTimerState(now, { targetSeconds: 120, elapsedMs: 0, runningSince: now - 10000 }, TH, new Set());
  ok("no 5-min milestone on a 2-min talk", s3.milestone !== 300);
}

// configurable thresholds
{
  const now = 100000;
  const th2 = { warnAtSeconds: 600, urgentAtSeconds: 120 };
  const s = bigTimerState(now, { targetSeconds: 700, elapsedMs: 0, runningSince: now - 120000 }, th2, new Set());
  ok("custom warn threshold", s.level === "warn"); // 580s <= 600 -> warn
}

console.log(`test-timers: ${passed} checks passed`);
