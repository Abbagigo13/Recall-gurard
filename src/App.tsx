import React, { useState, useEffect, useMemo } from 'react';
import {
  Brain,
  Shield,
  Clock,
  Database,
  Search,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  ArrowRight,
  TrendingUp,
  Activity,
  Layers,
  Terminal,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Sliders,
  Award,
  Link as LinkIcon,
  Code2,
  FileText,
  AlertTriangle,
  Play,
  RotateCcw,
  Sparkles,
  Info,
  Check,
  Server,
  Cloud,
  Sun,
  Moon,
  Menu,
  X,
  LayoutDashboard,
  ShieldCheck,
  History
} from 'lucide-react';

interface MetricBreakdown {
  sessionsCount: number;
  memoriesCount: number;
  decisionsCount: number;
  evaluatedClaims: number;
  verifiedFacts: number;
  supersededClaims: number;
  accuracyScore: number | null;
}

interface MetricsResponse {
  real: MetricBreakdown;
  aggregated: {
    totalSessions: number;
    totalMemories: number;
    evaluatedClaims: number;
    verifiedFacts: number;
    supersededClaims: number;
    accuracyScore: number | null;
    decisionsCount: number;
  };
}

interface Claim {
  id: string;
  text: string;
  type: 'verified_fact' | 'unverified_claim' | 'ai_interpretation' | 'superseded_claim';
  source: string;
  verifiedAt?: string;
  details?: Record<string, any>;
}

interface ResearchSession {
  id: string;
  provenance: 'live_production' | 'demo_seed';
  question: string;
  status: string;
  createdAt: string;
  confidence: number | null;
  confidenceStatus?: 'measured' | 'not_measured';
  recalledMemoryIds: string[];
  claims: Claim[];
  conclusion: string;
  learningDelta: string;
}

interface MemoryItem {
  id: string;
  provenance: 'live_production' | 'demo_seed';
  category: string;
  title: string;
  content: string;
  sourceReference: string;
  walrusBlobId: string;
  walrusSuiObjectId?: string;
  walrusAggregatorUrl?: string;
  createdAt: string;
  status: string;
  supersededBy?: string;
  reliabilityScore: number | null;
  storageVerified: boolean;
}

interface DecisionItem {
  id: string;
  provenance: 'live_production' | 'demo_seed';
  topic: string;
  previousSessionId: string;
  currentSessionId: string;
  priorClaim: string;
  newClaim: string;
  changeReason: string;
  impact: string;
  timestamp: string;
}

interface TimelineItem {
  id: string;
  type: 'session' | 'decision_update';
  provenance: 'live_production' | 'demo_seed';
  timestamp: string;
  title: string;
  subtitle: string;
  confidence: number | null;
  confidenceStatus?: 'measured' | 'not_measured';
  details: string;
  recalledMemoryIds: string[];
}

interface HealthData {
  status: string;
  timestamp: string;
  integrations: {
    tatumSuiRpc: {
      configured: boolean;
      status: string;
      latencyMs: number | null;
      details: any;
      gatewayHost: string;
    };
    walrusMemory: {
      configured: boolean;
      publisherUrl: string;
      publisherStatus: string;
      publisherLatencyMs: number | null;
      aggregatorUrl: string;
      aggregatorStatus: string;
      aggregatorLatencyMs: number | null;
      pythonPackage: string;
      encoding: string;
    };
  };
  counts: {
    totalSessions: number;
    realSessions: number;
    demoSessions: number;
    totalMemories: number;
    realMemories: number;
    demoMemories: number;
  };
}

