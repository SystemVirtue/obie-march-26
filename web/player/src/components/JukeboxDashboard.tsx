import { useEffect, useState } from 'react';
import { getAllJukeboxes } from '@shared/supabase-client';
import { normalizeJukeboxSlug } from '@shared/jukebox-utils';

export function JukeboxDashboard() {
  const [jukeboxes, setJukeboxes] = useState<{ player_id: string; jukebox_slug: string; display_name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const allJukeboxes = await getAllJukeboxes();
        if (!cancelled) setJukeboxes(allJukeboxes);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnterJukebox = () => {
    const entered = window.prompt('Enter Jukebox Name (e.g. OBIE):');
    const slug = normalizeJukeboxSlug(entered);
    if (!slug) return;
    window.location.assign(`/${slug}`);
  };

  const handleSelectJukebox = (slug: string) => {
    window.location.assign(`/${slug}`);
  };

  if (loading) {
    return (
      <div className="relative w-screen h-screen bg-black flex items-center justify-center text-white">
        <div className="text-center">
          <div className="text-2xl font-semibold mb-2">Loading Jukeboxes...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="relative w-screen h-screen bg-black flex items-center justify-center text-white">
        <div className="text-center max-w-md px-6">
          <div className="text-3xl font-bold mb-4 text-red-400">Error</div>
          <div className="text-gray-300 mb-6">{error}</div>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-3 rounded-lg bg-white text-black font-semibold hover:bg-gray-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen bg-black flex flex-col items-center justify-center text-white p-8">
      <div className="max-w-6xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold mb-2" style={{ fontFamily: 'var(--font-display)' }}>
            Available Jukeboxes
          </h1>
          <p className="text-gray-400">Select a jukebox to open it in fullscreen mode</p>
        </div>

        {jukeboxes.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-6">No jukeboxes available.</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
            {jukeboxes.map((jukebox) => (
              <button
                key={jukebox.player_id}
                onClick={() => handleSelectJukebox(jukebox.jukebox_slug)}
                className="p-6 rounded-lg bg-gray-800 hover:bg-gray-700 text-left transition-colors border border-gray-700 hover:border-gray-600 hover:scale-105 transform transition-transform"
              >
                <div className="text-2xl font-bold mb-1" style={{ fontFamily: 'var(--font-display)' }}>
                  {jukebox.display_name}
                </div>
                <div className="text-sm text-gray-400">
                  /{jukebox.jukebox_slug}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="text-center">
          <button
            onClick={handleEnterJukebox}
            className="px-6 py-3 rounded-lg bg-white text-black font-semibold hover:bg-gray-200"
          >
            Enter Jukebox Name
          </button>
        </div>

        <div className="text-center mt-4">
          <div className="text-gray-500 text-sm">
            Or enter a jukebox name directly in the URL (e.g., /OBIE)
          </div>
        </div>
      </div>
    </div>
  );
}
