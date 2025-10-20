'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ethers } from 'ethers';
import { getBids, getProofs, archiveProof } from '@/lib/api';
import { useWeb3Auth } from '@/providers/Web3AuthProvider';
import SendFunds from '@/components/SendFunds';

// ---- RPC (read-only) ----
// Uses env when present (NEXT_PUBLIC_SEPOLIA_RPC) and falls back to public Sepolia.
const RPC_URL =
  (process.env.NEXT_PUBLIC_SEPOLIA_RPC || '').replace(/\/+$/, '') ||
  'https://rpc.ankr.com/eth_sepolia';

// --- ERC20 + Tokens (unchanged) ---
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const TOKENS: Record<string, string> = {
  USDT: '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06',
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
};

// --- Tabs ---
const TABS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },      // pending or approved + not fully completed
  { key: 'awarded', label: 'Awarded' },    // approved
  { key: 'completed', label: 'Completed' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'archived', label: 'Archived' },
] as const;
type TabKey = typeof TABS[number]['key'];

export default function VendorDashboard() {
  const router = useRouter();
  const { address, logout, provider } = useWeb3Auth();

  const [bids, setBids] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [balances, setBalances] = useState<{ ETH?: string; USDT?: string; USDC?: string }>({});
  const [tab, setTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');

  // Track archiving state per-bid to disable button + show "Archiving…"
  const [archivingIds, setArchivingIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!address) {
      router.push('/vendor/login');
      return;
    }
    loadBids();
    loadBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  async function archiveAnyProofForBid(bidId: number) {
    // Load proofs for this bid (vendor-safe)
    const proofs = await getProofs(bidId);

    // Pick a proof we’re allowed to archive (not pending, not already archived)
    const target =
      proofs.find(p => p.status !== 'pending' && p.status !== 'archived') ??
      proofs[0];

    if (!target?.proofId && !target?.proof_id) {
      throw new Error('No proofs to archive for this bid.');
    }

    const proofId = target.proofId ?? target.proof_id;

    // Vendor-safe endpoint → POST /proofs/:proofId/archive
    return await archiveProof(proofId);
  }

  const loadBids = async () => {
    try {
      const all = await getBids();
      const mine = all
        .filter((b: any) => b?.walletAddress?.toLowerCase() === address?.toLowerCase())
        .map((b: any) => ({ ...b, proofs: b.proofs || [] }));
      setBids(mine);
    } catch (e) {
      console.error('Error loading bids:', e);
    } finally {
      setLoading(false);
    }
  };

  const loadBalances = async () => {
    if (!address) return;
    try {
      let ethersProvider: ethers.Provider;
      if (provider) {
        ethersProvider = new ethers.BrowserProvider(provider as any);
      } else {
        ethersProvider = new ethers.JsonRpcProvider(RPC_URL);
      }

      const rawBalance = await ethersProvider.getBalance(address);
      const ethBal = ethers.formatEther(rawBalance);

      const results: any = { ETH: ethBal };
      for (const [symbol, tokenAddr] of Object.entries(TOKENS)) {
        try {
          const contract = new ethers.Contract(tokenAddr, ERC20_ABI, ethersProvider);
          const [raw, decimals] = await Promise.all([contract.balanceOf(address), contract.decimals()]);
          results[symbol] = ethers.formatUnits(raw, decimals);
        } catch (err) {
          console.error(`Error fetching ${symbol} balance:`, err);
        }
      }
      setBalances(results);
    } catch (err) {
      console.error('Error fetching balances:', err);
      setBalances({});
    }
  };

  const handleLogout = async () => {
    await logout();
    router.push('/vendor/login');
  };

  const shortAddr = useMemo(() => (address ? address.slice(0, 6) + '…' + address.slice(-4) : ''), [address]);

  const isBidCompleted = (bid: any) => {
    if (bid?.status === 'completed') return true;
    const ms = Array.isArray(bid?.milestones) ? bid.milestones : [];
    return ms.length > 0 && ms.every((m: any) => !!m.completed);
  };

  const computedStatusLabel = (bid: any) => {
    if (bid.status === 'completed' || isBidCompleted(bid)) return 'Completed';
    if (bid.status === 'approved') {
      const ms = Array.isArray(bid.milestones) ? bid.milestones : [];
      const done = ms.filter((m: any) => m.completed).length;
      return `In Progress (${done}/${ms.length || 0})`;
    }
    if (bid.status === 'archived') return 'Archived';
    return bid.status?.charAt(0).toUpperCase() + bid.status?.slice(1);
  };

  const filtered = useMemo(() => {
    const lowerQ = query.trim().toLowerCase();
    const base = bids.filter((b) => {
      if (!lowerQ) return true;
      const hay = `${b.title || ''} ${b.orgName || ''} ${b.vendorName || ''} ${b.notes || ''}`.toLowerCase();
      return hay.includes(lowerQ);
    });

    switch (tab) {
      case 'active':
        return base.filter(
          (b) => b.status === 'pending' || (b.status === 'approved' && !isBidCompleted(b))
        );
      case 'awarded':
        return base.filter((b) => b.status === 'approved');
      case 'completed':
        return base.filter((b) => b.status === 'completed' || isBidCompleted(b));
      case 'rejected':
        return base.filter((b) => b.status === 'rejected');
      case 'archived':
        return base.filter((b) => b.status === 'archived');
      default:
        return base;
    }
  }, [bids, tab, query]);

  const onArchive = async (bidId: number) => {
  const ok = window.confirm('Move this bid to Archived? You can still view it under the "Archived" tab.');
  if (!ok) return;

  setArchivingIds(prev => new Set(prev).add(bidId));
  try {
    await archiveAnyProofForBid(bidId);  // archives a proof (vendor-safe)
    await loadBids();                    // refresh the list; don't replace a bid with a proof
  } catch (e: any) {
    alert('Failed to archive: ' + (e?.message || 'Unknown error'));
  } finally {
    setArchivingIds(prev => {
      const next = new Set(prev);
      next.delete(bidId);
      return next;
    });
  }
};

  if (loading) {
    return (
      <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(148,163,184,0.12),_transparent_65%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(15,23,42,0.98))]" />
        <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="grid gap-6">
            <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-8 shadow-2xl backdrop-blur">
              <div className="h-6 w-32 animate-pulse rounded-full bg-white/20" />
              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                {[0, 1, 2].map((key) => (
                  <div key={key} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="h-4 w-24 animate-pulse rounded-full bg-white/10" />
                    <div className="mt-4 h-6 w-3/4 animate-pulse rounded-full bg-white/15" />
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-3xl border border-white/10 bg-slate-900/50 p-8 shadow-2xl backdrop-blur">
              <div className="h-5 w-40 animate-pulse rounded-full bg-white/15" />
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {[0, 1, 2, 3].map((key) => (
                  <div key={key} className="h-32 rounded-2xl border border-white/10 bg-white/5" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(148,163,184,0.18),_transparent_62%)]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(15,23,42,0.95),rgba(15,23,42,0.99))]" />
      <div className="relative z-10 mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Hero */}
        <div className="mb-12 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)]">
          <div className="rounded-3xl border border-white/10 bg-slate-900/60 p-8 shadow-2xl backdrop-blur">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-4">
                <div>
                  <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Vendor Workspace</p>
                  <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white md:text-4xl">
                    Vendor Dashboard
                  </h1>
                </div>
                <div className="space-y-2 text-sm text-slate-300">
                  <p>
                    Signed in as{' '}
                    <span className="rounded-full bg-white/10 px-2.5 py-1 font-mono text-xs uppercase tracking-wider text-white">
                      {shortAddr}
                    </span>
                  </p>
                  <p className="break-all font-mono text-xs text-slate-400">Wallet: {address}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => navigator.clipboard.writeText(address || '')}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-medium text-white transition hover:border-white/20 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                >
                  Copy Address
                </button>
                <button
                  onClick={handleLogout}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-900 shadow-lg transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                  Sign Out
                </button>
              </div>
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              <BalanceCard label="ETH" value={balances.ETH} />
              <BalanceCard label="USDT" value={balances.USDT} />
              <BalanceCard label="USDC" value={balances.USDC} />
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-slate-900/40 p-8 shadow-xl backdrop-blur">
            <h2 className="text-base font-semibold text-white">Send Funds</h2>
            <p className="mt-1 text-sm text-slate-400">
              Transfer project payments directly from your connected wallet.
            </p>
            <div className="mt-6 rounded-2xl border border-white/10 bg-slate-950/40 p-4">
              <SendFunds />
            </div>
          </div>
        </div>

        {/* Tabs + search */}
        <div className="mb-8 flex flex-col gap-4 rounded-3xl border border-white/10 bg-slate-900/50 p-6 shadow-xl backdrop-blur md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={[
                  'rounded-full px-4 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300',
                  tab === t.key
                    ? 'bg-emerald-500 text-slate-900 shadow'
                    : 'border border-white/10 bg-white/5 text-slate-200 hover:border-white/20 hover:bg-white/10',
                ].join(' ')}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="w-full md:w-72">
            <label className="relative block">
              <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-sm text-slate-500">
                🔍
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search bids…"
                className="w-full rounded-full border border-white/10 bg-slate-950/60 px-11 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
            </label>
          </div>
        </div>

        {/* Bid list */}
        <div className="space-y-6">
          {filtered.map((bid) => {
            const ms = Array.isArray(bid.milestones) ? bid.milestones : [];
            const done = ms.filter((m: any) => m.completed).length;
            const total = ms.length;
            const progress = total ? Math.round((done / total) * 100) : 0;

            // ✅ allow archive if not already archived
            const canArchive = bid.status !== 'archived';
            const isArchiving = archivingIds.has(bid.bidId);

            return (
              <div
                key={bid.bidId}
                className="rounded-3xl border border-white/10 bg-slate-900/40 p-8 shadow-xl backdrop-blur transition hover:border-white/20 hover:bg-slate-900/60"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold text-white">{bid.title}</h2>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-300">
                      <span className="font-mono text-xs uppercase tracking-widest text-slate-400">
                        #{bid.bidId}
                      </span>
                      {bid.orgName && (
                        <span>
                          <span className="text-slate-500">Organization:</span> {bid.orgName}
                        </span>
                      )}
                    </div>
                  </div>
                  <StatusPill status={bid.status} label={computedStatusLabel(bid)} />
                </div>

                {/* Progress */}
                <div className="mt-6 space-y-2">
                  <div className="flex flex-col gap-1 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between">
                    <p>
                      Milestones completed{' '}
                      <span className="font-semibold text-white">
                        {done}
                        <span className="text-slate-500"> / {total}</span>
                      </span>
                    </p>
                    <p className="font-mono text-xs uppercase tracking-widest text-slate-400">{progress}%</p>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-emerald-500 to-sky-500 transition-[width] duration-500"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-6 flex flex-wrap gap-3">
                  <Link
                    href={`/vendor/bids/${bid.bidId}`}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/10"
                    title="Open bid details and interact with Agent 2"
                  >
                    View / Agent 2
                  </Link>

                  {bid.status?.toLowerCase() === 'approved' && (
                    <>
                      <Link
                        href={`/vendor/proof/${bid.bidId}`}
                        className="inline-flex items-center justify-center gap-2 rounded-2xl bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-900 shadow transition hover:bg-sky-400"
                      >
                        Submit Proof
                      </Link>
                      <button
                        onClick={() => navigator.clipboard.writeText(bid.walletAddress)}
                        className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/10"
                      >
                        Copy Wallet Address
                      </button>
                    </>
                  )}

                  {canArchive && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onArchive(bid.bidId);
                      }}
                      disabled={isArchiving}
                      className={[
                        'inline-flex items-center justify-center gap-2 rounded-2xl border px-4 py-2 text-sm font-medium transition',
                        'border-amber-300/40 bg-amber-500/10 text-amber-200 hover:border-amber-300/60 hover:bg-amber-400/20',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                      ].join(' ')}
                      title="Move this bid to Archived"
                    >
                      {isArchiving ? 'Archiving…' : 'Move to Archived'}
                    </button>
                  )}
                </div>

                {/* Quick facts */}
                <div className="mt-8 grid gap-4 md:grid-cols-4">
                  <InfoTile label="Your Bid" value={`$${Number(bid.priceUSD).toLocaleString()}`} accent="text-emerald-300" />
                  <InfoTile label="Timeline" value={`${bid.days} days`} />
                  <InfoTile label="Payment" value={`${bid.preferredStablecoin}`} helper={`to ${bid.walletAddress}`} />
                  <InfoTile label="Status" value={computedStatusLabel(bid)} />
                </div>

                {/* Submitted proofs */}
                {bid.proofs?.length > 0 && (
                  <div className="mt-8 border-t border-white/10 pt-6">
                    <h3 className="text-sm font-semibold uppercase tracking-widest text-slate-300">Submitted Proofs</h3>
                    <div className="mt-4 grid gap-3">
                      {bid.proofs.map((p: any, i: number) => (
                        <div key={i} className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                          <p className="text-sm text-slate-200 whitespace-pre-line">{p.description || 'No description'}</p>
                          {p.files?.length > 0 && (
                            <ul className="mt-3 space-y-1">
                              {p.files.map((f: any, j: number) => (
                                <li key={j} className="text-sm">
                                  <a
                                    href={f.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-emerald-300 underline-offset-4 hover:text-emerald-200 hover:underline"
                                  >
                                    {f.name}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          )}
                          <span
                            className={`mt-4 inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-widest ${
                              p.status === 'approved'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : p.status === 'rejected'
                                ? 'bg-rose-500/20 text-rose-200'
                                : 'bg-amber-500/20 text-amber-200'
                            }`}
                          >
                            {p.status || 'pending'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="rounded-3xl border border-white/10 bg-slate-900/50 p-12 text-center shadow-xl backdrop-blur">
              <div className="text-5xl mb-4">🗂️</div>
              <h2 className="text-xl font-semibold text-white mb-2">No bids in this view</h2>
              <p className="text-sm text-slate-400 mb-6">Try a different tab or clear your search.</p>
              <Link
                href="/projects"
                className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-6 py-2.5 text-sm font-semibold text-slate-900 shadow transition hover:bg-emerald-400"
              >
                Browse Projects
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Presentation bits ---------------- */

function BalanceCard({ label, value }: { label: string; value?: string }) {
  const display = value ? Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—';
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-4 shadow-inner">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">{label} Balance</div>
      <div className="mt-2 text-2xl font-semibold text-white tabular-nums">{display}</div>
    </div>
  );
}

function StatusPill({ status, label }: { status: string; label: string }) {
  const cls =
    status === 'approved'
      ? 'bg-emerald-500/20 text-emerald-200'
      : status === 'completed'
      ? 'bg-sky-500/20 text-sky-200'
      : status === 'rejected'
      ? 'bg-rose-500/20 text-rose-200'
      : status === 'archived'
      ? 'bg-slate-500/20 text-slate-300'
      : 'bg-amber-500/20 text-amber-200';
  return (
    <span className={`inline-flex items-center rounded-full px-4 py-1.5 text-xs font-semibold uppercase tracking-widest ${cls}`}>
      {label}
    </span>
  );
}

function InfoTile({
  label,
  value,
  helper,
  accent,
}: {
  label: string;
  value: string;
  helper?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/40 p-4">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">{label}</p>
      <p className={[`mt-2 text-lg font-semibold`, accent || 'text-white'].join(' ')}>{value}</p>
      {helper && <p className="mt-1 text-xs text-slate-400 break-all">{helper}</p>}
    </div>
  );
}
