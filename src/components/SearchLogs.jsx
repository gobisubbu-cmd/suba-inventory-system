import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query, limit } from 'firebase/firestore';
import { SearchCheck, ShieldAlert } from 'lucide-react';

export default function SearchLogs({ userRole }) {
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    const q = query(collection(db, 'searchLogs'), orderBy('createdAt', 'desc'), limit(200));
    const unsub = onSnapshot(q, (snap) => {
      setLogs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  if (userRole !== 'admin') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Search Logs is restricted to Admin users.</p>
      </div>
    );
  }

  const fmt = (ts) => {
    if (!ts?.toDate) return '';
    return ts.toDate().toLocaleString('en-IN');
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <SearchCheck className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Search Logs</h1>
      </div>
      <p className="text-gray-500 text-sm max-w-2xl">
        What users are searching for on the Dashboard. Rows with 0 results may point to items you don't
        stock yet, or naming mismatches worth reviewing.
      </p>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Query</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Results</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Searched By</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">When</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                  No searches logged yet.
                </td>
              </tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{l.query}</td>
                <td className={`px-4 py-3 text-right ${l.resultsCount === 0 ? 'text-red-600 font-semibold' : ''}`}>
                  {l.resultsCount}
                </td>
                <td className="px-4 py-3">{l.userEmail}</td>
                <td className="px-4 py-3 text-gray-500">{fmt(l.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
