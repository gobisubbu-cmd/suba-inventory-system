import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { PackageX, X } from 'lucide-react';
import { LOCATION_STATUS, computePutawayStats } from '../putaway';

// Shows once per browser session (per spec: "Every time Administrator logs
// into the software, display popup") — re-appears every fresh login/reload,
// but doesn't nag the admin repeatedly during the same session once dismissed.
export default function PutawayAlertPopup({ userRole, onViewReport }) {
  const [stats, setStats] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  const canSee = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    if (!canSee) return;
    const unsub = onSnapshot(collection(db, 'putawayLines'), (snap) => {
      const pending = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((l) => l.status !== LOCATION_STATUS.COMPLETE);
      setStats(computePutawayStats(pending));
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSee]);

  if (!canSee || !stats || stats.pendingItems === 0 || dismissed) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 text-amber-700">
            <PackageX size={22} />
            <h2 className="font-bold text-lg">Warehouse Location Pending</h2>
          </div>
          <button onClick={() => setDismissed(true)} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Pending Invoices" value={stats.pendingInvoices} />
          <Stat label="Pending Items" value={stats.pendingItems} />
          <Stat label="Pending Quantity" value={stats.pendingQty} />
          <Stat label="Oldest Pending" value={`${stats.oldestDays} day${stats.oldestDays === 1 ? '' : 's'}`} />
        </div>
        <p className="text-sm text-gray-500">Please upload the Put-away Location Report.</p>
        <div className="flex gap-3">
          <button
            onClick={() => {
              setDismissed(true);
              onViewReport();
            }}
            className="flex-1 bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg"
          >
            View Report
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="px-4 py-2 rounded-lg text-gray-600 hover:bg-gray-100"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
      <p className="text-gray-500 text-xs">{label}</p>
      <p className="text-xl font-bold text-amber-800">{value}</p>
    </div>
  );
}