function DashboardSkeleton() {
  return (
    <div className="skeleton-screen space-y-xl" role="status" aria-label="Loading RecallGuard dashboard">
      <div className="skeleton-line skeleton-title" />
      <div className="skeleton-line skeleton-subtitle" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-md">
        {Array.from({ length: 4 }).map((_, index) => <div className="skeleton-card" key={index}><div className="skeleton-line w-1/2" /><div className="skeleton-line skeleton-number" /><div className="skeleton-line w-2/3" /></div>)}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-md">
        <div className="skeleton-card skeleton-panel" /><div className="skeleton-card skeleton-panel" />
      </div>
      <span className="sr-only">Loading dashboard data…</span>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'workspace' | 'memories' | 'verification' | 'learning' | 'timeline' | 'sdk'>('dashboard');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const saved = window.localStorage.getItem('recallguard-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  
  // Provenance filter: 'all' | 'live_production' | 'demo_seed'
  const [provenanceFilter, setProvenanceFilter] = useState<'all' | 'live_production' | 'demo_seed'>('all');

  // Telemetry state
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [sessions, setSessions] = useState<ResearchSession[]>([]);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [decisions, setDecisions] = useState<DecisionItem[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [selectedSession, setSelectedSession] = useState<ResearchSession | null>(null);
  const [sdkSpec, setSdkSpec] = useState<any>(null);

  // Workspace form state
  const [researchQuery, setResearchQuery] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [researchResultData, setResearchResultData] = useState<any>(null);
  const [researchNotice, setResearchNotice] = useState<string | null>(null);

  // Memory filter states
  const [memorySearch, setMemorySearch] = useState('');
  const [memoryCategory, setMemoryCategory] = useState('all');

  // New Memory creation form
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [newMemTitle, setNewMemTitle] = useState('');
  const [newMemContent, setNewMemContent] = useState('');
  const [newMemCategory, setNewMemCategory] = useState('on_chain_fact');
  const [newMemSource, setNewMemSource] = useState('Tatum Sui Gateway Verification');
  const [memoryStoreLoading, setMemoryStoreLoading] = useState(false);
  const [memoryStoreStatusMsg, setMemoryStoreStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Recall by blob ID
  const [inspectBlobId, setInspectBlobId] = useState<string | null>(null);
  const [inspectBlobLoading, setInspectBlobLoading] = useState(false);
  const [inspectBlobData, setInspectBlobData] = useState<any>(null);

  // RPC Console state
  const [rpcMethod, setRpcMethod] = useState('sui_getLatestCheckpointSequenceNumber');
  const [rpcNetwork, setRpcNetwork] = useState('mainnet');
  const [rpcParamsJson, setRpcParamsJson] = useState('[]');
  const [rpcLoading, setRpcLoading] = useState(false);
  const [rpcResult, setRpcResult] = useState<any>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);

    // Dashboard analytics — derived from actual records.
  const dashboardAnalytics = useMemo(() => {
    const visibleSessions = sessions.filter(session =>
      provenanceFilter === 'all' ||
      session.provenance === provenanceFilter
    );

    const visibleMemories = memories.filter(memory =>
      provenanceFilter === 'all' ||
      memory.provenance === provenanceFilter
    );

    const visibleDecisions = decisions.filter(decision =>
      provenanceFilter === 'all' ||
      decision.provenance === provenanceFilter
    );

    const claims = visibleSessions.flatMap(session => session.claims);

    const claimDistribution = [
      {
        label: 'Verified facts',
        value: claims.filter(claim => claim.type === 'verified_fact').length
      },
      {
        label: 'Unverified claims',
        value: claims.filter(claim => claim.type === 'unverified_claim').length
      },
      {
        label: 'AI interpretations',
        value: claims.filter(claim => claim.type === 'ai_interpretation').length
      },
      {
        label: 'Superseded claims',
        value: claims.filter(claim => claim.type === 'superseded_claim').length
      }
    ];

    const storageDistribution = [
      {
        label: 'Verified read-back',
        value: visibleMemories.filter(memory => memory.storageVerified).length
      },
      {
        label: 'Not verified',
        value: visibleMemories.filter(memory => !memory.storageVerified).length
      }
    ];

    const activityByDay = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (6 - index));

      const dayKey = date.toLocaleDateString();

      return {
        day: date.toLocaleDateString(undefined, { weekday: 'short' }),
        sessions: visibleSessions.filter(session => {
          const created = new Date(session.createdAt);
          return !Number.isNaN(created.getTime()) &&
            created.toLocaleDateString() === dayKey;
        }).length
      };
    });

    const revisionsByDay = activityByDay.map((day, index) => {
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (6 - index));

      return {
        day: day.day,
        revisions: visibleDecisions.filter(decision => {
          const timestamp = new Date(decision.timestamp);
          return !Number.isNaN(timestamp.getTime()) &&
            timestamp.toLocaleDateString() === date.toLocaleDateString();
        }).length
      };
    });

    return {
      sessions: visibleSessions,
      memories: visibleMemories,
      decisions: visibleDecisions,
      totalClaims: claims.length,
      claimDistribution,
      storageDistribution,
      activityByDay,
      revisionsByDay
    };
  }, [sessions, memories, decisions, provenanceFilter]);
  // Apply and persist the selected theme. The generated design tokens already define both palettes.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    window.localStorage.setItem('recallguard-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Load telemetry & health status
  const loadTelemetry = async () => {
    try {
      const [hlthRes, metRes, sesRes, memRes, decRes, tlRes] = await Promise.all([
        fetch('/api/recallguard/health').then(r => r.json()),
        fetch('/api/recallguard/metrics').then(r => r.json()),
        fetch('/api/recallguard/sessions').then(r => r.json()),
        fetch('/api/recallguard/memories').then(r => r.json()),
        fetch('/api/recallguard/decisions').then(r => r.json()),
        fetch('/api/recallguard/timeline').then(r => r.json())
      ]);
      setHealth(hlthRes);
      setMetrics(metRes);
      setSessions(sesRes);
      setMemories(memRes);
      setDecisions(decRes);
      setTimeline(tlRes);
      if (sesRes && sesRes.length > 0 && !selectedSession) {
        setSelectedSession(sesRes[0]);
      }
    } catch (e) {
      console.error('Failed to load initial telemetry:', e);
      setToast({ type: 'error', message: 'Could not load dashboard data. Check that the RecallGuard server is running.' });
    } finally {
      setInitialLoading(false);
    }
  };

  useEffect(() => {
    loadTelemetry();
    fetch('/api/recallguard/walrus/sdk-spec')
      .then(r => r.json())
      .then(setSdkSpec)
      .catch(console.error);
  }, []);

  // Handle new research execution
  const handleExecuteResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (researchQuery.trim().length < 8) {
      setResearchNotice('Please enter a more specific research question (at least 8 characters).');
      setToast({ type: 'error', message: 'Research question is too short.' });
      return;
    }

    setIsExecuting(true);
    setResearchNotice(null);
    setResearchResultData(null);

    try {
      const res = await fetch('/api/recallguard/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: researchQuery.trim() })
      });
      const data = await res.json();
      if (res.ok) {
        setSessions(prev => [data.session, ...prev]);
        setSelectedSession(data.session);
        if (data.storedMemory) {
          setMemories(prev => [data.storedMemory, ...prev]);
        }
        setResearchResultData(data);
        setToast({ type: 'success', message: 'Research session completed.' });
        if (data.walrusStoreResult?.blobId) {
          setResearchNotice(`Live session anchored to Walrus blob: ${data.walrusStoreResult.blobId}`);
        } else if (data.walrusStoreError) {
          setResearchNotice(`Session recorded in-memory. Walrus write status: ${data.walrusStoreError}`);
        }
        setResearchQuery('');
        // Refresh metrics & health
        fetch('/api/recallguard/metrics').then(r => r.json()).then(setMetrics);
        fetch('/api/recallguard/timeline').then(r => r.json()).then(setTimeline);
        fetch('/api/recallguard/health').then(r => r.json()).then(setHealth);
      } else {
        setResearchNotice(data.error || 'Failed to complete research session.');
        setToast({ type: 'error', message: data.error || 'Research request failed.' });
      }
    } catch (err: any) {
      setResearchNotice(err.message || 'Network error executing research session');
      setToast({ type: 'error', message: err.message || 'Network error executing research session.' });
    } finally {
      setIsExecuting(false);
    }
  };

  // Handle real Walrus memory commit
  const handleCreateMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newMemTitle.trim().length < 3 || newMemContent.trim().length < 10) {
      setMemoryStoreStatusMsg({ type: 'error', text: 'Enter a title (at least 3 characters) and content (at least 10 characters).' });
      setToast({ type: 'error', message: 'Please complete the memory fields.' });
      return;
    }

    setMemoryStoreLoading(true);
    setMemoryStoreStatusMsg(null);

    try {
      const res = await fetch('/api/recallguard/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newMemTitle.trim(),
          content: newMemContent.trim(),
          category: newMemCategory,
          sourceReference: newMemSource.trim()
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setMemories(prev => [data.memory, ...prev]);
        setToast({ type: 'success', message: 'Memory stored successfully.' });
        setMemoryStoreStatusMsg({
          type: 'success',
          text: `Memory confirmed written to Walrus storage (Blob: ${data.memory.walrusBlobId})`
        });
        setNewMemTitle('');
        setNewMemContent('');
        fetch('/api/recallguard/metrics').then(r => r.json()).then(setMetrics);
        fetch('/api/recallguard/health').then(r => r.json()).then(setHealth);
      } else {
        setMemoryStoreStatusMsg({
          type: 'error',
          text: data.error || data.details || 'Walrus rejected memory write request.'
        });
        setToast({ type: 'error', message: data.error || 'Walrus rejected the memory write.' });
      }
    } catch (err: any) {
      setMemoryStoreStatusMsg({
        type: 'error',
        text: `Network failure connecting to Walrus publisher: ${err.message}`
      });
      setToast({ type: 'error', message: err.message || 'Network failure connecting to Walrus.' });
    } finally {
      setMemoryStoreLoading(false);
    }
  };

  // Inspect real Walrus blob content from aggregator
  const handleInspectWalrusBlob = async (blobId: string) => {
    setInspectBlobId(blobId);
    setInspectBlobLoading(true);
    setInspectBlobData(null);

    try {
      const res = await fetch(`/api/recallguard/memories/walrus/${encodeURIComponent(blobId)}`);
      const data = await res.json();
      setInspectBlobData(data);
    } catch (err: any) {
      setInspectBlobData({ error: err.message });
    } finally {
      setInspectBlobLoading(false);
    }
  };

  // Handle Direct Sui RPC execution
  const handleExecuteRpc = async () => {
    setRpcLoading(true);
    setRpcError(null);
    setRpcResult(null);

    let parsedParams = [];
    try {
      parsedParams = JSON.parse(rpcParamsJson);
    } catch (e) {
      setRpcError('Invalid JSON format in RPC parameters array.');
      setToast({ type: 'error', message: 'RPC parameters must be valid JSON.' });
      setRpcLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/recallguard/sui/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: rpcMethod,
          params: parsedParams,
          network: rpcNetwork
        })
      });
      const data = await res.json();
      if (res.ok) {
        setRpcResult(data);
        setToast({ type: 'success', message: 'RPC request completed.' });
      } else {
        setRpcError(data.error || data.details || 'RPC query error');
        setToast({ type: 'error', message: data.error || 'RPC query failed.' });
      }
    } catch (err: any) {
      setRpcError(err.message || 'Network request failed');
    } finally {
      setRpcLoading(false);
    }
  };

  const filteredSessions = sessions.filter(s => {
    return provenanceFilter === 'all' || s.provenance === provenanceFilter;
  });

  const filteredMemories = memories.filter(m => {
    const matchesProvenance = provenanceFilter === 'all' || m.provenance === provenanceFilter;
    const matchesCategory = memoryCategory === 'all' || m.category === memoryCategory;
    const matchesSearch = !memorySearch ||
      m.title.toLowerCase().includes(memorySearch.toLowerCase()) ||
      m.content.toLowerCase().includes(memorySearch.toLowerCase()) ||
      m.id.toLowerCase().includes(memorySearch.toLowerCase());
    return matchesProvenance && matchesCategory && matchesSearch;
  });
