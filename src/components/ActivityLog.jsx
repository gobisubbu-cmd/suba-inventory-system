import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query, limit } from 'firebase/firestore';
import { History } from 'lucide-react';

// Per-user activity trail.
//  - Admin sees everyone's activity with a user filter dropdown.
//  - Every other role sees only their own actions — so staff can check
//    their own work log any time, but not each other's.
// All entries come from the shared `activityLogs` collection written by
// logActivity() (see src/lib/activityLog.js).
const PAGE_SIZE = 100;

export default function ActivityLog({ userRole, userEmail }) {
  const [logs, setLogs] = useState([]);
  const [userFilter, setUserFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const isAdmin = userRole === 'admin';

  useEffect(() => {
    // Most recent 1000 entries; ordered server-side, filtered client-side
    // (avoids needing a composite Firestore index per filter combination).
    const q = query(collection(db, 'activityLogs'), orderBy('createdAt', 'desc'), limit(1000));
    const unsub = onSnapshot(q, (snap) => {
      setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  const visibleLogs = useMemo(() => {
    let list = logs;
    if (!isAdmin) {
      list = list.filter((l) => (l.userEmail || '').toLowerCase() === (userEmail || '').toLowerCase());
    } else if (userFilter !== 'All') {
      list = list.filter((l) => l.userEmail === userFilter);
    }
    const s = search.trim().toLowerCase();
    if (s) {
      list = list.filter((l) =>
        (l.action || '').toLowerCase().includes(s) ||
        (l.details || '').toLowerCase().includes(s) ||
        (l.userEmail || '').toLowerCase().includes(s)
      );
    }
    return list;
  }, [logs, isAdmin, userEmail, userFilter, search]);

  const userOptions = useMemo(() => {
    const set = new Set(logs.map((l) => l.userEmail).filter(Boolean));
    return ['All', ...[...set].sort()];
  }, [logs]);

  useEffect(() => setPage(0), [userFilter, search]);
  const pageCount = Math.max(1, Math.ceil(visibleLogs.length / PAGE_SIZE));
  const pageItems = visibleLogs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const fmt = (ts) => {
    if (!ts) return '-';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <History className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Activity Log</h1>
      </div>
      <p className="text-sm text-gray-500">
        {isAdmin
          ? 'Every user\'s actions — imports, stock movements, edits, adjustments and user changes. Filter by user to review anyone\'s activity.'
          : 'Your own activity — every import, stock movement and edit you have made.'}
      </p>

      <div className="flex flex-wrap gap-3 items-end">
        {isAdmin && (
          <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
            {userOptions.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search action or details..."
          className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600 flex-1 max-w-md"
        />
        <span className="text-sm text-gray-500 pb-2">{visibleLogs.length} entries</span>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Date & Time</th>
              {isAdmin && <th className="text-left px-4 py-3 font-semibold text-gray-600">User</th>}
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Action</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Details</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 4 : 3} className="px-4 py-8 text-center text-gray-400">
                  No activity recorded yet.
                </td>
              </tr>
            )}
            {pageItems.map((l) => (
              <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 whitespace-nowrap">{fmt(l.createdAt)}</td>
                {isAdmin && (
                  <td className="px-4 py-3">
                    <span className="inline-block bg-emerald-50 text-emerald-800 text-xs font-semibold px-2 py-1 rounded">{l.userEmail}</span>
                  </td>
                )}
                <td className="px-4 py-3 font-medium text-gray-800">{l.action}</td>
                <td className="px-4 py-3 text-gray-600">{l.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm text-gray-500">
            <span>Page {page + 1} of {pageCount}</span>
            <div className="flex gap-2">
              <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 border rounded disabled:opacity-40">Prev</button>
              <button disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 border rounded disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
