import { useEffect, useState } from 'react';
import { supabase, getMyJukeboxes, createJukebox, type JukeboxSummary } from '@shared/supabase-client';
import { normalizeJukeboxSlug } from '@shared/jukebox-utils';

export function JukeboxDashboard() {
  const [jukeboxes, setJukeboxes] = useState<JukeboxSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          if (!cancelled) {
            setUser(null);
            setLoading(false);
          }
          return;
        }

        if (!cancelled) setUser(session.user);

        const myJukeboxes = await getMyJukeboxes();
        if (!cancelled) setJukeboxes(myJukeboxes);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) {
        setUser(session?.user ?? null);
        if (session) load();
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  const handleCreateJukebox = async () => {
    const entered = window.prompt('Enter new jukebox name (A-Z, 0-9, underscore, dash):');
    const slug = normalizeJukeboxSlug(entered);
    if (!slug) return;
    
    try {
      setCreating(true);
      const created = await createJukebox(slug, slug);
      const refreshed = await getMyJukeboxes();
      setJukeboxes(refreshed);
      window.location.assign(`/${created.jukebox_slug}`);
    } catch (err: any) {
      alert(err.message || 'Failed to create jukebox');
    } finally {
      setCreating(false);
    }
  };

  const handleSelectJukebox = (slug: string) => {
    window.location.assign(`/${slug}`);
  };

  if (loading) {
    return (
      <div className="relative w-screen h-screen bg-black flex items-center justify-center text-white">
        <div className="text-center">
          <div className="text-2xl font-semibold mb-2">Loading...</div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="relative w-screen h-screen bg-black flex items-center justify-center text-white">
        <div className="text-center max-w-md px-6">
          <div className="text-3xl font-bold mb-4">Authentication Required</div>
          <div className="text-gray-300 mb-6">
            <a 
              href="https://fcabzrkcsfjimpxxnvco.supabase.co/auth/v1/authorize?provider=google&redirect_to=https://obie-march-26.onrender.com/"
              className="text-blue-400 hover:text-blue-300 underline"
            >
              Sign in with Google
            </a>
          </div>
          <div className="text-gray-300 mb-6">or</div>
          <div className="text-gray-300 mb-6">
            <a 
              href="/admin"
              className="text-blue-400 hover:text-blue-300 underline"
            >
              Sign in with Email
            </a>
          </div>
          <div className="text-gray-400 text-sm">
            Or enter a jukebox name directly in the URL (e.g., /OBIE)
          </div>
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
      <div className="max-w-4xl w-full">
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold mb-2" style={{ fontFamily: 'var(--font-display)' }}>
            Your Jukeboxes
          </h1>
          <p className="text-gray-400">Select a jukebox to open it</p>
        </div>

        {jukeboxes.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 mb-6">You don't have any jukeboxes yet.</div>
            <button
              onClick={handleCreateJukebox}
              disabled={creating}
              className="px-6 py-3 rounded-lg bg-blue-500 text-white font-semibold hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating...' : 'Create Your First Jukebox'}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {jukeboxes.map((jukebox) => (
              <button
                key={jukebox.player_id}
                onClick={() => handleSelectJukebox(jukebox.jukebox_slug)}
                className="p-6 rounded-lg bg-gray-800 hover:bg-gray-700 text-left transition-colors border border-gray-700 hover:border-gray-600"
              >
                <div className="text-2xl font-bold mb-1" style={{ fontFamily: 'var(--font-display)' }}>
                  {jukebox.display_name}
                </div>
                <div className="text-sm text-gray-400">
                  /{jukebox.jukebox_slug}
                </div>
                <div className="text-xs text-gray-500 mt-2 capitalize">
                  {jukebox.role}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="text-center">
          <button
            onClick={handleCreateJukebox}
            disabled={creating}
            className="px-6 py-3 rounded-lg bg-green-500 text-white font-semibold hover:bg-green-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {creating ? 'Creating...' : '+ Create New Jukebox'}
          </button>
        </div>

        <div className="text-center mt-8">
          <div className="text-gray-500 text-sm">
            Or enter a jukebox name directly in the URL (e.g., /OBIE)
          </div>
        </div>
      </div>
    </div>
  );
}
