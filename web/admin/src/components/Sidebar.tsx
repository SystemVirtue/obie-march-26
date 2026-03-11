import { useState } from 'react';
import type { ViewId, QueueItem, AuthUser, JukeboxSummary } from '../types';

const NAV = [
  { id: 'queue',     icon: '🎵', label: 'Queue',     children: [] as { id: ViewId; label: string }[] },
  { id: 'playlists', icon: '📋', label: 'Playlists', children: [
    { id: 'playlists-all'    as ViewId, label: 'All Playlists' },
    { id: 'playlists-import' as ViewId, label: 'Import Playlist' },
  ]},
  { id: 'settings',  icon: '⚙️', label: 'Settings',  children: [
    { id: 'settings-playback' as ViewId, label: 'Playback' },
    { id: 'settings-kiosk'    as ViewId, label: 'Kiosk' },
    { id: 'settings-branding' as ViewId, label: 'Branding' },
    { id: 'settings-scripts'  as ViewId, label: 'Functions & Scripts' },
    { id: 'settings-prefs'    as ViewId, label: 'Console Preferences' },
  ]},
  { id: 'logs',      icon: '📄', label: 'Logs',      children: [] as { id: ViewId; label: string }[] },
];

export function Sidebar({ view, setView, queue, user, onSignOut, jukeboxes, activeJukeboxSlug, onSwitchJukebox, onCreateJukebox }: {
  view: ViewId; setView: (v: ViewId) => void;
  queue: QueueItem[]; user: AuthUser; onSignOut: () => void;
  jukeboxes: JukeboxSummary[];
  activeJukeboxSlug: string | null;
  onSwitchJukebox: (slug: string) => void;
  onCreateJukebox: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [openGroup, setOpenGroup] = useState<string>('queue');
  const [showJukeboxPicker, setShowJukeboxPicker] = useState(false);
  const priorityCount = queue.filter(q => q.type === 'priority').length;
  const currentJukebox = jukeboxes.find((j) => j.jukebox_slug === activeJukeboxSlug) || jukeboxes[0] || null;

  const handleGroup = (group: typeof NAV[0]) => {
    if (group.children.length === 0) { setOpenGroup(''); setView(group.id as ViewId); return; }
    const isOpen = openGroup === group.id;
    setOpenGroup(isOpen ? '' : group.id);
    if (!isOpen) setView(group.children[0].id);
  };

  const isGroupActive = (group: typeof NAV[0]) =>
    group.children.some(c => c.id === view) || (group.children.length === 0 && view === group.id as ViewId);

  return (
    <aside style={{ display: 'flex', flexDirection: 'column', flexShrink: 0,
      width: expanded ? 220 : 60, height: '100%', background: 'var(--surface)',
      borderRight: '1px solid var(--border)', transition: 'width 0.25s cubic-bezier(0.4,0,0.2,1)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 13px', height: 54, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 14px var(--accent-glow)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, color: '#000' }}>O</span>
        </div>
        {expanded && <>
          <div style={{ overflow: 'hidden', flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: '#fff', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>Obie</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Admin Console</div>
          </div>
          <button onClick={() => setExpanded(false)} style={{ marginLeft: 'auto', width: 22, height: 22, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.25)', cursor: 'pointer', borderRadius: 6, fontSize: 14 }}>‹</button>
        </>}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto', overflowX: 'hidden' }}>
        {NAV.map(group => {
          const active = isGroupActive(group);
          const open   = openGroup === group.id;
          return (
            <div key={group.id}>
              <button onClick={() => handleGroup(group)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                padding: expanded ? '9px 13px' : '9px 0', justifyContent: expanded ? 'flex-start' : 'center',
                background: 'transparent', border: 'none', cursor: 'pointer', position: 'relative',
                color: active ? 'var(--accent)' : 'rgba(255,255,255,0.4)' }}>
                {active && <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: 2, height: 18, borderRadius: '0 2px 2px 0', background: 'var(--accent)' }} />}
                <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, background: active ? 'var(--accent-dim)' : 'transparent' }}>{group.icon}</div>
                {expanded && <>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>{group.label}</span>
                  {group.children.length > 0 && <span style={{ fontSize: 11, opacity: 0.45, flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>›</span>}
                  {group.id === 'queue' && priorityCount > 0 && !open && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 5px', borderRadius: 99, background: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}>{priorityCount}</span>
                  )}
                </>}
              </button>
              {expanded && open && group.children.length > 0 && (
                <div style={{ background: 'rgba(255,255,255,0.015)', borderLeft: '1px solid rgba(255,255,255,0.06)', marginLeft: 21 }}>
                  {group.children.map(child => (
                    <button key={child.id} onClick={() => setView(child.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7,
                      padding: '7px 13px', background: 'transparent', border: 'none', cursor: 'pointer',
                      color: view === child.id ? 'var(--accent)' : 'rgba(255,255,255,0.38)' }}>
                      <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: view === child.id ? 'var(--accent)' : 'rgba(255,255,255,0.15)' }} />
                      <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>{child.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      {expanded ? (
        <div style={{ padding: '10px 13px', borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, position: 'relative' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.25)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
          <button
            onClick={() => setShowJukeboxPicker((v) => !v)}
            style={{ width: '100%', padding: '6px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.06)', color: '#e5e7eb', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 11, marginBottom: 6 }}
            title='Switch Jukebox'
          >
            Jukebox : {currentJukebox?.jukebox_slug || activeJukeboxSlug || 'N/A'}
          </button>
          {showJukeboxPicker && (
            <div style={{ position: 'absolute', left: 13, right: 13, bottom: 76, borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#111', boxShadow: '0 10px 30px rgba(0,0,0,0.4)', overflow: 'hidden', zIndex: 30 }}>
              <div style={{ padding: '8px 10px', fontFamily: 'var(--font-display)', fontSize: 11, color: 'rgba(255,255,255,0.6)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                Select a Jukebox
              </div>
              {jukeboxes.map((j) => (
                <button
                  key={j.player_id}
                  onClick={() => {
                    setShowJukeboxPicker(false);
                    if (j.jukebox_slug !== activeJukeboxSlug) onSwitchJukebox(j.jukebox_slug);
                  }}
                  style={{ width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.05)', background: j.jukebox_slug === activeJukeboxSlug ? 'rgba(245,158,11,0.12)' : 'transparent', color: j.jukebox_slug === activeJukeboxSlug ? '#fbbf24' : '#e5e7eb', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                >
                  {j.jukebox_slug}
                </button>
              ))}
              <button
                onClick={() => { setShowJukeboxPicker(false); onCreateJukebox(); }}
                style={{ width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'transparent', color: '#34d399', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 11 }}
              >
                + Create New Jukebox
              </button>
              <button
                onClick={() => setShowJukeboxPicker(false)}
                style={{ width: '100%', textAlign: 'center', padding: '8px 10px', border: 'none', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 11 }}
              >
                Cancel
              </button>
            </div>
          )}
          <button onClick={onSignOut} style={{ width: '100%', padding: '6px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.08)', color: '#f87171', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 11 }}>Sign Out</button>
        </div>
      ) : (
        <button onClick={() => setExpanded(true)} style={{ padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.25)', cursor: 'pointer', fontSize: 14 }}>›</button>
      )}
    </aside>
  );
}
