/** Client-safe Oracast watch constants (no server imports). */

/** RIT burned per hour of active monitoring (default 0.005). */
export const ORACAST_RATE_RIT_PER_HOUR = Number(
  process.env.NEXT_PUBLIC_ORACAST_RATE_RIT ||
    process.env.ORACAST_RATE_RIT_PER_HOUR ||
    "0.005"
);

/** Absolute dust floor — any deposit above this is allowed. */
export const ORACAST_MIN_DEPOSIT_RIT = Number(
  process.env.NEXT_PUBLIC_ORACAST_MIN_DEPOSIT_RIT || "0.001"
);

export const FREQ_OPTIONS_MIN = [
  5, 15, 30, 60, 120, 240, 360, 720, 1440,
] as const;

export type FreqOptionMin = (typeof FREQ_OPTIONS_MIN)[number];
