/**
 * Agent wake schedule helpers.
 * On-chain stores wakeIntervalBlocks; time-based UI converts via block time.
 */

/** Approximate Ritual block time (seconds). Override with NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC */
export const BLOCK_TIME_SEC = Math.max(
  1,
  Number(process.env.NEXT_PUBLIC_RITUAL_BLOCK_TIME_SEC || "2") || 2
);

export type ScheduleUnit = "blocks" | "minutes" | "hours";

export type ScheduleInput = {
  value: number;
  unit: ScheduleUnit;
};

/** Convert user schedule → on-chain wakeIntervalBlocks (min 1) */
export function scheduleToBlocks(input: ScheduleInput): bigint {
  const v = Math.max(1, Math.floor(Number(input.value) || 1));
  if (input.unit === "blocks") return BigInt(v);
  if (input.unit === "minutes") {
    return BigInt(Math.max(1, Math.ceil((v * 60) / BLOCK_TIME_SEC)));
  }
  // hours
  return BigInt(Math.max(1, Math.ceil((v * 3600) / BLOCK_TIME_SEC)));
}

/** Blocks → approximate seconds */
export function blocksToSeconds(blocks: bigint | number): number {
  const b = typeof blocks === "bigint" ? Number(blocks) : blocks;
  return Math.max(1, b) * BLOCK_TIME_SEC;
}

export function formatInterval(blocks: bigint | number): string {
  const sec = blocksToSeconds(blocks);
  if (sec < 120) return `~${sec}s (${blocks.toString()} blocks)`;
  if (sec < 7200) {
    const m = Math.round(sec / 60);
    return `~${m} min (${blocks.toString()} blocks)`;
  }
  const h = (sec / 3600).toFixed(1);
  return `~${h} h (${blocks.toString()} blocks)`;
}

export type DueInfo = {
  due: boolean;
  nextRunAt: number; // unix sec
  intervalSec: number;
  secondsUntilDue: number;
};

/**
 * Time-based due check using lastRunAt + interval from blocks.
 * lastRunAt === 0 → due immediately (never run).
 */
export function computeDue(
  lastRunAt: bigint | number,
  wakeIntervalBlocks: bigint | number,
  nowSec = Math.floor(Date.now() / 1000)
): DueInfo {
  const last = typeof lastRunAt === "bigint" ? Number(lastRunAt) : lastRunAt;
  const intervalSec = blocksToSeconds(wakeIntervalBlocks);
  const nextRunAt = last === 0 ? nowSec : last + intervalSec;
  const secondsUntilDue = Math.max(0, nextRunAt - nowSec);
  return {
    due: last === 0 || nowSec >= nextRunAt,
    nextRunAt,
    intervalSec,
    secondsUntilDue,
  };
}

export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
