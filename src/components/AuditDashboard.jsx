import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { ClipboardList, Download, ShieldAlert, Users, SearchX, CalendarDays } from 'lucide-react';

export default function AuditDashboard({ userRole, userEmail }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [filterUser, setFilterUser] = useState('');
  const [filterCustomer, setFilterCustomer] = useState('');
  const [filterTerm, setFilterTerm] = useState('');

  const isAdmin = userRole === 'admin';

  // Log that an admin opened the audit dashboard (access is itself audited)
  useEffect(() => {
    if (!isAdmin) return;
    addDoc(collection(db, 'auditAccessLog'), {
      userEmail: userEmail || 'unknown',
      createdAt: serverTimestamp(),
      device: navigator.userAgent,
    }).catch(() => {});
  }, [isAdmin, userEmail]);

  useEffect(() => {
    if (!isAdmin) return;
    const q = query(collection(db, 'spareSearchAudit'), orderBy('createdAt', 'desc'), limit(1000));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        setError('Could not load audit logs: ' + err.message);
        setLoading(false);
      }
    );
    return unsub;
  }, [isAdmin]);

  const filtered = useMemo(() => {
    return logs.filter((log) => {
      const ts = log.createdAt && log.createdAt.toDate ? log.createdAt.toDate() : null;
      if (fromDate && ts && ts < new Date(fromDate + 'T00:00:00')) return false;
      if (toDate && ts && ts > new Date(toDate + 'T23:59:59')) return false;
      if (filterUser && !(log.userEmail || '').toLowerCase().includes(filterUser.toLowerCase())) return false;
      if (filterCustomer && !(log.customerName || '').toLowerCase().includes(filterCustomer.toLowerCase())) return false;
      if (filterTerm && !(log.searchTerm || '').toLowerCase().includes(filterTerm.toLowerCase())) return false;
      return true;
    });
  }, [logs, fromDate, toDate, filterUser, filterCustomer, filterTerm]);

  const stats = useMemo(() => {
    const todayStr = new Date().toLocaleDateString('en-IN');
    return {
      total: filtered.length,
      today: filtered.filter((l) => l.dateStr === todayStr).length,
      notFound: filtered.filter((l) => l.found === false).length,
      customers: new Set(filtered.map((l) => l.customerName)).size,
    };
  }, [filtered]);

  const exportExcel = () => {
    const rows = filtered.map((log) => ({
      Date: log.dateStr || '',
      Time: log.timeStr || '',
      User: log.userEmail || '',
      Role: log.userRole || '',
      Customer: log.customerName || '',
      'Customer Phone': log.customerPhone || '',
      'Search Term': log.searchTerm || '',
      'Results Found': log.resultsCount ?? '',
      Status: log.found ? 'FOUND' : 'NOT FOUND',
      'Session ID': log.sessionId || '',
      Device: log.device || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Log');
    XLSX.writeFile(wb, `spare-search-audit-${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  if (!isAdmin) {
    return (
      <div className="flex items-center gap-3 bg-red-50 text-red-700 px-5 py-4 rounded-xl max-w-xl">
        <ShieldAlert size={22} />
        <span>Access denied. The Audit Dashboard is available to admins only.</span>
      </div>
    );
  }

  return (
    <div className="max-w-6xl">
      <div className="mb-6 flex flex-wrap justify-between items-start gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <ClipboardList className="text-emerald-700" size={28} />
            Audit Dashboard
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Every spare search is recorded here. Records cannot be edited or deleted.
          </p>
        </div>
        <button
          onClick={exportExcel}
          disabled={filtered.length === 0}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-medium disabled:opacity-50"
        >
          <Download size={18} /> Export to Excel
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow p-4">
          <p className="text-gray-500 text-sm flex items-center gap-1"><ClipboardList size={15} /> Total Searches</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{stats.total}</p>
        </div>
        <div className="bg-white rounded-xl shadow p-4">
          <p className="text-gray-500 text-sm flex items-center gap-1"><CalendarDays size={15} /> Today</p>
          <p className="text-2xl font-bold text-emerald-700 mt-1">{stats.today}</p>
        </div>
        <div className="bg-white rounded-xl shadow p-4">
          <p className="text-gray-500 text-sm flex items-center gap-1"><SearchX size={15} /> Not Found</p>
          <p className="text-2xl font-bold text-red-600 mt-1">{stats.notFound}</p>
        </div>
        <div className="bg-white rounded-xl shadow p-4">
          <p className="text-gray-500 text-sm flex items-center gap-1"><Users size={15} /> Customers</p>
          <p className="text-2xl font-bold text-gray-800 mt-1">{stats.customers}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow p-4 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
        <div>
          <label className="text-xs text-gray-500">From date</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500">To date</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500">User</label>
          <input type="text" placeholder="Filter by user email" value={filterUser} onChange={(e) => setFilterUser(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500">Customer</label>
          <input type="text" placeholder="Filter by customer" value={filterCustomer} onChange={(e) => setFilterCustomer(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-gray-500">Search term</label>
          <input type="text" placeholder="Filter by spare part" value={filterTerm} onChange={(e) => setFilterTerm(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      {error && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4">{error}</div>}

      {/* Log table */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        {loading ? (
          <p className="p-6 text-gray-500">Loading audit logs...</p>
        ) : filtered.length === 0 ? (
          <p className="p-6 text-gray-500">No audit records yet. They will appear here as soon as someone uses Spare Search.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-3">Date</th>
                  <th className="text-left px-4 py-3">Time</th>
                  <th className="text-left px-4 py-3">User</th>
                  <th className="text-left px-4 py-3">Customer</th>
                  <th className="text-left px-4 py-3">Search Term</th>
                  <th className="text-right px-4 py-3">Results</th>
                  <th className="text-left px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.id} className="border-t hover:bg-gray-50">
                    <td className="px-4 py-3 whitespace-nowrap">{log.dateStr}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{log.timeStr}</td>
                    <td className="px-4 py-3">{log.userEmail}</td>
                    <td className="px-4 py-3 font-medium text-gray-800">{log.customerName}</td>
                    <td className="px-4 py-3">{log.searchTerm}</td>
                    <td className="px-4 py-3 text-right">{log.resultsCount}</td>
                    <td className="px-4 py-3">
                      {log.found ? (
                        <span className="text-emerald-700 bg-emerald-50 px-2 py-1 rounded text-xs font-medium">FOUND</span>
                      ) : (
                        <span className="text-red-700 bg-red-50 px-2 py-1 rounded text-xs font-medium">NOT FOUND</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="text-xs text-gray-400 mt-3">
        Showing latest {logs.length} records (max 1000). Use Export to Excel for the full filtered list.
      </p>
    </div>
  );
}
