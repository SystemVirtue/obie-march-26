import { useState } from 'react';
import { signIn, createJukebox, type AuthUser } from '@shared/supabase-client';
import { normalizeJukeboxSlug } from '@shared/jukebox-utils';
import { navigateClient } from '../types';
import { Spinner } from './ui';

export function LoginForm({ onSignIn }: { onSignIn: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setError(null);
    try {
      const result = await signIn(email, password);
      if (result.user) {
        onSignIn({ id: result.user.id, email: result.user.email || '',
          role: result.user.user_metadata?.role || result.user.app_metadata?.role });
      }
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to sign in'); }
    finally { setLoading(false); }
  };

  const handleCreateNewJukebox = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Enter email and password to create a new jukebox.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const auth = await signIn(email, password);
      if (!auth.user) throw new Error('Authentication failed');

      const entered = window.prompt('Enter new jukebox name (A-Z, 0-9, underscore, dash):');
      const slug = normalizeJukeboxSlug(entered);
      if (!slug) {
        setLoading(false);
        return;
      }

      const created = await createJukebox(slug, slug);
      onSignIn({
        id: auth.user.id,
        email: auth.user.email || '',
        role: auth.user.user_metadata?.role || auth.user.app_metadata?.role,
      });

      navigateClient(`/${created.jukebox_slug}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create jukebox');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(245,158,11,0.08),transparent)', pointerEvents: 'none' }} />
      <div style={{ width: 380, background: '#0e0e0e', border: '1px solid var(--border)', borderRadius: 20, padding: 36, position: 'relative' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', boxShadow: '0 0 24px var(--accent-glow)' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: '#000' }}>O</span>
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>Obie Admin</h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', marginTop: 4, letterSpacing: '0.1em' }}>CONSOLE ACCESS</p>
        </div>
        <form onSubmit={handleSubmit}>
          {['Email', 'Password'].map((label) => (
            <div key={label} style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{label}</label>
              <input type={label === 'Password' ? 'password' : 'email'} required
                name={label === 'Email' ? 'email' : 'password'}
                autoComplete={label === 'Email' ? 'email' : 'current-password'}
                value={label === 'Email' ? email : password}
                onChange={e => label === 'Email' ? setEmail(e.target.value) : setPassword(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 10, background: '#0a0a0a',
                  border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none' }} />
            </div>
          ))}
          {error && <p style={{ color: '#f87171', fontSize: 12, marginBottom: 12, fontFamily: 'var(--font-mono)' }}>{error}</p>}
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '12px', borderRadius: 12, border: 'none', cursor: loading ? 'default' : 'pointer',
              background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700,
              opacity: loading ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {loading ? <><Spinner size={16} /> Signing in…</> : 'Sign In'}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={handleCreateNewJukebox}
            style={{ width: '100%', marginTop: 10, padding: '11px 12px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.15)', cursor: loading ? 'default' : 'pointer',
              background: 'rgba(255,255,255,0.04)', color: '#fff', fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600,
              opacity: loading ? 0.6 : 1 }}
          >
            Create New Jukebox
          </button>
        </form>
      </div>
    </div>
  );
}
