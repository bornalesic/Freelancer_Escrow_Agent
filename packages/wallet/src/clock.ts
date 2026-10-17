// A clock that survives WSL2.
//
// Measured on this machine (2026-10-17): WSL2's wall clock jumps FORWARD 96.7 s and then back, while
// the monotonic clock advances normally -- a time-sync artifact, reproducible with
// `scratch/wsl-clock-jump.mjs`. Anything that measures a DURATION from `Date.now()` is therefore
// unsafe here: a forward jump makes every pending deadline instantly "due" (MockWallet settled a
// 60-second transfer immediately), and the backward jump that follows stalls it for ~96 s.
//
// Rule for this package: wall clock for human-facing timestamps only (createdAt, expiresAt, which are
// displayed and are tolerant of a ~100 s skew); monotonic clock for every deadline and delay.
//
// `performance.now()` is monotonic but its origin is per-process, so it cannot be written into a file
// one process reads back in another. On Linux, /proc/uptime is monotonic AND shared by every process
// on the host, which is exactly what the cross-process ledger needs.

import { readFileSync } from 'node:fs'

const UPTIME_PATH = '/proc/uptime'

function readUptimeMs(): number | null {
  try {
    const first = readFileSync(UPTIME_PATH, 'utf8').split(' ')[0]
    if (first === undefined) return null
    const seconds = Number(first)
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null
  } catch {
    return null
  }
}

const UPTIME_AVAILABLE = readUptimeMs() !== null

/**
 * Milliseconds from an arbitrary origin that is stable across processes on this host, and immune to
 * wall-clock adjustments. Falls back to `Date.now()` where /proc/uptime does not exist (Windows,
 * macOS) -- those hosts do not show the WSL2 jump, and the mock wallet only runs under WSL anyway.
 */
export function monotonicMs(): number {
  if (UPTIME_AVAILABLE) {
    const ms = readUptimeMs()
    if (ms !== null) return ms
  }
  return Date.now()
}

/** True when we have a real monotonic source; false means durations fall back to the wall clock. */
export function monotonicIsReliable(): boolean {
  return UPTIME_AVAILABLE
}

/** Wall clock, for timestamps a human reads. Never use this to measure a duration. */
export function wallClockIso(at: number = Date.now()): string {
  return new Date(at).toISOString()
}
