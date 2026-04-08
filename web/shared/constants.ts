// Obie Jukebox Constants
// Centralized timeout and debounce values

// Debounce delays (ms)
export const QUEUE_DEBOUNCE_MS = 800;
export const PLAYER_STATUS_DEBOUNCE_MS = 500;

// Heartbeat intervals (ms)
export const HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds

// Timeouts (ms)
export const LOADING_TIMEOUT_MS = 6000; // 6 seconds for loading state before auto-skip
export const REALTIME_POLL_TIMEOUT_MS = 10000; // 10 seconds for realtime fallback polling
export const RECENTLY_LOADED_TIMEOUT_MS = 5000; // 5 seconds for recently loaded guard
export const IS_ENDING_FALLBACK_MS = 10000; // 10 seconds fallback for isEndingRef reset

// Animation durations (ms)
export const FADE_DURATION_MS = 2000; // 2 seconds for fade in/out

// Queue limits
export const MAX_MARQUEE_ITEMS = 5;

// Progress reporting throttle (ms)
export const LOCAL_VIDEO_REPORT_THROTTLE_MS = 1000;
