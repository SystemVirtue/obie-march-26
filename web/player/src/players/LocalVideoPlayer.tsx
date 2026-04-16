/**
 * LocalVideoPlayer — native <video> element for Cloudflare R2 / yt-dlp files
 *
 * Extracted from App.tsx where this was inlined as a conditional JSX block
 * with event handlers referencing outer-scope refs and callbacks.
 *
 * Ownership:
 *   - Renders the <video> element
 *   - Handles onPlay / onPause / onEnded / onError / onTimeUpdate
 *   - Throttles progress reports to avoid DB write storms
 *   - Dispatches state machine actions up to parent
 *   - Does NOT own fade logic (parent controls volume via videoRef)
 */

import { useRef, forwardRef, useImperativeHandle } from 'react';
import type { PlaybackAction } from '../state/playbackMachine';

const PROGRESS_THROTTLE_MS = 5_000;

type LocalVideoPlayerProps = {
  src: string;
  dispatch: React.Dispatch<PlaybackAction>;
  onProgress: (progress: number) => void;
};

export type LocalVideoPlayerHandle = {
  pause: () => void;
  resume: () => Promise<void>;
  /** The underlying <video> element — needed by useFade for volume control */
  getElement: () => HTMLVideoElement | null;
};

export const LocalVideoPlayer = forwardRef<LocalVideoPlayerHandle, LocalVideoPlayerProps>(
  function LocalVideoPlayer({ src, dispatch, onProgress }, ref) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const lastReportRef = useRef<number>(0);
    const hasPlayedRef = useRef(false);

    useImperativeHandle(ref, () => ({
      pause() {
        videoRef.current?.pause();
      },
      async resume() {
        try {
          await videoRef.current?.play();
        } catch (err) {
          console.warn('[LocalVideoPlayer] Resume failed:', err);
        }
      },
      getElement() {
        return videoRef.current;
      },
    }));

    return (
      <video
        ref={videoRef}
        key={src}           // Force remount on src change
        src={src}
        autoPlay
        className="absolute inset-0 w-full h-full"
        style={{ objectFit: 'contain', background: 'black' }}
        onPlay={() => {
          hasPlayedRef.current = true;
          dispatch({ type: 'YOUTUBE_PLAYING' }); // Reuse same action — means "now playing"
        }}
        onPause={() => {
          // Ignore transient load pauses and end-of-stream pauses
          if (!hasPlayedRef.current) return;
          dispatch({ type: 'YOUTUBE_PAUSED' });
        }}
        onEnded={() => {
          dispatch({ type: 'YOUTUBE_ENDED' });
        }}
        onError={() => {
          console.error('[LocalVideoPlayer] Video error for src:', src);
          dispatch({ type: 'YOUTUBE_ERROR', code: -1 });
        }}
        onTimeUpdate={() => {
          const now = Date.now();
          if (now - lastReportRef.current < PROGRESS_THROTTLE_MS) return;
          lastReportRef.current = now;

          const el = videoRef.current;
          if (el && el.duration && isFinite(el.duration) && el.duration > 0) {
            onProgress(el.currentTime / el.duration);
          }
        }}
      />
    );
  }
);