const selectedRecalledMemories = selectedSession
  ? selectedSession.recalledMemoryIds
      .map(memId => memories.find(m => m.id === memId))
      .filter((mem): mem is MemoryItem =>
        Boolean(
          mem &&
          (provenanceFilter === 'all' ||
            mem.provenance === provenanceFilter)
        )
      )
  : [];
  const filteredTimeline = timeline.filter(t => {
    return provenanceFilter === 'all' || t.provenance === provenanceFilter;
  });
  useEffect(() => {
  const selectionIsVisible =
    selectedSession &&
    filteredSessions.some(s => s.id === selectedSession.id);

  if (!selectionIsVisible) {
    setSelectedSession(filteredSessions[0] ?? null);
  }
}, [provenanceFilter, sessions]);

  return (
    <div className="min-h-screen bg-primary text-primary font-sans flex flex-col">
      {/* Top Header */}
      <header className="app-header border-b border-secondary bg-primary px-xl py-md sticky top-0 z-50">
        <div className="w-full max-w-none mx-0 flex items-center justify-between gap-md">
          <div className="flex items-center gap-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-secondary">
              <Shield className="size-5 shrink-0 text-fg-secondary" aria-hidden="true" />
            </span>
            <div>
              <div className="flex items-center gap-sm">
                <span className="text-heading-xs font-semibold text-primary tracking-tight">RecallGuard</span>
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                  Tatum × Walrus Hackathon
                </span>
              </div>
              <p className="text-xs text-tertiary">Autonomous AI Research Agent with Persistent Memory & Verifiable Sui Data</p>
            </div>
          </div>

          {/* Integration Live Status Badges */}
          <div className="header-actions flex items-center gap-sm">
            <button type="button" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} className="theme-toggle" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
              {theme === 'dark' ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
              <span className="theme-toggle-label">{theme === 'dark' ? 'Light' : 'Dark'}</span>
            </button>
            <button type="button" className="mobile-menu-toggle" onClick={() => setMobileNavOpen(open => !open)} aria-expanded={mobileNavOpen} aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}>
              {mobileNavOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
            
            {/* Walrus Publisher Status */}
            <span className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium ${
              health?.integrations.walrusMemory.publisherStatus === 'operational'
                ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700'
                : 'border-utility-warning-200 bg-utility-warning-50 text-utility-warning-700'
            }`}>
              <span className="size-2 rounded-full bg-warning-primary" />
              Publisher: {
                health?.integrations.walrusMemory.publisherStatus === 'operational'
                  ? 'Operational'
                  : health?.integrations.walrusMemory.publisherStatus === 'not_checked'
                    ? 'Not checked'
                    : 'Checking'
              }
            </span>

            {/* Walrus Aggregator Status */}
            <span className={`inline-flex items-center gap-xs rounded-full border px-md py-xxs text-xs font-medium ${
              health?.integrations.walrusMemory.aggregatorStatus === 'reachable'
                ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700'
                : 'border-utility-error-200 bg-utility-error-50 text-utility-error-700'
            }`}>
              <span className={`size-2 rounded-full ${
                health?.integrations.walrusMemory.aggregatorStatus === 'reachable'
                  ? 'bg-success-primary'
                  : 'bg-error-primary'
              }`} />
              Aggregator: {
                health?.integrations.walrusMemory.aggregatorStatus === 'reachable'
                  ? 'Reachable'
                  : health?.integrations.walrusMemory.aggregatorStatus === 'checking'
                    ? 'Checking'
                    : health?.integrations.walrusMemory.aggregatorStatus || 'Unknown'
              }
            </span>
          </div>
        </div>

        
      </header>
{/* RIGHT SIDEBAR NAVIGATION */}
<aside className="fixed right-0 top-20 bottom-0 z-40 w-64 border-l border-secondary bg-primary p-md overflow-y-auto hidden lg:block">
  <div className="space-y-lg">

    <div>
      <p className="px-sm mb-sm text-xs font-semibold uppercase tracking-wider text-tertiary">
        Workspace
      </p>

      <nav className="space-y-1">
        {[
          { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { id: 'workspace', label: 'Research Workspace', icon: Search },
          { id: 'memories', label: 'Memory Explorer', icon: Database },
          { id: 'verification', label: 'Evidence Verification', icon: ShieldCheck },
          { id: 'learning', label: 'Learning Engine', icon: Brain },
          { id: 'timeline', label: 'Audit Timeline', icon: History },
          { id: 'sdk', label: 'memwal SDK', icon: Code2 }
        ].map(tab => {
          const Icon = tab.icon;

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`w-full flex items-center gap-sm rounded-lg px-md py-sm text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-brand-primary/10 text-brand-primary border border-brand-primary/20'
                  : 'text-tertiary hover:text-primary hover:bg-secondary'
              }`}
            >
              <Icon className="size-4 shrink-0" />
              {tab.label}
            </button>
          );
        })}
      </nav>
    </div>

    <div className="border-t border-secondary pt-lg">
      <p className="px-sm mb-sm text-xs font-semibold uppercase tracking-wider text-tertiary">
        Data Provenance
      </p>

      <label className="block px-sm mb-xs text-xs text-secondary">
        Display records
      </label>

      <select
        value={provenanceFilter}
        onChange={e => setProvenanceFilter(e.target.value as any)}
        className="w-full rounded-lg bg-secondary border border-primary px-sm py-sm text-xs text-primary"
      >
        <option value="all">All records</option>
        <option value="live_production">Live Confirmed Only</option>
        <option value="demo_seed">Demo Historical Seeds</option>
      </select>
    </div>

    <div className="border-t border-secondary pt-lg">
      <p className="px-sm text-xs text-tertiary">
        RecallGuard Research Engine
      </p>
      <p className="px-sm mt-xs text-xs text-quaternary">
        Tatum × Walrus Infrastructure
      </p>
    </div>

  </div>
</aside>
      {/* Main Content Area */}
      <main
  id="main-content"
  className="app-main flex-1 w-full max-w-none p-xl pr-72 space-y-xl"
>
        {initialLoading && <DashboardSkeleton />}
        {!initialLoading && <>
        {/* TAB 1: DASHBOARD */}
        {activeTab === 'dashboard' && (
          <div className="space-y-xl">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-heading-md font-semibold text-primary">System Telemetry & Epistemic Overview</h1>
                <p className="text-secondary text-sm">
                  Persistent multi-session memory tracking, verifiable Sui data, and transparent claim validation.
                </p>
              </div>
              <button
                onClick={() => setActiveTab('workspace')}
                className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
              >
                <span>New Research Session</span>
                <ArrowRight className="size-4 shrink-0 text-fg-white" />
              </button>
            </div>

           
            {/* Backend Health Callout Bar */}
            <div className="rounded-xl border border-secondary bg-primary p-lg shadow-xs space-y-md">

              <div className="flex items-center gap-sm">
                <Server className="size-5 shrink-0 text-fg-brand-primary" />
                <span className="font-semibold text-primary text-sm">
                  Integration Health Status
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-md">

                {/* Publisher */}
                <div className="rounded-lg bg-secondary p-md space-y-xs">
                  <p className="text-xs font-semibold text-primary">
                    Walrus Publisher
                  </p>
                  <p className="text-xs text-secondary font-mono break-all">
                    {health?.integrations.walrusMemory.publisherUrl || 'Not configured'}
                  </p>
                  <span className="text-xs text-utility-warning-700">
                    Status: {
                      health?.integrations.walrusMemory.publisherStatus === 'operational'
                        ? 'Operational'
                        : health?.integrations.walrusMemory.publisherStatus === 'not_checked'
                          ? 'Not checked — no write test performed'
                          : health?.integrations.walrusMemory.publisherStatus || 'Unknown'
                    }
                  </span>
                </div>

                {/* Aggregator */}
                <div className="rounded-lg bg-secondary p-md space-y-xs">
                  <p className="text-xs font-semibold text-primary">
                    Walrus Aggregator
                  </p>
                  <p className="text-xs text-secondary font-mono break-all">
                    {health?.integrations.walrusMemory.aggregatorUrl || 'Not configured'}
                  </p>
                  <div className="flex flex-wrap items-center gap-sm">
                    <span className={`text-xs font-medium ${
                      health?.integrations.walrusMemory.aggregatorStatus === 'reachable'
                        ? 'text-utility-success-700'
                        : 'text-utility-error-700'
                    }`}>
                      Status: {health?.integrations.walrusMemory.aggregatorStatus || 'Unknown'}
                    </span>
                    <span className="text-xs text-tertiary">
                      {health?.integrations.walrusMemory.aggregatorLatencyMs != null
                        ? `${health.integrations.walrusMemory.aggregatorLatencyMs} ms`
                        : 'Latency unavailable'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-xs">
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                  {health?.counts.realMemories ?? 0} Live Verified Memories
                </span>
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700">
                  {health?.counts.demoMemories ?? 0} Labeled Demo Seeds
                </span>
              </div>
            </div>

            {/* Stat Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-md">
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <div className="flex items-center justify-between text-tertiary mb-xs">
                  <p className="text-sm text-tertiary">Research Sessions</p>
                  <Activity className="size-4 shrink-0 text-fg-quaternary" />
                </div>
                <p className="mt-md text-heading-xs font-semibold text-primary">
                  {provenanceFilter === 'live_production'
                    ? (metrics?.real.sessionsCount ?? 0)
                    : (metrics?.aggregated.totalSessions ?? 0)}
                </p>
                <div className="text-xs text-secondary mt-xs flex items-center gap-xs">
                  <TrendingUp className="size-3 shrink-0 text-fg-success-primary" />
                  <span>
                    {metrics?.real.sessionsCount ?? 0} live executed, {metrics?.aggregated.totalSessions ?? 0} total
                  </span>
                </div>
              </section>

              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <div className="flex items-center justify-between text-tertiary mb-xs">
                  <p className="text-sm text-tertiary">Stored Memories</p>
                  <Database className="size-4 shrink-0 text-fg-quaternary" />
                </div>
                <p className="mt-md text-heading-xs font-semibold text-primary">
                  {provenanceFilter === 'live_production'
                    ? (metrics?.real.memoriesCount ?? 0)
                    : (metrics?.aggregated.totalMemories ?? 0)}
                </p>
                <p className="text-xs text-tertiary mt-xs">
                  {metrics?.real.memoriesCount ?? 0} confirmed written to Walrus
                </p>
              </section>

              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <div className="flex items-center justify-between text-tertiary mb-xs">
                  <p className="text-sm text-tertiary">Evaluated Claims</p>
                  <CheckCircle2 className="size-4 shrink-0 text-fg-quaternary" />
                </div>
                <p className="mt-md text-heading-xs font-semibold text-primary">
                  {provenanceFilter === 'live_production'
                    ? (metrics?.real.evaluatedClaims ?? 0)
                    : (metrics?.aggregated.evaluatedClaims ?? 0)}
                </p>
                <p className="text-xs text-secondary mt-xs">
                  {provenanceFilter === 'live_production'
                    ? `${metrics?.real.verifiedFacts ?? 0} verified on-chain`
                    : `${metrics?.aggregated.verifiedFacts ?? 0} verified facts, ${metrics?.aggregated.supersededClaims ?? 0} superseded`}
                </p>
              </section>

              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
  <div className="flex items-center justify-between text-tertiary mb-xs">
    <p className="text-sm text-tertiary">Verified Facts</p>
    <ShieldCheck className="size-4 shrink-0 text-fg-brand-primary" />
  </div>

  <p className="mt-md text-heading-xs font-semibold text-primary">
    {dashboardAnalytics.claimDistribution[0].value}
  </p>

  <p className="text-xs text-secondary mt-xs">
    {dashboardAnalytics.claimDistribution[1].value} unverified,{' '}
    {dashboardAnalytics.claimDistribution[3].value} superseded
  </p>
</section>
            </div>

            
            {/* RESEARCH ANALYTICS */}
            <section className="space-y-lg">
              <div className="flex flex-wrap items-center justify-between gap-sm">
                <div>
                  <h2 className="text-heading-sm font-semibold text-primary">
                    Research Intelligence
                  </h2>
                  <p className="text-xs text-tertiary mt-xs">
                    Analytics derived from {dashboardAnalytics.sessions.length} visible research sessions
                  </p>
                </div>
                <span className="text-xs text-tertiary rounded-full border border-secondary px-md py-xs">
                  {provenanceFilter === 'all'
                    ? 'All provenance'
                    : provenanceFilter === 'live_production'
                      ? 'Live production'
                      : 'Demo historical seeds'}
                </span>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-xl">

                {/* RESEARCH ACTIVITY */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-primary">
                        Research Activity
                      </h3>
                      <p className="text-xs text-tertiary mt-xs">
                        Sessions created over the last 7 days
                      </p>
                    </div>
                    <Activity className="size-5 text-fg-brand-primary" />
                  </div>

                  <div className="flex items-end justify-between gap-sm h-36">
                    {dashboardAnalytics.activityByDay.map((item, index) => {
                      const maximum = Math.max(
                        ...dashboardAnalytics.activityByDay.map(day => day.sessions),
                        1
                      );
                      const height = item.sessions > 0
                        ? Math.max((item.sessions / maximum) * 100, 8)
                        : 2;

                      return (
                        <div key={`${item.day}-${index}`} className="flex-1 flex flex-col items-center justify-end gap-sm h-full">
                          <span className="text-xs text-secondary">
                            {item.sessions}
                          </span>
                          <div className="w-full flex items-end justify-center flex-1">
                            <div
                              className="w-full max-w-10 rounded-t-md transition-all"
                              style={{
                                height: `${height}%`,
                                backgroundColor: 'var(--color-bg-brand-solid)'
                              }}
                              title={`${item.sessions} sessions`}
                            />
                          </div>
                          <span className="text-xs text-tertiary">
                            {item.day}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  {dashboardAnalytics.sessions.length === 0 && (
                    <p className="text-xs text-tertiary text-center">
                      No research sessions available for this filter.
                    </p>
                  )}
                </section>

                {/* CLAIM DISTRIBUTION */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-primary">
                        Claim Distribution
                      </h3>
                      <p className="text-xs text-tertiary mt-xs">
                        Classification across visible research sessions
                      </p>
                    </div>
                    <ShieldCheck className="size-5 text-fg-brand-primary" />
                  </div>

                  <div className="space-y-lg">
                    {dashboardAnalytics.claimDistribution.map(item => {
                      const maximum = Math.max(
                        ...dashboardAnalytics.claimDistribution.map(claim => claim.value),
                        1
                      );
                      const percentage = (item.value / maximum) * 100;

                      return (
                        <div key={item.label} className="space-y-xs">
                          <div className="flex items-center justify-between gap-sm">
                            <span className="text-xs text-secondary">
                              {item.label}
                            </span>
                            <span className="text-xs font-semibold text-primary tabular-nums">
                              {item.value}
                            </span>
                          </div>
                          <div className="h-2 rounded-full bg-secondary overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all"
                              style={{
                                width: `${percentage}%`,
                                backgroundColor: 'var(--color-bg-brand-solid)'
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <p className="text-xs text-tertiary">
                    {dashboardAnalytics.totalClaims} total classified claims. Classification does not independently establish correctness.
                  </p>
                </section>

                {/* WALRUS MEMORY STORAGE */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-primary">
                        Memory Storage Integrity
                      </h3>
                      <p className="text-xs text-tertiary mt-xs">
                        Recorded memory read-back status
                      </p>
                    </div>
                    <Database className="size-5 text-fg-brand-primary" />
                  </div>

                  <div className="grid grid-cols-2 gap-md">
                    {dashboardAnalytics.storageDistribution.map(item => (
                      <div key={item.label} className="rounded-lg bg-secondary p-md">
                        <p className="text-xs text-tertiary">
                          {item.label}
                        </p>
                        <p className="mt-sm text-heading-sm font-semibold text-primary tabular-nums">
                          {item.value}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="h-3 flex rounded-full overflow-hidden bg-secondary">
                    {dashboardAnalytics.memories.length > 0 && (
                      <>
                        <div
                          className="h-full"
                          style={{
                            width: `${(dashboardAnalytics.storageDistribution[0].value / dashboardAnalytics.memories.length) * 100}%`,
                            backgroundColor: 'var(--color-fg-success-primary)'
                          }}
                        />
                        <div
                          className="h-full"
                          style={{
                            width: `${(dashboardAnalytics.storageDistribution[1].value / dashboardAnalytics.memories.length) * 100}%`,
                            backgroundColor: 'var(--color-fg-warning-primary)'
                          }}
                        />
                      </>
                    )}
                  </div>

                  <p className="text-xs text-tertiary">
                    {dashboardAnalytics.memories.length} visible memory records. Read-back status is not a claim-level cryptographic verification.
                  </p>
                </section>

                {/* BELIEF REVISION ACTIVITY */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-lg">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-primary">
                        Belief Revision Activity
                      </h3>
                      <p className="text-xs text-tertiary mt-xs">
                        Recorded decision updates over the last 7 days
                      </p>
                    </div>
                    <History className="size-5 text-fg-brand-primary" />
                  </div>

                  <div className="flex items-end justify-between gap-sm h-36">
                    {dashboardAnalytics.revisionsByDay.map((item, index) => {
                      const maximum = Math.max(
                        ...dashboardAnalytics.revisionsByDay.map(day => day.revisions),
                        1
                      );
                      const height = item.revisions > 0
                        ? Math.max((item.revisions / maximum) * 100, 8)
                        : 2;

                      return (
                        <div key={`${item.day}-${index}`} className="flex-1 flex flex-col items-center justify-end gap-sm h-full">
                          <span className="text-xs text-secondary">
                            {item.revisions}
                          </span>
                          <div className="w-full flex items-end justify-center flex-1">
                            <div
                              className="w-full max-w-10 rounded-t-md transition-all"
                              style={{
                                height: `${height}%`,
                                backgroundColor: 'var(--color-fg-success-primary)'
                              }}
                              title={`${item.revisions} revisions`}
                            />
                          </div>
                          <span className="text-xs text-tertiary">
                            {item.day}
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <p className="text-xs text-tertiary">
                    {dashboardAnalytics.decisions.length} visible decision records in total.
                  </p>
                </section>
              </div>
            </section>

            {/* Split layout: Recent Sessions and Learning Engine */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-xl">
              {/* Recent Sessions */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs flex flex-col space-y-md">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-heading-xs font-semibold text-primary">Recent Research Sessions</h2>
                    <p className="text-xs text-tertiary">Chronological history with memory recall tags</p>
                  </div>
                  <button
                    onClick={() => setActiveTab('timeline')}
                    className="text-xs text-brand-primary hover:underline font-semibold"
                  >
                    View Timeline
                  </button>
                </div>

                <div className="space-y-sm flex-1">
                  {filteredSessions.slice(0, 3).map(s => (
                    <div
                      key={s.id}
                      onClick={() => {
                        setSelectedSession(s);
                        setActiveTab('workspace');
                      }}
                      className="p-md rounded-md bg-secondary hover:bg-secondary-hover border border-secondary transition-colors cursor-pointer space-y-xs"
                    >
                      <div className="flex items-center justify-between text-xs text-tertiary">
                        <div className="flex items-center gap-xs">
                          <span className="font-mono text-quaternary font-bold">{s.id}</span>
                          <span className={`inline-flex items-center rounded-xs px-xs py-xxs font-mono text-xs uppercase ${
                            s.provenance === 'live_production'
                              ? 'bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200'
                              : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
                          }`}>
                            {s.provenance === 'live_production' ? 'Live' : 'Demo'}
                          </span>
                        </div>
                        <span>{new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <h3 className="text-sm font-medium text-primary line-clamp-1">{s.question}</h3>
                      <div className="flex items-center gap-xs flex-wrap">
                        <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
                          Confidence: {s.confidenceStatus === 'not_measured' || s.confidence === null
  ? 'Not measured'
  : `${Math.round(s.confidence * 100)}%`}
                        </span>
                        {s.recalledMemoryIds.length > 0 && (
                          <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                            {s.recalledMemoryIds.length} Memories Recalled
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {filteredSessions.length === 0 && (
                    <div className="py-xl text-center text-sm text-tertiary">
                      No sessions match the current provenance filter.
                    </div>
                  )}
                </div>
              </section>

              {/* Learning Engine Stance */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs flex flex-col space-y-md">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-heading-xs font-semibold text-primary">Autonomous Learning Engine</h2>
                    <p className="text-xs text-tertiary">Auditable adjustments when on-chain evidence arrives</p>
                  </div>
                  <button
                    onClick={() => setActiveTab('learning')}
                    className="text-xs text-brand-primary hover:underline font-semibold"
                  >
                    Inspect Revisions
                  </button>
                </div>

                
                    
                <div className="space-y-md">

                  {/* ACTUAL REVISION METRICS */}
                  <div className="p-md rounded-md bg-secondary border border-secondary space-y-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-primary">
                        Recorded Belief Revisions
                      </span>
                      <span className="text-heading-sm font-semibold text-primary">
                        {dashboardAnalytics.decisions.length}
                      </span>
                    </div>
                    <p className="text-xs text-tertiary">
                      Decision records currently available for the selected provenance filter.
                    </p>
                  </div>

                  {/* ACTUAL DECISION HISTORY */}
                  <div className="space-y-sm">
                    <span className="text-xs font-semibold text-primary">
                      Recent Revision Records
                    </span>

                    {dashboardAnalytics.decisions.slice(0, 2).map(decision => (
                      <div
                        key={decision.id}
                        className="p-md rounded-md bg-secondary border border-secondary space-y-sm"
                      >
                        
<div className="flex items-center justify-between gap-sm flex-wrap">
  <span className="text-xs font-semibold text-primary">
    {decision.topic}
  </span>

  <div className="flex items-center gap-sm">
    <span className={`rounded-full border px-sm py-xxs text-xs font-medium ${
      decision.provenance === 'live_production'
        ? 'border-utility-success-200 bg-utility-success-50 text-utility-success-700'
        : 'border-utility-gray-200 bg-utility-gray-50 text-utility-gray-700'
    }`}>
      {decision.provenance === 'live_production'
        ? 'Live production'
        : 'Demo seed'}
    </span>

    <span className="text-xs text-tertiary font-mono">
      {decision.id}
    </span>
  </div>
</div>

                        <div className="space-y-xs text-xs">
                          <p className="text-secondary">
                            <span className="font-semibold">Previous:</span>{' '}
                            {decision.priorClaim}
                          </p>
                          <p className="text-primary">
                            <span className="font-semibold">Revised:</span>{' '}
                            {decision.newClaim}
                          </p>
                          <p className="text-tertiary">
                            <span className="font-semibold">Reason:</span>{' '}
                            {decision.changeReason}
                          </p>
                          <p className="text-tertiary">
                            <span className="font-semibold">Impact:</span>{' '}
                            {decision.impact}
                          </p>
                        </div>

                        <p className="text-xs text-tertiary">
                          {new Date(decision.timestamp).toLocaleString()}
                        </p>
                      </div>
                    ))}

                    {dashboardAnalytics.decisions.length === 0 && (
                      <div className="p-md rounded-md bg-secondary border border-secondary">
                        <p className="text-xs text-tertiary">
                          No recorded belief revisions for this provenance filter.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* WALRUS INFRASTRUCTURE STATUS */}
                  <div className="p-md rounded-md bg-secondary border border-secondary space-y-sm">
                    <span className="text-xs font-semibold text-primary">
                      Walrus Infrastructure
                    </span>

                    <div className="space-y-xs text-xs">
                      <div>
                        <p className="text-tertiary mb-xs">Publisher Endpoint</p>
                        <p className="font-mono text-secondary break-all">
                          {health?.integrations.walrusMemory.publisherUrl || 'Not configured'}
                        </p>
                        <p className="text-tertiary mt-xs">
                          Status: {health?.integrations.walrusMemory.publisherStatus || 'Unknown'}
                        </p>
                      </div>

                      <div className="border-t border-secondary pt-sm">
                        <p className="text-tertiary mb-xs">Aggregator Endpoint</p>
                        <p className="font-mono text-secondary break-all">
                          {health?.integrations.walrusMemory.aggregatorUrl || 'Not configured'}
                        </p>
                        <p className="text-tertiary mt-xs">
                          Status: {health?.integrations.walrusMemory.aggregatorStatus || 'Unknown'}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}

        {/* TAB 2: RESEARCH WORKSPACE */}
        {activeTab === 'workspace' && (
          <div className="space-y-xl">
            <div>
              <h1 className="text-heading-md font-semibold text-primary">Research Workspace</h1>
              <p className="text-secondary text-sm">
                Enter research questions to query on-chain Sui states via Tatum and recall persistent Walrus memories.
              </p>
            </div>

            {/* Input Inquiry Form */}
            <form onSubmit={handleExecuteResearch} className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
              <div className="flex flex-col gap-sm">
                <label className="text-sm font-medium text-secondary">Research Inquiry or Hypothesis</label>
                <div className="flex gap-sm">
                  <input
                    aria-label="Research inquiry"
                    required
                    minLength={8}
                    type="text"
                    value={researchQuery}
                    onChange={e => setResearchQuery(e.target.value)}
                    placeholder="e.g. Verify Sui latest checkpoint sequence number and Walrus testnet storage parameters"
                    className="flex-1 rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                  <button
                    type="submit"
                    disabled={isExecuting || !researchQuery.trim()}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                  >
                    {isExecuting ? (
                      <>
                        <RefreshCw className="size-4 shrink-0 text-fg-white animate-spin" />
                        <span>Executing & Storing to Walrus...</span>
                      </>
                    ) : (
                      <>
                        <Search className="size-4 shrink-0 text-fg-white" />
                        <span>Execute Research</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-xs text-tertiary">
                  Attempts live write to Walrus publisher endpoint and runs read-only Tatum Sui RPC query if configured.
                </p>
              </div>

              {/* Sample Presets */}
              <div className="flex items-center gap-xs text-xs text-tertiary flex-wrap">
                <span className="font-semibold text-quaternary">Sample Inquiries:</span>
                <button
                  type="button"
                  onClick={() => setResearchQuery("Verify latest Sui checkpoint sequence number and validator committee count")}
                  className="inline-flex items-center rounded-md bg-secondary px-sm py-xxs text-xs font-medium text-secondary border border-secondary hover:bg-secondary-hover"
                >
                  Sui Checkpoint & Committee
                </button>
                <button
                  type="button"
                  onClick={() => setResearchQuery("What is the verified minimum collateral for Walrus storage nodes on Sui?")}
                  className="inline-flex items-center rounded-md bg-secondary px-sm py-xxs text-xs font-medium text-secondary border border-secondary hover:bg-secondary-hover"
                >
                  Walrus Node Collateral
                </button>
                <button
                  type="button"
                  onClick={() => setResearchQuery("Inspect DeepBook V3 liquidity contract parameters on Sui")}
                  className="inline-flex items-center rounded-md bg-secondary px-sm py-xxs text-xs font-medium text-secondary border border-secondary hover:bg-secondary-hover"
                >
                  DeepBook Contract Verification
                </button>
              </div>

              {/* Research execution feedback alert */}
              {researchNotice && (
                <div className="flex gap-lg rounded-xl bg-utility-brand-50 p-xl">
                  <Info className="mt-xxs size-5 shrink-0 text-utility-brand-600" aria-hidden="true" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-utility-brand-600">Research Operation Result</p>
                    <p className="mt-xxs text-sm text-tertiary">{researchNotice}</p>
                    {researchResultData?.walrusStoreResult?.blobId && (
                      <p className="mt-xs text-xs font-mono text-utility-brand-700">
                        Walrus Blob URL: <a href={researchResultData.walrusStoreResult.aggregatorUrl} target="_blank" rel="noreferrer" className="underline">{researchResultData.walrusStoreResult.aggregatorUrl}</a>
                      </p>
                    )}
                  </div>
                  <button onClick={() => setResearchNotice(null)} className="text-xs text-utility-brand-600 font-bold">&times;</button>
                </div>
              )}
            </form>

            {/* Session Inspector Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-xl">
              {/* Claims & Epistemic Breakdown */}
              <div className="lg:col-span-2 space-y-lg">
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                  <div className="flex items-center justify-between border-b border-secondary pb-md">
                    <div>
                      <div className="flex items-center gap-sm">
                        <span className="text-xs font-mono font-bold text-brand-primary">
                          {selectedSession?.id || 'Active Session'}
                        </span>
                        {selectedSession && (
  <span className={`inline-flex items-center rounded-xs px-xs py-xxs font-mono text-xs uppercase ${
    selectedSession.provenance === 'live_production'
      ? 'bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200'
      : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
  }`}>
    {selectedSession.provenance === 'live_production'
      ? 'Live Confirmed'
      : 'Demo Seed'}
  </span>
)}
                        <h2 className="text-heading-xs font-semibold text-primary">
                          Epistemic Finding & Claim Breakdown
                        </h2>
                      </div>
                      <p className="text-xs text-tertiary mt-xxs">
                        {selectedSession?.question || 'Select or execute a session to inspect claims'}
                      </p>
                    </div>
                    {selectedSession && (
                      <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                        Confidence: {selectedSession.confidence == null
                          ? 'N/A'
                          : `${Math.round(selectedSession.confidence * 100)}%`}
                      </span>
                    )}
                  </div>

                  {/* Claims List */}
                  {selectedSession ? (
                    <div className="space-y-md">
                      {selectedSession.claims.map(claim => {
                        let badgeFamily = 'brand';
                        let typeLabel = 'Unverified Claim';
                        let IconComponent = HelpCircle;

                        if (claim.type === 'verified_fact') {
                          badgeFamily = 'success';
                          typeLabel = 'Verified Fact (On-Chain / Spec)';
                          IconComponent = CheckCircle2;
                        } else if (claim.type === 'ai_interpretation') {
                          badgeFamily = 'brand';
                          typeLabel = 'Agent Synthesis';
                          IconComponent = Brain;
                        } else if (claim.type === 'superseded_claim') {
                          badgeFamily = 'warning';
                          typeLabel = 'Superseded Claim (Obsolete)';
                          IconComponent = AlertCircle;
                        }

                        return (
                          <div key={claim.id} className="p-md rounded-md bg-secondary border border-secondary space-y-xs">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-xs">
                                <IconComponent className="size-4 shrink-0 text-fg-quaternary" />
                                <span className={`inline-flex items-center gap-xs rounded-full border border-utility-${badgeFamily}-200 bg-utility-${badgeFamily}-50 px-md py-xxs text-xs font-medium text-utility-${badgeFamily}-700`}>
                                  {typeLabel}
                                </span>
                              </div>
                              <span className="text-xs font-mono text-tertiary">{claim.id}</span>
                            </div>
                            <p className="text-sm font-medium text-primary leading-relaxed">
                              {claim.text}
                            </p>
                            <div className="flex items-center justify-between text-xs text-tertiary pt-xxs border-t border-secondary">
                              <span>Source: <strong className="text-secondary">{claim.source}</strong></span>
                              {claim.verifiedAt && (
                                <span>Verified: {new Date(claim.verifiedAt).toLocaleTimeString()}</span>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      {/* Conclusion */}
                      <div className="p-md rounded-md bg-secondary border border-secondary space-y-sm">
                        <div>
                          <p className="text-sm text-tertiary">Synthesized Conclusion</p>
                          <p className="text-sm text-primary font-medium mt-xxs">
                            {selectedSession.conclusion}
                          </p>
                        </div>
                        <div className="pt-xs border-t border-secondary">
                          <span className="text-xs font-semibold uppercase tracking-wider text-brand-primary">
                            Learning Engine Delta
                          </span>
                          <p className="text-xs text-secondary mt-xxs">
                            {selectedSession.learningDelta}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="py-xl text-center text-sm text-tertiary">
                      No research session selected.
                    </div>
                  )}
                </section>
              </div>

              {/* Sidebar */}
              <div className="space-y-lg">
                {/* Recalled Memories Card */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-primary flex items-center gap-xs">
                      <Database className="size-4 shrink-0 text-fg-brand-primary" />
                      <span>Recalled Memories</span>
                    </h3>
                    <span className="text-xs font-mono text-tertiary">
                    {selectedRecalledMemories.length} Recalled
                    </span>
                  </div>

                 {selectedSession && selectedRecalledMemories.length > 0 ? (
  <div className="space-y-sm">
    {selectedRecalledMemories.map(mem => {
      const memId = mem.id;

      return (
        <div
          key={memId}
          className="p-sm rounded-md bg-secondary border border-secondary text-xs space-y-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono font-bold text-brand-primary">
              {memId}
            </span>
            <span className="text-quaternary font-mono uppercase text-[10px]">
              {mem.provenance}
            </span>
          </div>

          <p className="text-primary font-medium">
            {mem.title || 'Memory Vector'}
          </p>

          <p className="text-tertiary line-clamp-2">
            {mem.content}
          </p>
        </div>
      );
    })}
  </div>
) : (
  <div className="p-md rounded-md bg-secondary border border-secondary text-xs text-tertiary text-center">
    No prior matching memories were triggered by this query.
  </div>
)}
                  <button
                    type="button"
                    onClick={() => setActiveTab('memories')}
                    className="w-full rounded-md bg-secondary px-md py-sm text-xs font-semibold text-secondary hover:bg-secondary-hover"
                  >
                    Open Memory Explorer
                  </button>
                </section>

                {/* Session History List */}
                <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                  <h3 className="text-sm font-semibold text-primary">Session History</h3>
                  <div className="space-y-xs max-h-60 overflow-y-auto">
                    {filteredSessions.map(s => (
                      <button
                        key={s.id}
                        onClick={() => setSelectedSession(s)}
                        className={`w-full text-left p-sm rounded-md text-xs transition-colors flex items-center justify-between ${
                          selectedSession?.id === s.id
                            ? 'bg-brand-solid text-primary-on-brand font-semibold'
                            : 'bg-secondary text-secondary hover:text-primary hover:bg-secondary-hover'
                        }`}
                      >
                        <span className="truncate pr-xs">[{s.provenance === 'live_production' ? 'LIVE' : 'DEMO'}] {s.id}: {s.question}</span>
                        <ChevronRight className="size-3 shrink-0" />
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: MEMORY EXPLORER */}
        {activeTab === 'memories' && (
          <div className="space-y-xl">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-heading-md font-semibold text-primary">Persistent Memory Explorer</h1>
                <p className="text-secondary text-sm">
                  Decentralized memory records stored via the official Walrus Memory Python SDK (memwal) and HTTP protocol.
                </p>
              </div>
              <button
                onClick={() => setShowAddMemory(!showAddMemory)}
                className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                {showAddMemory ? 'Cancel Entry' : '+ Store New Memory to Walrus'}
              </button>
            </div>

            {/* Modal/Form for adding memory directly to Walrus */}
            {showAddMemory && (
              <form onSubmit={handleCreateMemory} className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-primary">Commit Memory to Real Walrus Storage</h3>
                  <span className="text-xs text-tertiary">Publisher: {health?.integrations.walrusMemory.publisherUrl}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
                  <div className="flex flex-col gap-sm">
                    <label className="text-sm font-medium text-secondary">Memory Title</label>
                    <input
                      aria-label="Memory title"
                      required
                      minLength={3}
                      type="text"
                      value={newMemTitle}
                      onChange={e => setNewMemTitle(e.target.value)}
                      placeholder="e.g. Sui Checkpoint Finality Threshold"
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </div>
                  <div className="flex flex-col gap-sm">
                    <label className="text-sm font-medium text-secondary">Category</label>
                    <select
                      value={newMemCategory}
                      onChange={e => setNewMemCategory(e.target.value)}
                      className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                    >
                      <option value="on_chain_fact">On-Chain Verified Fact</option>
                      <option value="protocol_spec">Protocol Specification</option>
                      <option value="epistemic_stance">Agent Epistemic Stance</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Memory Content / Statement</label>
                  <textarea
                    aria-label="Memory content"
                    required
                    minLength={10}
                    rows={3}
                    value={newMemContent}
                    onChange={e => setNewMemContent(e.target.value)}
                    placeholder="Provide verifiable memory content to be stored as a Walrus blob..."
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">Source Reference</label>
                  <input
                    type="text"
                    value={newMemSource}
                    onChange={e => setNewMemSource(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary font-mono border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>

                {memoryStoreStatusMsg && (
                  <div className={`flex gap-lg rounded-xl p-xl ${
                    memoryStoreStatusMsg.type === 'success' ? 'bg-utility-success-50 text-utility-success-700' : 'bg-utility-error-50 text-utility-error-600'
                  }`}>
                    <div className="text-xs font-medium">{memoryStoreStatusMsg.text}</div>
                  </div>
                )}

                <div className="flex justify-end gap-sm">
                  <button
                    type="button"
                    onClick={() => setShowAddMemory(false)}
                    className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary hover:bg-primary-hover"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={memoryStoreLoading || !newMemTitle.trim() || !newMemContent.trim()}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover disabled:opacity-50"
                  >
                    {memoryStoreLoading ? (
                      <>
                        <RefreshCw className="size-4 shrink-0 text-fg-white animate-spin" />
                        <span>Uploading to Walrus...</span>
                      </>
                    ) : (
                      <span>Commit to Walrus</span>
                    )}
                  </button>
                </div>
              </form>
            )}

            {/* Filter and Search Bar */}
            <div className="flex items-center gap-md">
              <div className="flex-1 relative">
                <Search className="size-4 shrink-0 text-fg-quaternary absolute left-3 top-3" />
                <input
                  type="text"
                  value={memorySearch}
                  onChange={e => setMemorySearch(e.target.value)}
                  placeholder="Search semantic memory vectors..."
                  className="w-full pl-9 pr-md py-sm rounded-md bg-primary border border-primary text-primary placeholder:text-placeholder focus-visible:ring-2 focus-visible:ring-focus-ring text-sm"
                />
              </div>
              <select
                value={memoryCategory}
                onChange={e => setMemoryCategory(e.target.value)}
                className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <option value="all">All Categories</option>
                <option value="on_chain_fact">On-Chain Verified</option>
                <option value="protocol_spec">Protocol Specs</option>
                <option value="epistemic_stance">Agent Stances</option>
              </select>
            </div>

            {/* Memory Table */}
            <div className="responsive-table overflow-hidden rounded-xl border border-secondary bg-primary shadow-xs">
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-secondary">
                  <tr className="border-b border-secondary text-left">
                    <th className="px-3xl py-md text-sm font-semibold text-quaternary">Memory ID</th>
                    <th className="px-3xl py-md text-sm font-semibold text-quaternary">Provenance</th>
                    <th className="px-3xl py-md text-sm font-semibold text-quaternary">Title & Content</th>
                    <th className="px-3xl py-md text-sm font-semibold text-quaternary">Source Reference</th>
                    <th className="px-3xl py-md text-sm font-semibold text-quaternary">Walrus Blob Reference</th>
                    <th className="px-3xl py-md text-sm font-semibold text-quaternary">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMemories.map(mem => (
                    <tr key={mem.id} className="border-b border-secondary hover:bg-secondary-hover focus-visible:ring-2 focus-visible:ring-focus-ring transition-colors">
                      <td className="px-3xl py-xl text-md font-mono font-bold text-brand-primary">
                        {mem.id}
                      </td>
                      <td className="px-3xl py-xl text-md text-tertiary">
                        <span className={`inline-flex items-center rounded-xs px-xs py-xxs font-mono text-xs uppercase ${
                          mem.provenance === 'live_production'
                            ? 'bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200'
                            : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
                        }`}>
                          {mem.provenance === 'live_production' ? 'Live Walrus' : 'Demo Seed'}
                        </span>
                      </td>
                      <td className="px-3xl py-xl text-md text-tertiary max-w-sm">
                        <p className={`text-primary font-medium ${mem.status === 'superseded' ? 'line-through text-quaternary' : ''}`}>
                          {mem.title}
                        </p>
                        <p className="text-xs text-tertiary mt-xxs line-clamp-2">
                          {mem.content}
                        </p>
                        {mem.supersededBy && (
                          <p className="text-xs text-utility-brand-700 mt-xxs font-mono">
                            Superseded by: {mem.supersededBy}
                          </p>
                        )}
                      </td>
                      <td className="px-3xl py-xl text-md text-tertiary font-mono text-xs">
                        {mem.sourceReference}
                      </td>
                      <td className="px-3xl py-xl text-md text-tertiary font-mono text-xs">
                        {mem.provenance === 'live_production' ? (
                          <a
                            href={`${health?.integrations.walrusMemory.aggregatorUrl}/v1/blobs/${mem.walrusBlobId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-primary hover:underline truncate block max-w-[140px]"
                            title={mem.walrusBlobId}
                          >
                            {mem.walrusBlobId}
                          </a>
                        ) : (
                          <span className="text-quaternary truncate block max-w-[140px]" title={mem.walrusBlobId}>
                            {mem.walrusBlobId}
                          </span>
                        )}
                      </td>
                      <td className="px-3xl py-xl text-md text-tertiary">
                        {mem.provenance === 'live_production' && (
                          <button
                            onClick={() => handleInspectWalrusBlob(mem.walrusBlobId)}
                            className="text-xs text-brand-primary hover:underline font-semibold"
                          >
                            Recall from Walrus
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filteredMemories.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3xl py-xl text-center text-sm text-tertiary">
                        No memories found matching the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Blob Inspection Drawer */}
            {inspectBlobId && (
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-sm">
                    <Database className="size-4 shrink-0 text-fg-brand-primary" />
                    <h3 className="text-sm font-semibold text-primary">
                      Walrus Aggregator Direct Response for Blob <span className="font-mono text-brand-primary">{inspectBlobId}</span>
                    </h3>
                  </div>
                  <button onClick={() => setInspectBlobId(null)} className="text-xs text-tertiary hover:text-primary font-bold">Close</button>
                </div>

                {inspectBlobLoading ? (
                  <div className="p-xl text-center text-sm text-tertiary">
                    <RefreshCw className="size-5 shrink-0 mx-auto mb-xs animate-spin text-fg-brand-primary" />
                    Querying Walrus testnet aggregator node...
                  </div>
                ) : (
                  <pre className="p-md rounded-md bg-secondary border border-secondary font-mono text-xs text-primary overflow-x-auto leading-relaxed">
                    {JSON.stringify(inspectBlobData, null, 2)}
                  </pre>
                )}
              </section>
            )}
          </div>
        )}

        {/* TAB 4: EVIDENCE VERIFICATION (TATUM SUI RPC) */}
        {activeTab === 'verification' && (
          <div className="space-y-xl">
            <div>
              <h1 className="text-heading-md font-semibold text-primary">Evidence Verification (Tatum Sui RPC)</h1>
              <p className="text-secondary text-sm">
                Direct, read-only interaction with Sui blockchain infrastructure through Tatum Gateway.
              </p>
            </div>

            {/* Read-Only Guarantee Notice */}
            <div className="flex gap-lg rounded-xl bg-utility-brand-50 p-xl">
              <Shield className="mt-xxs size-5 shrink-0 text-utility-brand-600" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-utility-brand-600">Read-Only Cryptographic Verification Guarantee</p>
                <p className="mt-xxs text-sm text-tertiary">
                  RecallGuard strictly runs read-only gRPC queries. It never requests wallet connection, never signs transactions, and never mutates on-chain state. All Sui gRPC calls are executed server-side via Tatum.
                </p>
              </div>
            </div>

            {/* Live gRPC Console */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-secondary">
                  Sui gRPC Query Console
                </span>
                <div className="flex items-center gap-xs">
                  <span className="text-xs text-tertiary">Network:</span>
                  <select
                    value={rpcNetwork}
                    onChange={e => setRpcNetwork(e.target.value)}
                    className="rounded-md bg-primary px-sm py-xxs text-xs text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <option value="mainnet">sui-mainnet</option>
                    <option value="testnet">sui-testnet</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">RPC Method</label>
                  <select
                    value={rpcMethod}
                    onChange={e => {
                      setRpcMethod(e.target.value);
                      if (e.target.value === 'sui_getLatestCheckpointSequenceNumber') setRpcParamsJson('[]');
                      if (e.target.value === 'sui_getChainIdentifier') setRpcParamsJson('[]');
                      if (e.target.value === 'sui_getObject') setRpcParamsJson('["0x5", { "showType": true, "showContent": true }]');
                    }}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary font-mono focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    <option value="sui_getLatestCheckpointSequenceNumber">sui_getLatestCheckpointSequenceNumber</option>
                    <option value="sui_getChainIdentifier">sui_getChainIdentifier</option>
                    <option value="sui_getObject">sui_getObject</option>
                  </select>
                </div>

                <div className="flex flex-col gap-sm">
                  <label className="text-sm font-medium text-secondary">JSON Parameters Array</label>
                  <input
                    type="text"
                    value={rpcParamsJson}
                    onChange={e => setRpcParamsJson(e.target.value)}
                    className="rounded-md bg-primary px-lg py-sm text-sm text-primary border border-primary font-mono focus-visible:ring-2 focus-visible:ring-focus-ring"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={handleExecuteRpc}
                  disabled={rpcLoading}
                  className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                >
                  {rpcLoading ? (
                    <>
                      <RefreshCw className="size-4 shrink-0 text-fg-white animate-spin" />
                      <span>Querying Tatum Gateway...</span>
                    </>
                  ) : (
                    <>
                      <Play className="size-4 shrink-0 text-fg-white" />
                      <span>Execute Read Query</span>
                    </>
                  )}
                </button>
              </div>

              {/* Status / Output Display */}
              
              {/* Status / Output Display */}
              {rpcError && (
                <div className="flex gap-lg rounded-xl bg-utility-error-50 p-xl">
                  <AlertCircle className="mt-xxs size-5 shrink-0 text-utility-error-600" aria-hidden="true" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-utility-error-600">
                      Sui gRPC Request Failed
                    </p>
                    <p className="mt-xxs text-sm text-tertiary">{rpcError}</p>
                    <p className="mt-xs text-xs font-semibold text-utility-error-600">
                      This request did not retrieve evidence. No verified fact is claimed.
                    </p>
                  </div>
                </div>
              )}

              {rpcResult && (
                <div className="space-y-sm">
                  {/* gRPC Status Banner */}
                  <div className={`flex gap-lg rounded-xl p-md ${
                    rpcResult.status === 'success'
                      ? 'bg-utility-success-50 text-utility-success-700 border border-utility-success-200'
                      : 'bg-utility-warning-50 text-utility-warning-700 border border-utility-warning-200'
                  }`}>
                    <Info className="mt-xxs size-5 shrink-0" aria-hidden="true" />

                    <div className="flex-1 text-xs">
                      <p className="font-semibold text-sm">
                        {rpcResult.status === 'success'
                          ? 'gRPC Request Successful'
                          : 'gRPC Request Not Confirmed'}
                      </p>

                      <p className="mt-xxs text-tertiary">
                        {rpcResult.status === 'success'
                          ? 'Read-only data successfully retrieved from Tatum Sui gRPC.'
                          : 'The request did not return a confirmed successful response.'}
                      </p>

                      <p className="mt-xs text-tertiary">
                        <strong className="text-secondary">Evidence status:</strong>{' '}
                        {rpcResult.evidenceStatus || 'Not established'}
                      </p>

                      <p className="mt-xxs text-tertiary">
                        <strong className="text-secondary">Verification:</strong>{' '}
                        {rpcResult.cryptographicallyVerified
                          ? 'Cryptographic verification confirmed'
                          : 'Not independently cryptographically verified'}
                      </p>
                    </div>
                  </div>

                  {/* Request Metadata */}
                  <div className="flex flex-wrap items-center justify-between gap-sm text-xs text-tertiary">
                    <div>
                      <span className="font-semibold text-secondary">
                        gRPC Result from Tatum Sui
                      </span>
                      <span className="ml-sm">
                        {rpcResult.operation || 'Sui gRPC operation'}
                      </span>
                    </div>

                    <span className="font-mono">
                      {rpcResult.timestamp}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-xs text-tertiary">
                    <span>
                      Provider: {rpcResult.provider || 'Tatum Sui gRPC'}
                    </span>
                    <span>
                      Duration: {rpcResult.durationMs ?? '—'} ms
                    </span>
                  </div>

                  {/* Raw gRPC Response */}
                  <pre className="p-md rounded-md bg-secondary border border-secondary font-mono text-xs text-primary overflow-x-auto leading-relaxed">
                    {JSON.stringify(rpcResult, null, 2)}
                  </pre>
                </div>
              )}

            </section>
          </div>
        )}

        {/* TAB 5: LEARNING ENGINE */}
        {activeTab === 'learning' && (
          <div className="space-y-xl">
            <div>
              <h1 className="text-heading-md font-semibold text-primary">Learning Engine & Epistemic Audit</h1>
              <p className="text-secondary text-sm">
                Transparent auditing of how new evidence revises confidence, updates source reliability, and updates conclusions.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <p className="text-sm text-tertiary">Evaluated Ground Truths</p>
                <p className="mt-md text-heading-xs font-semibold text-primary">
                  {provenanceFilter === 'live_production'
                    ? (metrics?.real.evaluatedClaims ?? 0)
                    : (metrics?.aggregated.evaluatedClaims ?? 0)}
                </p>
                <p className="text-xs text-secondary mt-xs">
                  {metrics?.real.evaluatedClaims ?? 0} live evaluated
                </p>
              </section>

             
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <p className="text-sm text-tertiary">Epistemic Revisions</p>
                <p className="mt-md text-heading-xs font-semibold text-brand-primary">
                  {decisions.length}
                </p>
                <p className="text-xs text-secondary mt-xs">
                  Recorded belief revision records
                </p>
              </section>

              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
                <p className="text-sm text-tertiary">Live Production Revisions</p>
                <p className="mt-md text-heading-xs font-semibold text-utility-success-700">
                  {decisions.filter(
                    decision => decision.provenance === 'live_production'
                  ).length}
                </p>
                <p className="text-xs text-secondary mt-xs">
                  Revisions generated by live production sessions
                </p>
              </section>
            </div>

            {/* Decision Evolution Log */}
            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
              <h2 className="text-heading-xs font-semibold text-primary">Epistemic Stance Revision Log</h2>
              <p className="text-xs text-tertiary">
                Detailed record explaining exactly why the agent revised earlier conclusions when new evidence was retrieved.
              </p>

              <div className="space-y-md">
                {decisions.map(dec => (
                  <div key={dec.id} className="p-md rounded-md bg-secondary border border-secondary space-y-sm">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-sm">
                        <span className="font-mono text-xs font-bold text-brand-primary">{dec.id}</span>
                        <h3 className="text-sm font-semibold text-primary">{dec.topic}</h3>
                        <span className={`inline-flex items-center rounded-xs px-xs py-xxs font-mono text-[10px] uppercase ${
                          dec.provenance === 'live_production'
                            ? 'bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200'
                            : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
                        }`}>
                          {dec.provenance === 'live_production' ? 'Live' : 'Demo Seed'}
                        </span>
                      </div>
                      <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                        Stance Revised
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-sm text-xs">
                      <div className="p-sm rounded-md bg-primary border border-secondary space-y-xxs">
                        <span className="font-semibold text-quaternary uppercase tracking-wider">Prior Conclusion ({dec.previousSessionId})</span>
                        <p className="text-secondary">{dec.priorClaim}</p>
                      </div>
                      <div className="p-sm rounded-md bg-primary border border-utility-success-200 space-y-xxs">
                        <span className="font-semibold text-utility-success-700 uppercase tracking-wider">Revised Conclusion ({dec.currentSessionId})</span>
                        <p className="text-primary font-medium">{dec.newClaim}</p>
                      </div>
                    </div>

                    <div className="text-xs text-tertiary pt-xs border-t border-secondary space-y-xxs">
                      <div>
                        <strong className="text-secondary">Reason for Revision:</strong> {dec.changeReason}
                      </div>
                      <div>
                        <strong className="text-brand-primary">Memory Impact:</strong> {dec.impact}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* TAB 6: AUDIT TIMELINE */}
        {activeTab === 'timeline' && (
          <div className="space-y-xl">
            <div>
              <h1 className="text-heading-md font-semibold text-primary">Audit Timeline</h1>
              <p className="text-secondary text-sm">
                Chronological ledger tracing research sessions, memory recalls, evidence verification, and decision updates.
              </p>
            </div>

            <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs">
              <div className="relative pl-6 space-y-lg border-l-2 border-secondary">
                {filteredTimeline.map((item, idx) => (
                  <div key={item.id || idx} className="relative space-y-xs">
                    <span className={`absolute -left-[31px] top-1 size-3 rounded-full ${
                      item.type === 'decision_update' ? 'bg-brand-solid' : 'bg-success-primary'
                    }`} />
                    <div className="flex items-center justify-between text-xs text-tertiary">
                      <span className="font-mono">{new Date(item.timestamp).toLocaleString()}</span>
                      <div className="flex items-center gap-xs">
                        <span className={`inline-flex items-center rounded-xs px-xs py-xxs font-mono text-[10px] uppercase ${
                          item.provenance === 'live_production'
                            ? 'bg-utility-brand-50 text-utility-brand-700 border border-utility-brand-200'
                            : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
                        }`}>
                          {item.provenance === 'live_production' ? 'Live' : 'Demo'}
                        </span>
                        <span className="inline-flex items-center gap-xs rounded-full border border-utility-gray-200 bg-utility-gray-50 px-md py-xxs text-xs font-medium text-utility-gray-700 font-mono">
                          {item.type}
                        </span>
                      </div>
                    </div>
                    <h3 className="text-sm font-semibold text-primary">{item.title}</h3>
                    <p className="text-xs text-secondary">{item.subtitle}</p>
                    <div className="p-sm rounded-md bg-secondary border border-secondary text-xs text-tertiary">
                      {item.details}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* TAB 7: WALRUS MEMWAL SDK SPECIFICATION */}
        {activeTab === 'sdk' && (
          <div className="space-y-xl">
            <div>
              <h1 className="text-heading-md font-semibold text-primary">Walrus Memory Python SDK (memwal) Integration</h1>
              <p className="text-secondary text-sm">
                Official specifications and autonomous agent code patterns for the Tatum × Walrus Total Recall Hackathon.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-xl">
              {/* SDK Specification Details */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md">
                <div className="flex items-center gap-xs">
                  <Code2 className="size-5 shrink-0 text-fg-brand-primary" />
                  <h2 className="text-heading-xs font-semibold text-primary">Integration Specification</h2>
                </div>

                <div className="space-y-sm text-xs">
                  <div className="flex items-center justify-between py-xs border-b border-secondary">
                    <span className="text-secondary font-semibold">Official SDK Package:</span>
                    <span className="font-mono text-primary font-bold">{sdkSpec?.sdk || 'memwal'}</span>
                  </div>
                  <div className="flex items-center justify-between py-xs border-b border-secondary">
                    <span className="text-secondary font-semibold">SDK Protocol Version:</span>
                    <span className="font-mono text-primary">{sdkSpec?.version || '0.2.1'}</span>
                  </div>
                  <div className="flex items-center justify-between py-xs border-b border-secondary">
                    <span className="text-secondary font-semibold">Storage Architecture:</span>
                    <span className="text-primary font-medium">{sdkSpec?.storageEngine || 'Walrus RedStuff 2D Reed-Solomon'}</span>
                  </div>
                  <div className="flex items-center justify-between py-xs border-b border-secondary">
                    <span className="text-secondary font-semibold">Active Walrus Publisher:</span>
                    <span className="font-mono text-primary">{sdkSpec?.endpoints?.publisher}</span>
                  </div>
                  <div className="flex items-center justify-between py-xs border-b border-secondary">
                    <span className="text-secondary font-semibold">Active Walrus Aggregator:</span>
                    <span className="font-mono text-primary">{sdkSpec?.endpoints?.aggregator}</span>
                  </div>
                  <div className="flex items-center justify-between py-xs border-b border-secondary">
                    <span className="text-secondary font-semibold">Tatum Sui RPC Gateway:</span>
                    <span className="font-mono text-primary">{sdkSpec?.endpoints?.tatumSuiGateway}</span>
                  </div>
                </div>

                <div className="space-y-xs pt-md">
                  <p className="text-sm font-medium text-secondary">
                    Required Environment Variables
                  </p>
                  <div className="space-y-xs">
                    {sdkSpec?.envRequirements?.map((env: any) => (
                      <div key={env.name} className="p-xs rounded-md bg-secondary border border-secondary text-xs">
                        <span className="font-mono font-bold text-brand-primary block">{env.name}</span>
                        <span className="text-tertiary">{env.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>

              {/* Sample Python Code */}
              <section className="rounded-xl border border-secondary bg-primary p-xl shadow-xs space-y-md flex flex-col">
                <div className="flex items-center justify-between">
                  <h2 className="text-heading-xs font-semibold text-primary">Python Agent Implementation</h2>
                  <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700 font-mono">
                    agent_walrus.py
                  </span>
                </div>
                <div className="flex-1 p-md rounded-md bg-secondary border border-secondary font-mono text-xs text-primary overflow-x-auto leading-relaxed">
                  <pre>{sdkSpec?.officialPythonExample || '// Loading SDK specification...'}</pre>
                </div>
              </section>
            </div>
          </div>
        )}
        </>}
      </main>

      {/* Toast notifications */}
      {toast && (
        <div className={`toast toast-${toast.type}`} role="status" aria-live="polite">
          {toast.type === 'success' ? <CheckCircle2 className="size-5 shrink-0" /> : toast.type === 'error' ? <AlertCircle className="size-5 shrink-0" /> : <Info className="size-5 shrink-0" />}
          <span>{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification">×</button>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-secondary bg-primary px-xl py-md mt-auto">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-xs text-tertiary">
          <div className="flex items-center gap-sm">
            <span className="font-semibold text-primary">RecallGuard</span>
            <span>•</span>
            <span>Walrus Memory Protocol</span>
            <span>•</span>
            <span>Tatum Sui RPC</span>
          </div>
          <div>Read-Only Cryptographic Verification • No Private Key Signatures Required</div>
        </div>
      </footer>
    </div>
  );
}
