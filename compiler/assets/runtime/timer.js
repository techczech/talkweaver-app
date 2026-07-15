// Pure presenter timer core. Inlined into the presenter template at build time (no export
// keyword — see 01-cli-utils.timerRuntimeSource) and loaded verbatim by scripts/test-timers.mjs.
// timer = { targetSeconds, elapsedMs, runningSince }: elapsedMs is frozen accumulated run time,
// runningSince is the wall-clock ms the current run began (null when idle/paused). This shape lets
// pause/resume and mid-talk reload accumulate correctly from one persisted object.
function fmtClock(totalSeconds) {
  const t = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

function bigTimerState(nowMs, timer, thresholds, firedMilestones) {
  const targetSeconds = Number(timer?.targetSeconds || 0);
  const elapsedMs = Number(timer?.elapsedMs || 0);
  const runningSince = timer?.runningSince || null;
  const status = runningSince ? "running" : (elapsedMs > 0 ? "paused" : "idle");
  const elapsed = elapsedMs + (runningSince ? nowMs - runningSince : 0);
  const seconds = Math.round(targetSeconds - elapsed / 1000); // remaining; negative once overrunning
  const warnAt = Number(thresholds?.warnAtSeconds ?? 300);
  const urgentAt = Number(thresholds?.urgentAtSeconds ?? 60);
  let level = "";
  if (status !== "idle") {
    level = seconds <= 0 ? "over" : seconds <= urgentAt ? "urgent" : seconds <= warnAt ? "warn" : "";
  }
  // Most-urgent-first so a clock jump (window slept) announces what matters NOW; a milestone above
  // the talk's own length never fires (a 2-minute talk has no "5 minutes"). Announce only while running.
  let milestone = null;
  if (status === "running") {
    for (const m of [0, urgentAt, warnAt]) {
      if (seconds <= m && targetSeconds > m && !firedMilestones.has(m)) { milestone = m; break; }
    }
  }
  return { status, mode: status === "idle" ? "idle" : "countdown", seconds, level, milestone };
}
