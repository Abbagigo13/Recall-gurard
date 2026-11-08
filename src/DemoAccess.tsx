import { useState } from 'react';
import { loginDemo, logoutDemo } from './demoAuth';

// Compact header control: passphrase unlock / lock display. Rendered in
// the dashboard header; it does not restyle the dashboard or landing page.
export default function DemoAccess({ authed, onChange }: { authed: boolean | null; onChange: (value: boolean) => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    const result = await loginDemo(passphrase);
    setBusy(false);
    if (result.ok) {
      setPassphrase('');
      onChange(true);
    } else {
      setError(result.error || 'Login failed.');
    }
  };

  const logout = async () => {
    await logoutDemo();
    onChange(false);
  };

  if (authed === true) {
    return (
      <span className="inline-flex items-center gap-sm">
        <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700" title="Demo write access is unlocked for this browser session">
          <span className="size-2 rounded-full bg-success-primary" />
          Demo access
        </span>
        <button type="button" onClick={logout} className="text-xs text-tertiary underline" title="Lock demo write access">
          Lock
        </button>
      </span>
    );
  }

  return (
    <form onSubmit={submit} className="hidden sm:inline-flex items-center gap-xs" title="Unlock research, memory, and RPC writes with the demo passphrase">
      <input
        type="password"
        value={passphrase}
        onChange={e => { setPassphrase(e.target.value); setError(null); }}
        placeholder={authed === null ? 'Checking…' : 'Demo passphrase'}
        disabled={busy || authed === null}
        autoComplete="current-password"
        className="app-sidebar-select !w-40 text-xs"
        aria-label="Demo passphrase"
      />
      <button type="submit" disabled={busy || !passphrase} className="text-xs font-medium text-tertiary underline disabled:opacity-50">
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      {error && <span className="text-xs text-red-500" role="alert">{error}</span>}
    </form>
  );
}
