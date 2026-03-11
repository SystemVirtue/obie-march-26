import { normalizeJukeboxSlug } from '@shared/jukebox-utils';

const PLAYER_JUKEBOX_STORAGE_KEY = 'obie_player_jukebox_slug';

export function ResolvingScreen() {
  return (
    <div className="relative w-screen h-screen bg-black flex items-center justify-center text-white">
      <div className="text-center">
        <div className="text-2xl font-semibold mb-2">Resolving Jukebox...</div>
        <div className="text-gray-400">Please wait.</div>
      </div>
    </div>
  );
}

export function JukeboxNamePrompt() {
  return (
    <div className="relative w-screen h-screen bg-black flex items-center justify-center text-white">
      <div className="text-center max-w-md px-6">
        <div className="text-3xl font-bold mb-4">Jukebox Name Required</div>
        <div className="text-gray-300 mb-6">Open this page with a path like /OBIE, or set one now.</div>
        <button
          onClick={() => {
            const entered = window.prompt('Enter Jukebox Name (e.g. OBIE):');
            const slug = normalizeJukeboxSlug(entered);
            if (!slug) return;
            localStorage.setItem(PLAYER_JUKEBOX_STORAGE_KEY, slug);
            window.location.assign(`/${slug}`);
          }}
          className="px-5 py-3 rounded-lg bg-white text-black font-semibold hover:bg-gray-200"
        >
          Enter Jukebox Name
        </button>
      </div>
    </div>
  );
}

export function StatusOverlays({ state, playerReady, currentMedia, isSlavePlayer }: {
  state?: string; playerReady: boolean; currentMedia: unknown; isSlavePlayer: boolean;
}) {
  return (
    <>
      {state === 'idle' && !currentMedia && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-900 to-black">
          <div className="text-center">
            <div className="text-6xl font-bold text-white mb-4">Obie Jukebox</div>
            <div className="text-xl text-gray-400">Waiting for next song...</div>
            <div className="mt-8">
              <div className="inline-block w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
            </div>
          </div>
        </div>
      )}

      {(state === 'loading' && !playerReady) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-90">
          <div className="text-center">
            <div className="inline-block w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <div className="text-2xl text-white">Loading...</div>
          </div>
        </div>
      )}

      {state === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-900 bg-opacity-50">
          <div className="text-center">
            <div className="text-4xl font-bold text-white mb-4">⚠️ Playback Error</div>
            <div className="text-lg text-gray-200">Check logs for details</div>
          </div>
        </div>
      )}

      {isSlavePlayer && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-center items-end pb-4 pointer-events-none">
          <div className="text-5xl font-bold text-white opacity-50" style={{ fontFamily: 'Arial, sans-serif' }}>
            SLAVE
          </div>
        </div>
      )}
    </>
  );
}
