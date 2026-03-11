// Obie Kiosk - Public Search & Request Interface
// Server-driven credit system and priority queue

import { useEffect, useRef, useState } from 'react';
import {
  subscribeToKioskSession,
  subscribeToPlayerSettings,
  subscribeToQueue,
  subscribeToPlayerStatus,
  subscribeToTable,
  callKioskHandler,
  getTotalCredits,
  resolveJukeboxSlug,
  supabase,
  type KioskSession,
  type PlayerSettings,
  type QueueItem,
  type PlayerStatus,
} from '../../shared/supabase-client';
import { Coins } from 'lucide-react';
import { SearchInterface } from './components/SearchInterface';
import { SearchResult } from '../../shared/types';
import { BackgroundPlaylist, DEFAULT_BACKGROUND_ASSETS } from './components/BackgroundPlaylist';
import { cleanDisplayText } from '../../shared/media-utils';
import { normalizeJukeboxSlug, getPathJukeboxSlug } from '../../shared/jukebox-utils';

const DEFAULT_PLAYER_ID = import.meta.env.VITE_PLAYER_ID || '00000000-0000-0000-0000-000000000001';
const KIOSK_JUKEBOX_STORAGE_KEY = 'obie_kiosk_jukebox_slug';

function App() {
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [activeJukeboxSlug, setActiveJukeboxSlug] = useState<string | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [session, setSession] = useState<KioskSession | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const PLAYER_ID = activePlayerId || DEFAULT_PLAYER_ID;

  // Log queue state changes
  useEffect(() => {
    console.log('[Queue State] Queue state updated to:', queue.length, 'items');
    if (queue.length > 5) {
      console.warn('[Queue State] ⚠️ WARNING: Queue has more than 5 items!', queue.length);
    }
  }, [queue]);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(true);
  const [showKeyboard, setShowKeyboard] = useState(true);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [includeKaraoke, setIncludeKaraoke] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  // Serial connection refs
  const serialPortRef = useRef<any>(null);
  const serialReaderRef = useRef<any>(null);
  // These refs avoid stale closures in the async serial reader loop
  const sessionRef = useRef<KioskSession | null>(null);
  const settingsRef = useRef<PlayerSettings | null>(null);
  const playerStatusRef = useRef<PlayerStatus | null>(null);

    // Resolve player identity from URL slug, remembered slug, or prompt.
    useEffect(() => {
      let cancelled = false;

      const resolveIdentity = async () => {
        try {
          const pathSlug = getPathJukeboxSlug();
          const rememberedSlug = normalizeJukeboxSlug(localStorage.getItem(KIOSK_JUKEBOX_STORAGE_KEY));
          let candidateSlug = pathSlug || rememberedSlug;

          if (!candidateSlug) {
            const entered = window.prompt('Enter Jukebox Name (e.g. OBIE):');
            candidateSlug = normalizeJukeboxSlug(entered);
          }

          if (!candidateSlug) {
            return;
          }

          const resolved = await resolveJukeboxSlug(candidateSlug);
          if (!resolved) {
            alert(`Jukebox "${candidateSlug}" was not found.`);
            localStorage.removeItem(KIOSK_JUKEBOX_STORAGE_KEY);
            return;
          }

          if (!cancelled) {
            setActivePlayerId(resolved.player_id);
            setActiveJukeboxSlug(resolved.jukebox_slug);
          }

          localStorage.setItem(KIOSK_JUKEBOX_STORAGE_KEY, resolved.jukebox_slug);
          if (pathSlug !== resolved.jukebox_slug) {
            window.history.replaceState({}, '', `/${resolved.jukebox_slug}`);
          }
        } catch (error) {
          console.error('Failed to resolve kiosk jukebox identity:', error);
        } finally {
          if (!cancelled) {
            setIdentityReady(true);
          }
        }
      };

      resolveIdentity();
      return () => {
        cancelled = true;
      };
    }, []);

    // Initialize session
    useEffect(() => {
      if (!identityReady || !activePlayerId) return;

      const initSession = async () => {
        try {
          const { session: newSession } = await callKioskHandler({
            player_id: PLAYER_ID,
            action: 'init',
          });
          setSession(newSession);
          setShowSearchModal(true); // Open search modal after session init
        } catch (error) {
          console.error('Failed to initialize session:', error);
        }
      };

      initSession();
    }, [identityReady, activePlayerId, PLAYER_ID]);

    // Keep refs in sync so the async serial reader always has current session + settings
    useEffect(() => { sessionRef.current = session; }, [session]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    useEffect(() => { playerStatusRef.current = playerStatus; }, [playerStatus]);

    // Subscribe to session updates (for credits) and to any kiosk_sessions changes for this player
    // Replace polling with realtime subscription: when any kiosk_sessions row for the player
    // changes, re-fetch the aggregated total credits and update local session state.
    useEffect(() => {
      if (!identityReady || !activePlayerId) return;
      if (!session) return;

      const sub = subscribeToKioskSession(session.session_id, (s) => {
        setSession(s);
      });

      const tableSub = subscribeToTable('kiosk_sessions', { column: 'player_id', value: PLAYER_ID }, async () => {
        try {
          const total = await getTotalCredits(PLAYER_ID);
          setSession(prev => prev ? { ...prev, credits: total } : prev);
        } catch (err) {
          console.error('Failed to fetch total credits after realtime event:', err);
        }
      });

      return () => {
        sub.unsubscribe();
        tableSub.unsubscribe();
      };
    }, [identityReady, activePlayerId, PLAYER_ID, session?.session_id]);

    // Subscribe to player settings
    useEffect(() => {
      if (!identityReady || !activePlayerId) return;
      const sub = subscribeToPlayerSettings(PLAYER_ID, setSettings);
      return () => sub.unsubscribe();
    }, [identityReady, activePlayerId, PLAYER_ID]);

    // Coin acceptor: auto-connect when enabled, disconnect when disabled
    useEffect(() => {
      if (!settings?.kiosk_coin_acceptor_enabled) {
        disconnectCoinAcceptor();
        return;
      }
      autoConnectCoinAcceptor();
    }, [settings?.kiosk_coin_acceptor_enabled]);

    // Listen for Web Serial hot-plug events (device plugged in / removed)
    useEffect(() => {
      if (!('serial' in navigator)) return;
      const serial = (navigator as any).serial;

      const onConnect = (e: any) => {
        if (settings?.kiosk_coin_acceptor_enabled) {
          console.log('Serial device plugged in, connecting...');
          openCoinAcceptorPort(e.target);
        }
      };
      const onDisconnect = (e: any) => {
        if (serialPortRef.current === e.target) {
          console.log('Serial device unplugged');
          serialPortRef.current = null;
        }
      };

      serial.addEventListener('connect', onConnect);
      serial.addEventListener('disconnect', onDisconnect);
      return () => {
        serial.removeEventListener('connect', onConnect);
        serial.removeEventListener('disconnect', onDisconnect);
      };
    }, [settings?.kiosk_coin_acceptor_enabled]);

    // Subscribe to player status (now playing)
    useEffect(() => {
      if (!identityReady || !activePlayerId) return;
      const sub = subscribeToPlayerStatus(PLAYER_ID, (s) => setPlayerStatus(s));
      return () => sub.unsubscribe();
    }, [identityReady, activePlayerId, PLAYER_ID]);

    // Subscribe to queue for marquee / upcoming list
    useEffect(() => {
      if (!identityReady || !activePlayerId) return;
      const sub = subscribeToQueue(PLAYER_ID, (items) => {
        console.log('[Queue Callback] ===== START QUEUE PROCESSING =====');
        console.log('[Queue Callback] Received items from subscription:', items.length);

        // Use ref to get latest playerStatus (avoids stale closure)
        const currentPlayerStatus = playerStatusRef.current;
        const currentMediaId = currentPlayerStatus?.current_media_id || currentPlayerStatus?.current_media?.id || null;
        console.log('[Queue Callback] Current media ID:', currentMediaId);
        console.log('[Queue Callback] PlayerStatus exists:', !!currentPlayerStatus);

        // Filter to only upcoming items (not currently playing)
        let upcomingItems = items;
        if (currentMediaId) {
          upcomingItems = items.filter(item => {
            const matches = item.media_item_id === currentMediaId;
            if (matches) console.log('[Queue Callback] Filtering out current item:', item.id);
            return !matches;
          });
        }
        console.log('[Queue Callback] After filtering current item:', upcomingItems.length);

        // Separate priority and normal items
        const priorityItems = upcomingItems.filter(item => item.type === 'priority');
        const normalItems = upcomingItems.filter(item => item.type === 'normal');
        console.log('[Queue Callback] Priority items:', priorityItems.length, 'Normal items:', normalItems.length);

        // Limit to max 5 total items: all priority items + remaining slots filled with normal items
        const maxMarqueeItems = 5;
        const prioritySliced = priorityItems.slice(0, maxMarqueeItems);
        const remainingSlots = Math.max(0, maxMarqueeItems - prioritySliced.length);
        const normalSliced = normalItems.slice(0, remainingSlots);
        const displayItems = [...prioritySliced, ...normalSliced];

        console.log('[Queue Callback] Priority sliced:', prioritySliced.length, 'Normal sliced:', normalSliced.length);
        console.log('[Queue Callback] After limiting to 5 items:', displayItems.length);
        console.log('[Queue Callback] Display item IDs:', displayItems.map(item => item.id));
        console.log('[Queue Callback] ===== END QUEUE PROCESSING =====');

        setQueue(displayItems);
      });
      return () => sub.unsubscribe();
    }, [identityReady, activePlayerId, PLAYER_ID]);

    // Debounced search
    useEffect(() => {
      const timer = setTimeout(() => {
        if (searchQuery.length >= 2) {
          // perform a lightweight search preview (do not auto-open results)
          // We'll only perform a search when user presses SEARCH on the keyboard
        }
      }, 500);

      return () => clearTimeout(timer);
    }, [searchQuery]);

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
          // YouTube video — use existing request action
          res = await callKioskHandler({ session_id: session.session_id, action: 'request', url: selectedResult.url, player_id: PLAYER_ID });
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

    // Simulate coin insertion (for testing - replace with WebSerial API)
    const handleCoinInsert = async () => {
      if (!session) return;

      try {
        const { credits } = await callKioskHandler({
          session_id: session.session_id,
          action: 'credit',
          amount: 1,
        });
        setSession({ ...session, credits });
      } catch (error) {
        console.error('Failed to add credit:', error);
      }
    };
    
    // --- Coin acceptor serial functions ---

    // Auto-connect using previously-granted ports (no user gesture required).
    // Called automatically when kiosk_coin_acceptor_enabled is true.
    const autoConnectCoinAcceptor = async () => {
      if (!('serial' in navigator)) {
        console.warn('Web Serial API not supported in this browser');
        return;
      }
      try {
        const ports = await (navigator as any).serial.getPorts();
        if (ports.length > 0) {
          console.log(`Found ${ports.length} previously-granted serial port(s), connecting...`);
          await openCoinAcceptorPort(ports[0]);
        } else {
          console.log('No previously-granted serial ports. Connect via admin or grant permission first.');
        }
      } catch (err) {
        console.error('Auto-connect failed:', err);
      }
    };

    // Open a specific port and start the reader loop.
    const openCoinAcceptorPort = async (port: any) => {
      if (serialPortRef.current === port && port.readable) return; // already open
      try {
        serialPortRef.current = port;
        if (!port.readable) {
          await port.open({ baudRate: 9600 });
        }
        console.log('Coin acceptor connected');
        await (supabase as any)
          .from('player_settings')
          .update({ kiosk_coin_acceptor_connected: true, kiosk_coin_acceptor_device_id: 'usbserial-1420' })
          .eq('player_id', PLAYER_ID);
        const reader = port.readable.getReader();
        serialReaderRef.current = reader;
        readCoinAcceptorData(reader);
      } catch (err) {
        console.error('Failed to open coin acceptor port:', err);
        serialPortRef.current = null;
      }
    };

    const disconnectCoinAcceptor = async () => {
      try {
        if (serialReaderRef.current) {
          await serialReaderRef.current.cancel();
          serialReaderRef.current = null;
        }
        if (serialPortRef.current) {
          await serialPortRef.current.close();
          serialPortRef.current = null;
        }
        console.log('Coin acceptor disconnected');
      } catch (error) {
        console.error('Failed to disconnect coin acceptor:', error);
      }
    };

    // Read serial data and map coin signals to credits:
    //   'a' = $2 coin = 3 credits
    //   'b' = $1 coin = 1 credit
    const readCoinAcceptorData = async (reader: any) => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          const data = decoder.decode(value, { stream: true });
          for (const char of data) {
            let amount = 0;
            if (char === 'a') amount = 3;       // $2 coin
            else if (char === 'b') amount = 1;  // $1 coin

            if (amount > 0) {
              // In freeplay mode, drain the serial data but don't add credits
              if (settingsRef.current?.freeplay) {
                console.log(`Coin accepted: '${char}' (freeplay — credit ignored)`);
                continue;
              }
              const currentSession = sessionRef.current;
              if (!currentSession) continue;
              console.log(`Coin accepted: '${char}' → +${amount} credit(s)`);
              const result = await callKioskHandler({
                session_id: currentSession.session_id,
                action: 'credit',
                amount,
              }) as { credits?: number };
              if (result?.credits !== undefined) {
                setSession(prev => prev ? { ...prev, credits: result.credits! } : prev);
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.error('Coin acceptor read error:', err);
        }
      } finally {
        try { reader.releaseLock(); } catch (_) { /* already released */ }
        serialReaderRef.current = null;
        // Mark disconnected in DB
        await (supabase as any)
          .from('player_settings')
          .update({ kiosk_coin_acceptor_connected: false, kiosk_coin_acceptor_device_id: null })
          .eq('player_id', PLAYER_ID);
        console.log('Coin acceptor reader closed');
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
            <div className="bg-black/60 border-2 border-yellow-400 rounded-lg p-3 shadow-lg">
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
              // Handle insufficient credits - could show a message
              console.log('Insufficient credits');
            }}
            includeKaraoke={includeKaraoke}
            onIncludeKaraokeChange={setIncludeKaraoke}
            bypassCreditCheck={settings?.freeplay}
            cloudflareEnabled={false}
          />

          {/* Bottom marquee of upcoming songs */}
          <div className="fixed bottom-0 left-0 right-0 bg-black/90 border-t border-yellow-400/50 py-3 backdrop-blur-sm">
            <div className="mx-auto max-w-full overflow-hidden">
              <div className="marquee">
                <div className="marquee-track flex items-center whitespace-nowrap gap-8 text-yellow-400 font-semibold text-sm drop-shadow-lg">
                  {queue.length > 0 ? (
                    <>
                      {queue.map((q, index) => (
                        <div key={`${q.id}-1`} className="px-6 flex items-center gap-2">
                          {q.type === 'priority' && <span className="text-red-400 drop-shadow-lg">★</span>}
                          <span>{cleanDisplayText((q.media_item as any)?.title) || 'Untitled'} - <span className="text-gray-300 drop-shadow-lg">{cleanDisplayText((q.media_item as any)?.artist) || 'Unknown'}</span></span>
                          {q.type === 'priority' && index === queue.filter(item => item.type === 'priority').length - 1 && queue.some(item => item.type === 'normal') && <span className="text-gray-400 mx-4 drop-shadow-lg">•</span>}
                        </div>
                      ))}
                      {/* Duplicate content for seamless loop */}
                      {queue.map((q, index) => (
                        <div key={`${q.id}-2`} className="px-6 flex items-center gap-2">
                          {q.type === 'priority' && <span className="text-red-400 drop-shadow-lg">★</span>}
                          <span>{cleanDisplayText((q.media_item as any)?.title) || 'Untitled'} - <span className="text-gray-300 drop-shadow-lg">{cleanDisplayText((q.media_item as any)?.artist) || 'Unknown'}</span></span>
                          {q.type === 'priority' && index === queue.filter(item => item.type === 'priority').length - 1 && queue.some(item => item.type === 'normal') && <span className="text-gray-400 mx-4 drop-shadow-lg">•</span>}
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="px-6 drop-shadow-lg">Coming Up: No items</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Confirmation Dialog */}
          {showConfirm && selectedResult && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60">
                <div className="bg-yellow-50 text-black rounded-lg p-6 w-[520px]">
                  <div className="text-lg font-bold mb-2">Add song to Playlist?</div>
                  <div className="text-sm text-gray-700 mb-4">Confirm adding this song to your playlist for playback.</div>
                  <div className="flex gap-4 items-center">
                    {selectedResult.thumbnail ? (
                      <img src={selectedResult.thumbnail} className="w-20 h-20 object-cover rounded" />
                    ) : (
                      <div className="w-20 h-20 rounded bg-black flex-shrink-0" />
                    )}
                    <div>
                      <div className="font-semibold">{cleanDisplayText(selectedResult.title)}</div>
                      <div className="text-sm text-gray-700">{cleanDisplayText(selectedResult.artist)}</div>
                      <div className="text-sm text-gray-700 mt-2">{settings?.freeplay ? 'Cost: FREE' : 'Cost: 1 Credit'}</div>
                    </div>
                  </div>
                  <div className="flex justify-end gap-3 mt-6">
                    <button onClick={() => setShowConfirm(false)} className="px-4 py-2 bg-red-100 rounded">No</button>
                    <button
                      onClick={handleConfirmAdd}
                      disabled={isConfirming}
                      className={`px-4 py-2 rounded ${isConfirming ? 'bg-gray-400 cursor-not-allowed' : 'bg-green-600 hover:bg-green-700'} text-white`}
                    >
                      {isConfirming ? 'Adding...' : 'Yes'}
                    </button>
                  </div>
                </div>
              </div>
          )}

          {/* Insert coin dev button (moved to avoid conflict with search button) */}
          {!settings?.freeplay && settings?.kiosk_show_virtual_coin_button && (
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
