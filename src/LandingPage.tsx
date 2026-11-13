import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowRight, Shield } from 'lucide-react';

type View = 'home' | 'docs' | 'faq';

const PATHS: Record<View, string> = { home: '/', docs: '/docs', faq: '/faq' };
const GITHUB_URL = 'https://github.com/Abbagigo13/Recall-gurard';

function viewFromPath(pathname: string): View {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/docs') return 'docs';
  if (path === '/faq') return 'faq';
  return 'home';
}

// Real links (so open-in-new-tab and copy-link work) that switch views
// without a page reload on a normal click.
function NavLink({
  view,
  current,
  onNavigate,
  className,
  children,
}: {
  view: View;
  current: View;
  onNavigate: (view: View) => void;
  className?: string;
  children: ReactNode;
}) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(view);
  };
  return (
    <a
      href={PATHS[view]}
      className={className}
      onClick={handleClick}
      aria-current={current === view && view !== 'home' ? 'page' : undefined}
    >
      {children}
    </a>
  );
}

function SiteFooter({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <footer className="landing-footer">
      <nav className="footer-links" aria-label="Footer">
        <NavLink view="docs" current={view} onNavigate={onNavigate}>Docs</NavLink>
        <NavLink view="faq" current={view} onNavigate={onNavigate}>FAQ</NavLink>
      </nav>
      <p>RecallGuard · Autonomous Research Intelligence</p>
    </footer>
  );
}

function DocShell({
  view,
  onNavigate,
  onEnter,
  children,
}: {
  view: View;
  onNavigate: (view: View) => void;
  onEnter: () => void;
  children: ReactNode;
}) {
  return (
    <div className="doc-root">
      <div className="landing-backdrop" aria-hidden="true" />
      <header className="doc-topbar">
        <NavLink view="home" current={view} onNavigate={onNavigate} className="doc-brand">
          <span className="landing-mark">
            <Shield className="size-4" aria-hidden="true" />
          </span>
          RecallGuard
        </NavLink>
        <nav className="doc-topnav" aria-label="Pages">
          <NavLink view="docs" current={view} onNavigate={onNavigate}>Docs</NavLink>
          <NavLink view="faq" current={view} onNavigate={onNavigate}>FAQ</NavLink>
          <button type="button" className="doc-enter" onClick={onEnter}>
            Dashboard
          </button>
        </nav>
      </header>
      <main className="doc-body">{children}</main>
      <SiteFooter view={view} onNavigate={onNavigate} />
    </div>
  );
}

function DocsPage() {
  return (
    <>
      <p className="doc-label">[ DOCS ]</p>
      <h1 className="doc-title">RecallGuard, end to end.</h1>
      <p className="doc-lead">
        How a research run works, what every label means, and how to try it.
        Sui data is read from mainnet through Tatum, and memory is stored on
        the Walrus testnet.
      </p>

      <details className="doc-toc">
        <summary>On this page</summary>
        <ul>
          <li><a href="#overview">Overview</a></li>
          <li><a href="#how-a-run-works">How a research run works</a></li>
          <li><a href="#labels">What the labels mean</a></li>
          <li><a href="#quick-start">Quick start</a></li>
        </ul>
      </details>

      <h2 id="overview">Overview</h2>
      <p>
        RecallGuard is a research agent with persistent, evidence-aware memory.
        It remembers earlier sessions, reads live Sui data through Tatum, and
        explains what the evidence does and does not support.
      </p>
      <p>
        <strong>Retrieval is not verification.</strong> Data fetched from Tatum
        is labeled as a retrieved observation, never as independently verified.
        The app says so on every result.
      </p>
      <p>
        <strong>Strict lanes.</strong> Plain code plans the research, fetches
        the data and compares it with earlier sessions. The AI only writes an
        interpretation of the evidence it is given. It cannot change stored
        memories or revise a conclusion.
      </p>

      <h2 id="how-a-run-works">How a research run works</h2>
      <p>Every run follows these steps. Nothing in them signs a transaction or touches a wallet.</p>
      <ol>
        <li>
          <strong>Unlock.</strong> Running research needs the demo passphrase
          (see the FAQ). Browsing the dashboard does not.
        </li>
        <li>
          <strong>Plan.</strong> A deterministic planner reads your question
          and picks a capability: latest checkpoint, epoch status, chain
          identifier, object lookup, or reference gas price. Anything else
          runs as a memory-only analysis.
        </li>
        <li>
          <strong>Recall.</strong> Matching memories from earlier sessions are
          recalled and shown as previously stored information, not as new
          verification.
        </li>
        <li>
          <strong>Retrieve.</strong> For Sui questions, one read-only call goes
          to Tatum&apos;s Sui gRPC gateway on mainnet.
        </li>
        <li>
          <strong>Compare.</strong> The new observation is compared with
          earlier sessions. A different value is recorded for review instead of
          silently overwriting what was stored.
        </li>
        <li>
          <strong>Interpret.</strong> The AI (Qwen first, Meta as fallback)
          writes an interpretation with its uncertainties and evidence gaps. A
          guardrail rejects any text that claims verification or proof. If no
          AI answers, the deterministic conclusion stands on its own.
        </li>
        <li>
          <strong>Save.</strong> The session is saved to persistent storage and
          anchored to Walrus testnet, with a blob link you can open.
        </li>
        <li>
          <strong>Review.</strong> Memory Explorer, Learning Engine and Audit
          Timeline show what was stored and why conclusions changed.
        </li>
      </ol>

      <h2 id="labels">What the labels mean</h2>
      <dl className="doc-labels">
        <div>
          <dt>Research Plan</dt>
          <dd>The capability the planner chose for your question.</dd>
        </div>
        <div>
          <dt>Retrieved Observation, Not Verified</dt>
          <dd>Live data fetched from Tatum. Retrieved, not independently checked.</dd>
        </div>
        <div>
          <dt>Recalled Memory</dt>
          <dd>Something stored by an earlier session. Previously stored, not new evidence.</dd>
        </div>
        <div>
          <dt>Evidence Gap</dt>
          <dd>The question needs data the app has no connector for. It says so instead of guessing.</dd>
        </div>
        <div>
          <dt>AI Interpretation, Not Verified Evidence</dt>
          <dd>The model&apos;s reading of the evidence. It is never treated as proof.</dd>
        </div>
      </dl>

      <h2 id="quick-start">Quick start</h2>
      <p>On the live demo:</p>
      <ol>
        <li>Click <strong>Enter Dashboard</strong>.</li>
        <li>Enter the demo passphrase in the box at the top and click <strong>Unlock</strong>.</li>
        <li>
          Open <strong>Research Workspace</strong> and run{' '}
          <code>What is the current Sui reference gas price?</code>
        </li>
        <li>
          Open the new session to see the plan, the Tatum observation, recalled
          memories, and the Walrus blob link. The AI step can take about a
          minute when live evidence is involved.
        </li>
      </ol>
      <p>
        To run it yourself, you need Node 22.5 or newer and a Tatum API key.
        Run <code>npm install</code> and <code>npm run dev</code>, then open{' '}
        <code>http://localhost:3000</code>. Set your own{' '}
        <code>RECALLGUARD_DEMO_PASSPHRASE</code> in <code>.env</code> before
        starting the server. Source:{' '}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          github.com/Abbagigo13/Recall-gurard
        </a>
        .
      </p>
    </>
  );
}

