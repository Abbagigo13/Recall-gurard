import { ArrowRight, Shield } from 'lucide-react';

export default function LandingPage({ onEnter }: { onEnter: () => void }) {
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
      <footer className="landing-footer">
        RecallGuard · Autonomous Research Intelligence
      </footer>
    </div>
  );
}
