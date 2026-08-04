import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { ScanLine, HardHat, Search, Smartphone, X } from 'lucide-react';
import { computeStockStatus } from '../lib/brands';

// Field Mode: the deliberately small, phone-first landing page. The
// desktop app's dense sidebar of 15+ pages doesn't work well on a phone —
// this is a handful of big, single-purpose actions for whoever is standing
// in the warehouse or at a customer site with their phone out, not sitting
// at a desk. See mobileScan / mobileEngineer views in App.jsx, plus the
// read-only Quick Stock Check built directly into this screen.
export default function FieldMode({ userRole, onOpenScan, onOpenEngineer, onExit }) {
  const canScan = userRole === 'admin' || userRole === 'inventory_manager';

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-emerald-700 text-white px-5 pt-6 pb-8 rounded-b-3xl shadow">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <Smartphone size={22} />
            <span className="text-sm font-medium text-emerald-100">Field Mode</span>
          </div>
          <button onClick={onExit} className="p-1 text-emerald-100 active:text-white" aria-label="Exit Field Mode">
            <X size={22} />
          </button>
        </div>
        <h1 className="text-2xl font-bold">What do you need?</h1>
      </div>

      <div className="p-4 -mt-4 space-y-3">
        {canScan && (
          <ActionCard
            icon={ScanLine}
            title="Quick Scan"
            subtitle="Photograph a chit, invoice, or DC and record it"
            color="emerald"
            onClick={onOpenScan}
          />
        )}
        <ActionCard
          icon={HardHat}
          title="Engineer Issue / Return"
          subtitle="Spare parts for a service call"
          color="amber"
          onClick={onOpenEngineer}
        />
      </div>

      <QuickStockCheck />
    </div>
  );
}

function ActionCard({ icon: Icon, title, subtitle, color, onClick }) {
  const colors = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <button
      onClick={onClick}
      className="w-full bg-white rounded-2xl shadow p-5 flex items-center gap-4 text-left active:bg-gray-50"
    >
      <div className={`p-3 rounded-xl ${colors[color]}`}>
        <Icon size={26} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-bold text-gray-800 text-lg">{title}</p>
        <p className="text-sm text-gray-500">{subtitle}</p>
      </div>
    </button>
  );
}

// A lightweight "do we have X" lookup, right on the landing screen — the
// most common ad-hoc question in the field, and the one thing that
// shouldn't require picking a menu item first.
function QuickStockCheck() {
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return unsub;
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return items
      .filter((it) => {
        const hay = [it.particulars, it.brand, it.partNumber, it.partCode].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 20);
  }, [items, query]);

  return (
    <div className="px-4 pb-8">
      <h2 className="text-sm font-semibold text-gray-500 uppercase mb-2 px-1">Quick Stock Check</h2>
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by part name, number, brand..."
          className="w-full pl-10 pr-3 py-3 border rounded-xl text-base bg-white focus:outline-none focus:border-emerald-600"
        />
      </div>
      {results.length > 0 && (
        <div className="bg-white rounded-2xl shadow divide-y">
          {results.map((it) => {
            const status = computeStockStatus(it);
            return (
              <div key={it.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{it.particulars}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {it.brand ? `[${it.brand}] ` : ''}{it.partNumber || it.partCode || ''}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-gray-800">{it.currentStock ?? 0}</p>
                  <p className={`text-xs ${status === 'Out of Stock' ? 'text-red-600' : status === 'Low Stock' ? 'text-amber-600' : 'text-gray-400'}`}>{status}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {query.trim().length >= 2 && results.length === 0 && (
        <p className="text-center text-gray-400 text-sm py-4">No matches for "{query}".</p>
      )}
    </div>
  );
}