const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: 'What is the demo passphrase?',
    a: 'It is the demo access code for the dashboard. You can look around without it, but running research, saving memories and the Evidence Verification calls need it. Enter it in the box at the top of the dashboard and click Unlock. Access lasts about eight hours. Ask the project owner for the code.',
  },
  {
    q: 'Is retrieved data the same as verified data?',
    a: 'No. Data fetched from Tatum is labeled Retrieved Observation, Not Verified. RecallGuard never presents retrieval as independent or cryptographic verification.',
  },
  {
    q: 'Does RecallGuard sign transactions or touch my wallet?',
    a: 'No. Every Sui call is read-only. The app never asks for a wallet or a private key.',
  },
  {
    q: 'Is Walrus on mainnet or testnet?',
    a: 'Memory is stored on the Walrus testnet. Sui data is read from Sui mainnet through Tatum.',
  },
  {
    q: 'Which questions pull live Sui data?',
    a: 'Questions about the latest checkpoint, the epoch, the chain identifier, an object (when you include its ID), and the reference gas price. Other questions run as a memory-only analysis and report an evidence gap.',
  },
  {
    q: 'Why does a research run take a while?',
    a: 'When live evidence is included, the AI step can take about a minute. The data is retrieved first, so the result is saved even if the AI is slow.',
  },
  {
    q: 'What happens if the AI is unavailable?',
    a: 'Qwen answers first and Meta is the fallback. If neither answers, the AI card says so and the deterministic research conclusion remains the result.',
  },
  {
    q: 'Do memories survive between sessions?',
    a: 'Yes. Sessions and memories are kept in persistent storage, and each session is anchored to Walrus with a blob link.',
  },
  {
    q: 'What are LIVE and DEMO records?',
    a: 'LIVE records come from real runs. DEMO records are labeled seed examples so the dashboard is not empty. The dashboard shows which is which.',
  },
];

function FaqPage() {
  return (
    <>
      <p className="doc-label">[ FAQ ]</p>
      <h1 className="doc-title">Questions, answered.</h1>
      <p className="doc-lead">
        Short answers about access, data and what RecallGuard does and does not
        claim.
      </p>
      <div className="faq-list">
        {FAQ_ITEMS.map((item) => (
          <details className="faq-item" key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}

export default function LandingPage({ onEnter }: { onEnter: () => void }) {
  const [view, setView] = useState<View>(() =>
    typeof window === 'undefined' ? 'home' : viewFromPath(window.location.pathname)
  );

  // Browser back/forward between Home, Docs and FAQ.
  useEffect(() => {
    const sync = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const navigate = (next: View) => {
    if (viewFromPath(window.location.pathname) !== next) {
      window.history.pushState({}, '', PATHS[next]);
    }
    setView(next);
    window.scrollTo(0, 0);
  };

  if (view === 'docs' || view === 'faq') {
    return (
      <DocShell view={view} onNavigate={navigate} onEnter={onEnter}>
        {view === 'docs' ? <DocsPage /> : <FaqPage />}
      </DocShell>
    );
  }

  return (
    <div className="landing-root">
      <div className="landing-backdrop" aria-hidden="true" />
      <div className="landing-inner">
        <p className="landing-brand">
          <span className="landing-mark">
            <Shield className="size-4" aria-hidden="true" />
          </span>
          RecallGuard
        </p>
        <h1 className="landing-headline">
          Research. Remember. Verify.
        </h1>
        <p className="landing-desc">
          An autonomous AI research agent combining on-chain Sui evidence,
          persistent decentralized memory and transparent research decisions.
        </p>
        <button type="button" className="landing-cta" onClick={onEnter}>
          <span>Enter Dashboard</span>
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
        <p className="landing-support">
          Powered by Tatum Sui RPC and Walrus Memory.
        </p>
      </div>
      <SiteFooter view={view} onNavigate={navigate} />
    </div>
  );
}