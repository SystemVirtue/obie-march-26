// Obie Kiosk - Public Search & Request Interface
// Server-driven credit system and priority queue

import { useRef, useState } from 'react';
import {
  callKioskHandler,
} from '../../shared/supabase-client';
import { Coins } from 'lucide-react';
import { SearchInterface } from './components/SearchInterface';
import { SearchResult } from '../../shared/types';
import { BackgroundPlaylist, DEFAULT_BACKGROUND_ASSETS } from './components/BackgroundPlaylist';
import { cleanDisplayText } from '../../shared/media-utils';
import { normalizeJukeboxSlug } from '../../shared/jukebox-utils';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { QueueMarquee } from './components/QueueMarquee';
import { Dialog, DialogContent } from './components/Dialog';
import { useKioskSession } from './hooks/useKioskSession';
import { useCoinAcceptor } from './hooks/useCoinAcceptor';

const DEFAULT_PLAYER_ID = import.meta.env.VITE_PLAYER_ID || '00000000-0000-0000-0000-000000000001';
const KIOSK_JUKEBOX_STORAGE_KEY = 'obie_kiosk_jukebox_slug';

function App() {
  const {
    activePlayerId,
    activeJukeboxSlug,
    identityReady,
    playerId: PLAYER_ID,
    session,
    settings,
    playerStatus,
    queue,
    setSession,
  } = useKioskSession({
    defaultPlayerId: DEFAULT_PLAYER_ID,
    storageKey: KIOSK_JUKEBOX_STORAGE_KEY,
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(true);
  const [showKeyboard, setShowKeyboard] = useState(true);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [includeKaraoke, setIncludeKaraoke] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [showInsertCoinMsg, setShowInsertCoinMsg] = useState(false);
  const insertCoinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { showConnectPrompt, connectCoinAcceptor, dismissConnectPrompt } = useCoinAcceptor({
    enabled: !!settings?.kiosk_coin_acceptor_enabled,
    freeplay: !!settings?.freeplay,
    playerId: PLAYER_ID,
    session,
    onCreditsUpdated: (credits) => {
      setSession((prev) => (prev ? { ...prev, credits } : prev));
    },
    dollar1Credits: settings?.coin_credits_dollar1 ?? 1,
    dollar2Credits: settings?.coin_credits_dollar2 ?? 3,
  });

    // Perform search — runs YouTube and Cloudflare R2 in parallel and merges results.
    // R2 (local library) results appear first; YouTube results follow.
    const performSearch = async (query: string) => {
      try {
        setIsSearching(true);
        setSearchResults([]);

        let ytQuery = query;
        if (includeKaraoke) {
          ytQuery = query + ' Lyric Video Karaoke';
        }

        const [ytSettled, r2Settled] = await Promise.allSettled([
          callKioskHandler({ action: 'search', query: ytQuery }) as Promise<{ videos?: any[] }>,
          callKioskHandler({ action: 'search_r2', query }) as Promise<{ videos?: any[] }>,
        ]);

        const ytVideos = ytSettled.status === 'fulfilled' ? (ytSettled.value?.videos || []) : [];
        const r2Videos = r2Settled.status === 'fulfilled' ? (r2Settled.value?.videos || []) : [];

        // Cloudflare library results first, then YouTube results
        setSearchResults([...r2Videos, ...ytVideos]);
        setShowSearchResults(true);
        setShowKeyboard(false);
      } catch (error) {
        console.error('Search failed:', error);
        setSearchResults([]);
        setShowSearchResults(false);
      } finally {
        setIsSearching(false);
      }
    };

    const handleSelectResult = (item: any) => {
      setSelectedResult(item);
      setShowConfirm(true);
    };

    const handleConfirmAdd = async () => {
      if (!selectedResult || !session || isConfirming) return;

      setIsConfirming(true);
      // Generate idempotency key once per user action.  If the network times out
      // and the UI retries, the same key is reused so the server deduplicates
      // rather than inserting the same song twice and deducting credits again.
      const idempotencyKey = crypto.randomUUID();
      try {
        let res: any;
        if (selectedResult.source === 'cloudflare') {
          // R2 video — use request_r2 action with the r2_file_id
          res = await callKioskHandler({
            session_id: session.session_id,
            action: 'request_r2',
            r2_file_id: selectedResult.id,
            player_id: PLAYER_ID,
          });
        } else {
          // YouTube video — pass idempotency_key so server can deduplicate retries.
          res = await callKioskHandler({ session_id: session.session_id, action: 'request', url: selectedResult.url, player_id: PLAYER_ID, idempotency_key: idempotencyKey } as any);
        }
        if (res?.error) {
          alert('Failed to add to priority queue: ' + (res.error.message || res.error));
          console.error('Server failed to enqueue request:', res.error);
          setShowConfirm(false);
          return;
        }
      } catch (err) {
        alert('Failed to enqueue request via kiosk handler: ' + ((err as any)?.message || err));
        console.error('Failed to enqueue request via kiosk handler:', err);
      } finally {
        // Close modal and reset
        setShowConfirm(false);
        setShowSearchResults(false);
        setShowKeyboard(true);
        setShowSearchModal(false);
        setSearchQuery('');
        setIsConfirming(false);
      }
    };

    // Simulate coin insertion (for testing)
    const handleCoinInsert = async () => {
      if (!session) return;

      try {
        const { credits } = await callKioskHandler({
          session_id: session.session_id,
          action: 'credit',
          amount: 1,
          source: 'virtual_button',
        } as any);
        setSession({ ...session, credits });
      } catch (error) {
        console.error('Failed to add credit:', error);
      }
    };

    // Render UI (simplified, balanced JSX)
    if (!identityReady) {
      return (
        <div className="min-h-screen bg-black text-white flex items-center justify-center">
          <div className="text-center">
            <div className="text-2xl font-semibold mb-3">Resolving Jukebox...</div>
            <div className="text-gray-400">Please wait.</div>
          </div>
        </div>
      );
    }

    if (!activePlayerId) {
      return (
        <div className="min-h-screen bg-black text-white flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <div className="text-3xl font-bold mb-4">Jukebox Name Required</div>
            <div className="text-gray-300 mb-6">Open this page with a path like /OBIE, or set one now.</div>
            <button
              onClick={() => {
                const entered = window.prompt('Enter Jukebox Name (e.g. OBIE):');
                const slug = normalizeJukeboxSlug(entered);
                if (!slug) return;
                localStorage.setItem(KIOSK_JUKEBOX_STORAGE_KEY, slug);
                window.location.assign(`/${slug}`);
              }}
              className="px-5 py-3 rounded-lg bg-yellow-400 text-black font-semibold hover:bg-yellow-300"
            >
              Enter Jukebox Name
            </button>
            {activeJukeboxSlug && <div className="text-gray-500 mt-4 text-sm">Current: {activeJukeboxSlug}</div>}
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-black text-white relative">
        {/* Background Playlist */}
        <BackgroundPlaylist
          assets={DEFAULT_BACKGROUND_ASSETS}
          fillScreen={true}
          fadeDuration={1}
        />

        <main className="mx-auto max-w-5xl p-6 relative z-10">
          {/* Now Playing Display - Top Left */}
          <div className="fixed top-4 left-4 z-20">
            <div className="bg-black/60 border-2 border-yellow-400 rounded-lg p-3 shadow-lg max-w-xs">
              <div className="flex flex-col">
                <p className="text-white text-sm font-bold mb-1">NOW PLAYING</p>
                <p className="text-yellow-300 text-sm font-semibold truncate">
                  {cleanDisplayText(playerStatus?.current_media?.title) || 'No song playing'}
                </p>
                {playerStatus?.current_media?.artist && (
                  <p className="text-gray-300 text-xs truncate">
                    {cleanDisplayText(playerStatus.current_media.artist)}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Credits Display - Top Right */}
          <div className="fixed top-4 right-4 z-20">
            <div className={`bg-black/60 border-2 rounded-lg p-3 shadow-lg ${
              settings?.freeplay
                ? 'border-yellow-400'
                : settings?.kiosk_coin_acceptor_connected
                  ? 'border-green-500'
                  : 'border-red-500'
            }`}>
              <div className="flex items-center gap-2">
                <Coins className="text-yellow-300 h-6 w-6" />
                <div className="flex flex-col">
                  <p className="text-white text-sm font-bold">
                    {settings?.freeplay ? 'FREE PLAY' : 'CREDITS'}
                  </p>
                  {!settings?.freeplay && (
                    <p className="text-yellow-300 text-lg font-bold">
                      {session?.credits ?? 0}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Search Button - Lower Middle */}
          <div className="fixed bottom-24 left-1/2 transform -translate-x-1/2 z-20">
            <button
              onClick={() => setShowSearchModal(true)}
              className="w-80 h-16 text-xl font-bold bg-black/60 text-white shadow-lg border-4 border-yellow-400 rounded-lg transform hover:scale-105 transition-all duration-200"
              style={{ filter: "drop-shadow(-5px -5px 10px rgba(0,0,0,0.8))" }}
            >
              🎵 SEARCH FOR MUSIC 🎵
            </button>
          </div>

          {/* Search Modal */}
          <SearchInterface
            isOpen={showSearchModal}
            onClose={() => {
              setShowSearchModal(false);
              setShowKeyboard(true);
              setShowSearchResults(false);
              setSearchQuery('');
            }}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            searchResults={searchResults}
            isSearching={isSearching}
            showKeyboard={showKeyboard}
            showSearchResults={showSearchResults}
            onKeyboardInput={(key) => {
              if (key === 'CLEAR') {
                setSearchQuery('');
              } else if (key === 'SPACE') {
                setSearchQuery(prev => prev + ' ');
              } else if (key === 'BACKSPACE') {
                setSearchQuery(prev => prev.slice(0, -1));
              } else if (key === 'SEARCH') {
                performSearch(searchQuery);
              } else {
                setSearchQuery(prev => prev + key);
              }
            }}
            onVideoSelect={handleSelectResult}
            onBackToSearch={() => {
              setShowSearchResults(false);
              setShowKeyboard(true);
            }}
            mode={settings?.freeplay ? "FREEPLAY" : "PAID"}
            credits={session?.credits ?? 0}
            onInsufficientCredits={() => {
              if (insertCoinTimerRef.current) clearTimeout(insertCoinTimerRef.current);
              setShowInsertCoinMsg(true);
              insertCoinTimerRef.current = setTimeout(() => setShowInsertCoinMsg(false), 3000);
            }}
            includeKaraoke={includeKaraoke}
            onIncludeKaraokeChange={setIncludeKaraoke}
            bypassCreditCheck={settings?.freeplay}
            cloudflareEnabled={false}
          />

          {/* Insufficient credits popover */}
          {showInsertCoinMsg && (
            <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
              <div className="bg-black/90 border border-yellow-500 text-yellow-400 text-2xl font-bold px-10 py-6 rounded-2xl shadow-2xl animate-pulse">
                💰 Please insert coin to make requests
              </div>
            </div>
          )}

          {/* Bottom marquee of upcoming songs */}
          <QueueMarquee queue={queue} />

          {/* Confirmation Dialog */}
          {showConfirm && selectedResult && (
            <ConfirmationDialog
              selectedResult={selectedResult}
              freeplay={!!settings?.freeplay}
              isConfirming={isConfirming}
              onConfirm={handleConfirmAdd}
              onCancel={() => setShowConfirm(false)}
            />
          )}

          {/* Coin Acceptor Connect Prompt */}
          <Dialog open={showConnectPrompt} onOpenChange={() => {}}>
            <DialogContent className="p-8 max-w-sm text-center">
              <div className="text-4xl mb-4">🪙</div>
              <h2 className="text-white text-2xl font-bold mb-2">Coin Acceptor Detected</h2>
              <p className="text-gray-300 mb-6 text-sm">
                A coin acceptor is enabled for this kiosk. Connect it now to start accepting coins.
              </p>
              <button
                onClick={connectCoinAcceptor}
                className="w-full py-3 px-6 bg-yellow-400 hover:bg-yellow-300 text-black font-bold rounded-lg text-lg transition-colors"
              >
                Connect Coin Acceptor
              </button>
              <button
                onClick={dismissConnectPrompt}
                className="mt-3 w-full py-2 px-6 text-gray-400 hover:text-gray-300 text-sm transition-colors"
              >
                Skip for now
              </button>
            </DialogContent>
          </Dialog>

          {/* Insert coin dev button — hidden when a physical coin acceptor is connected */}
          {!settings?.freeplay && settings?.kiosk_show_virtual_coin_button && !settings?.kiosk_coin_acceptor_connected && (
            <div className="fixed bottom-4 right-4 z-20">
              <button
                onClick={handleCoinInsert}
                className="bg-yellow-500 hover:bg-yellow-600 text-black font-bold px-6 py-3 rounded-full shadow-lg transition-all flex items-center gap-3 drop-shadow-lg border-2 border-yellow-400"
              >
                <Coins size={18} />
                <span>Insert Coin</span>
              </button>
            </div>
          )}

        </main>
      </div>
    );
}

export default App;
