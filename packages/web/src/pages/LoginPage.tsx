import { useState } from 'react';
import { setApiToken } from '../services/auth';
import { getCurrentDevice } from '../services/api';

interface LoginPageProps {
  onLogin: () => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;

    // Validate format: 64-char hex
    if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
      setError('Invalid token format (expected 64-character hex string)');
      return;
    }

    setLoading(true);
    setError('');

    try {
      // Temporarily set token to make the API call
      setApiToken(trimmed);
      await getCurrentDevice();
      // Token is valid — already stored
      onLogin();
    } catch {
      // Clear invalid token
      setApiToken('');
      localStorage.removeItem('ccm_api_token');
      setError('Invalid or expired token');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f172a',
    }}>
      <form onSubmit={handleSubmit} style={{
        background: '#1e293b',
        padding: '2rem',
        borderRadius: '0.75rem',
        width: '100%',
        maxWidth: '400px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
      }}>
        <h1 style={{ color: '#f1f5f9', fontSize: '1.5rem', marginBottom: '0.5rem' }}>
          CCManager
        </h1>
        <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
          Enter device token to continue
        </p>

        <label style={{ display: 'block', color: '#94a3b8', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
          Device Token
        </label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste token generated via CLI"
          autoFocus
          style={{
            width: '100%',
            padding: '0.75rem',
            borderRadius: '0.5rem',
            border: '1px solid #334155',
            background: '#0f172a',
            color: '#f1f5f9',
            fontSize: '1rem',
            marginBottom: '1rem',
            boxSizing: 'border-box',
            outline: 'none',
            fontFamily: 'monospace',
          }}
        />

        {error && (
          <p style={{ color: '#f87171', fontSize: '0.875rem', marginBottom: '1rem' }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !token.trim()}
          style={{
            width: '100%',
            padding: '0.75rem',
            borderRadius: '0.5rem',
            border: 'none',
            background: loading ? '#475569' : '#3b82f6',
            color: '#fff',
            fontSize: '1rem',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Verifying...' : 'Login'}
        </button>

        <p style={{ color: '#64748b', fontSize: '0.75rem', marginTop: '1rem', textAlign: 'center' }}>
          Run <code style={{ color: '#94a3b8' }}>ccmng token create --name "device"</code> on the server to get a token
        </p>
      </form>
    </div>
  );
}
