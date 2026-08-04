import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query, limit } from 'firebase/firestore';
import { LayoutDashboard, AlertTriangle, PackageX, Wallet, Layers, PackageCheck, Clock } from 'lucide-react';
import { LOCATION_STATUS, computePutawayStats } from '../putaway';
import { computeStockStatus } from '../lib/brands';

// Everything that used to live on the Dashboard except the search box:
// summary stats, brand-wise breakdown, warehouse put-away alerts and recent
// activity. Low/out-of-stock items needing reorder now have their own page
// (see ReorderItems.jsx / Navigation "Reorder Items").
export default function Overview({ userRole, onViewChange }) {
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [brandFilter, setBrandFilter] = useState('All');
  const [putawayStats, setPutawayStats] = useState(null);
  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'transactions'), orderBy('createdAt', 'desc'), limit(30));
    const unsub = onSnapshot(q, (snap) => {
      setTransactions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'putawayLines'), (snap) => {
      const pending = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((l) => l.status !== LOCATION_STATUS.COMPLETE);
      setPutawayStats(computePutawayStats(pending));
    });
    return unsub;
  }, []);

  const summary = useMemo(() => {
    let totalValue = 0;
    let lowStock = 0;
    let outOfStock = 0;
    let notStocked = 0;
    let pendingReorder = 0;
    const byBrand = {};
    items.forEach((it) => {
      const status = computeStockStatus(it);
      const value = Number(it.currentStock || 0) * Number(it.avgCost || it.purchaseCost || 0);
      totalValue += value;
      if (status === 'Low Stock') { lowStock += 1; pendingReorder += 1; }
      if (status === 'Out of Stock') { outOfStock += 1; pendingReorder += 1; }
      if (status === 'Not Stocked') notStocked += 1;
      const b = it.brand || 'Unassigned';
      // Brand-wise Stock badges should read as "what do we actually have",
      // not the full catalogue count — a brand with a large master
      // catalogue (parts never received) would otherwise show a number far
      // bigger than what's physically on the shelf. Matches the "Physically
      // Stocked" column on the Brands page.
      if (status !== 'Not Stocked') {
        byBrand[b] = (byBrand[b] || 0) + 1;
      }
    });
    return { totalValue, lowStock, outOfStock, notStocked, pendingReorder, total: items.length, byBrand };
  }, [items]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <LayoutDashboard className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Overview</h1>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard icon={Layers} label="Total Spare Parts" value={summary.total.toLocaleString('en-IN')} />
        {canSeeValue && (
          <SummaryCard icon={Wallet} label="Total Inventory Value" value={`₹${summary.totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} />
        )}
        <SummaryCard
          icon={AlertTriangle}
          label="Low + Out of Stock"
          value={summary.pendingReorder.toLocaleString('en-IN')}
          tone="amber"
          onClick={onViewChange ? () => onViewChange('reorder') : undefined}
        />
        <SummaryCard icon={PackageX} label="Not Stocked (catalogue only)" value={summary.notStocked.toLocaleString('en-IN')} tone="gray" />
      </div>

      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="font-semibold text-gray-700 mb-3 flex items-center gap-2"><Layers size={16} /> Brand-wise Stock</h2>
        <div className="flex flex-wrap gap-2">
          {Object.entries(summary.byBrand).sort().map(([brand, count]) => (
            <button
              key={brand}
              onClick={() => setBrandFilter(brandFilter === brand ? 'All' : brand)}
              className={`px-3 py-2 rounded-lg border text-sm ${brandFilter === brand ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'}`}
            >
              {brand}: <span className="font-semibold">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {putawayStats && putawayStats.pendingItems > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <PackageX className="text-amber-600 shrink-0" size={20} />
            <h2 className="font-bold text-amber-800">Warehouse locations pending</h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Pending Purchase Invoices</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.pendingInvoices}</p>
            </div>
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Pending Items</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.pendingItems}</p>
            </div>
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Pending Quantity</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.pendingQty}</p>
            </div>
            <div className="bg-white rounded-lg p-3 border border-amber-100">
              <p className="text-gray-500 text-xs">Oldest / Newest Pending</p>
              <p className="text-lg font-bold text-gray-800">{putawayStats.oldestDays}d / {putawayStats.newestDays}d</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <RecentActivity title="Recently Issued Parts" icon={PackageX} tone="red" txns={transactions.filter((t) => t.direction === 'out').slice(0, 8)} />
        <RecentActivity title="Recently Purchased Parts" icon={PackageCheck} tone="green" txns={transactions.filter((t) => t.type === 'purchase' || t.type === 'opening').slice(0, 8)} />
      </div>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, tone = 'emerald', onClick }) {
  const tones = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    gray: 'bg-gray-100 text-gray-600',
  };
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={`bg-white rounded-lg shadow p-4 flex items-center gap-3 text-left w-full ${onClick ? 'hover:shadow-md transition cursor-pointer' : ''}`}
    >
      <div className={`p-2 rounded-lg ${tones[tone]}`}><Icon size={20} /></div>
      <div>
        <p className="text-xs text-gray-500">{label}</p>
        <p className="text-lg font-bold text-gray-800">{value}</p>
      </div>
    </Comp>
  );
}

function RecentActivity({ title, icon: Icon, tone, txns }) {
  const tones = { red: 'text-red-600', green: 'text-green-600' };
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h2 className="font-semibold text-gray-700 mb-3 flex items-center gap-2"><Icon size={16} className={tones[tone]} /> {title}</h2>
      {txns.length === 0 ? (
        <p className="text-sm text-gray-400">No recent activity.</p>
      ) : (
        <ul className="space-y-2">
          {txns.map((t) => (
            <li key={t.id} className="flex items-center justify-between text-sm border-b last:border-0 pb-2 last:pb-0">
              <div>
                <span className="font-medium text-gray-800">{t.itemName}</span>
                {t.brand && <span className="text-gray-400 ml-1">[{t.brand}]</span>}
              </div>
              <div className="flex items-center gap-2 text-gray-500">
                <span>{t.quantity}</span>
                <Clock size={12} />
                <span className="text-xs">
                  {t.transactionDate || (t.createdAt?.toDate ? t.createdAt.toDate().toLocaleDateString() : '')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
