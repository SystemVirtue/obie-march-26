import { useRef, useEffect } from 'react';
import { useMasterPlayer } from '../hooks/useMasterPlayer';

export function MasterViewerPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { isMaster, playbackState, connectionStatus, handleVideoEnd } = useMasterPlayer('OBIE');

  // Load and play video when it changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackState?.video_url) return;

    // Direct video URL (R2, etc.)
    video.src = playbackState.video_url;
    video.play();
  }, [playbackState?.video_url]);

  // Handle video events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.addEventListener('ended', handleVideoEnd);
    return () => video.removeEventListener('ended', handleVideoEnd);
  }, [handleVideoEnd]);

  return (
    <div className="player-container" style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* Status indicator */}
      <div style={{
        position: 'absolute',
        top: 20,
        right: 20,
        zIndex: 100,
        padding: '10px 20px',
        borderRadius: 8,
        background: isMaster ? 'rgba(0, 255, 0, 0.8)' : 'rgba(255, 165, 0, 0.8)',
        color: 'black',
        fontWeight: 'bold',
        fontFamily: 'sans-serif',
      }}>
        {isMaster ? '🎬 MASTER PLAYER' : '👁️ VIEWER'}
        <br />
        <small>{connectionStatus}</small>
      </div>

      {/* Now playing overlay (for master or if title exists) */}
      {playbackState?.video_title && (
        <div style={{
          position: 'absolute',
          bottom: 100,
          left: 20,
          zIndex: 100,
          padding: '15px 25px',
          borderRadius: 8,
          background: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          fontFamily: 'sans-serif',
        }}>
          <div style={{ fontSize: 24, fontWeight: 'bold' }}>
            {playbackState.video_title}
          </div>
          {playbackState.video_artist && (
            <div style={{ fontSize: 18, opacity: 0.8 }}>
              {playbackState.video_artist}
            </div>
          )}
          <div style={{ fontSize: 14, marginTop: 8, opacity: 0.6 }}>
            Status: {playbackState.current_status}
          </div>
        </div>
      )}

      {/* Video element */}
      <video
        ref={videoRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: 'black',
        }}
        controls={isMaster} // Only show controls for master
        muted={!isMaster} // Mute viewers (optional - depends on your use case)
        playsInline
      />
    </div>
  );
}
