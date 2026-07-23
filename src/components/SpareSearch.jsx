import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { Search, UserCheck, PlusCircle, PackageSearch, AlertCircle, CheckCircle2 } from 'lucide-react';

// A random ID for this browser session, so audit records can be grouped
const SESSION_ID = Math.random().toString(36).slice(2, 10).toUpperCase();

export default function SpareSearch({ userRole, userEmail }) {
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState(null); // null = no search yet
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');

  // Add-customer form
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [newCustomerPhone, setNewCustomerPhone] = useState('');
  const [savingCustomer, setSavingCustomer] = useState(false);

  // Live customer list
  useEffect(() => {
    const q = query(collection(db, 'customers'), orderBy('name', 'asc'));
    const unsub = onSnapshot(
      q,
      (snap) => setCustomers(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => setError('Could not load customers: ' + err.message)
    );
    return unsub;
  }, []);

  // Live items list
  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(
      q,
      (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => setError('Could not load items: ' + err.message)
    );
    return unsub;
  }, []);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) || null,
    [customers, selectedCustomerId]
  );

  const handleAddCustomer = async (e) => {
    e.preventDefault();
    const name = newCustomerName.trim();
    if (!name) return;
    setSavingCustomer(true);
    try {
      const ref = await addDoc(collection(db, 'customers'), {
        name,
        phone: newCustomerPhone.trim(),
        createdBy: userEmail,
        createdAt: serverTimestamp(),
      });
      setSelectedCustomerId(ref.id);
      setNewCustomerName('');
      setNewCustomerPhone('');
      setShowAddCustomer(false);
    } catch (err) {
      setError('Could not add customer: ' + err.message);
    }
    setSavingCustomer(false);
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    setError('');

    // MANDATORY customer selection — search is blocked without it
    if (!selectedCustomer) {
      setError('Please select a customer before searching. This is mandatory.');
      return;
    }
    const term = searchTerm.trim();
    if (!term) {
      setError('Please type a spare part name to search.');
      return;
    }

    setSearching(true);
    const started = Date.now();

    const lower = term.toLowerCase();
    const matches = items.filter(
      (item) =>
        (item.particulars || '').toLowerCase().includes(lower) ||
        (item.hsnCode || '').toString().toLowerCase().includes(lower) ||
        (item.rackNo || '').toString().toLowerCase().includes(lower)
    );
    setResults(matches);

    // Write immutable audit record — every search is logged, no exceptions
    const now = new Date();
    try {
      await addDoc(collection(db, 'spareSearchAudit'), {
        createdAt: serverTimestamp(),
        dateStr: now.toLocaleDateString('en-IN'),
        timeStr: now.toLocaleTimeString('en-IN'),
        userEmail: userEmail || 'unknown',
        userRole: userRole || 'unknown',
        customerId: selectedCustomer.id,
        customerName: selectedCustomer.name,
        customerPhone: selectedCustomer.phone || '',
        searchTerm: term,
        resultsCount: matches.length,
        found: matches.length > 0,
        topResults: matches.slice(0, 5).map((m) => ({
          particulars: m.particulars || '',
          currentStock: m.currentStock ?? '',
          unit: m.unit || '',
          rackNo: m.rackNo || '',
        })),
        durationMs: Date.now() - started,
        device: navigator.userAgent,
        sessionId: SESSION_ID,
      });
    } catch (err) {
      setError('Search shown, but audit log failed: ' + err.message);
    }
    setSearching(false);
  };

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <PackageSearch className="text-emerald-700" size={28} />
          Spare Search
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Select a customer first — every search is recorded in the audit trail.
        </p>
      </div>

      {/* Step 1: Customer selection (MANDATORY) */}
      <div className="bg-white rounded-xl shadow p-5 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <UserCheck size={20} className={selectedCustomer ? 'text-emerald-600' : 'text-gray-400'} />
          <h2 className="font-semibold text-gray-700">Step 1 — Select Customer (mandatory)</h2>
          {selectedCustomer && <CheckCircle2 size={18} className="text-emerald-600" />}
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <select
            value={selectedCustomerId}
            onChange={(e) => {
              setSelectedCustomerId(e.target.value);
              setResults(null);
            }}
            className="border border-gray-300 rounded-lg px-4 py-2 min-w-[260px] focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <option value="">-- Choose a customer --</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` (${c.phone})` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowAddCustomer((v) => !v)}
            className="flex items-center gap-1 text-emerald-700 hover:text-emerald-900 text-sm font-medium"
          >
            <PlusCircle size={18} /> Add new customer
          </button>
        </div>

        {showAddCustomer && (
          <form onSubmit={handleAddCustomer} className="mt-4 flex flex-wrap gap-3 items-center bg-emerald-50 p-3 rounded-lg">
            <input
              type="text"
              placeholder="Customer name *"
              value={newCustomerName}
              onChange={(e) => setNewCustomerName(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2"
              required
            />
            <input
              type="text"
              placeholder="Phone (optional)"
              value={newCustomerPhone}
              onChange={(e) => setNewCustomerPhone(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2"
            />
            <button
              type="submit"
              disabled={savingCustomer}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
            >
              {savingCustomer ? 'Saving...' : 'Save Customer'}
            </button>
          </form>
        )}
      </div>

      {/* Step 2: Search */}
      <div className={`bg-white rounded-xl shadow p-5 mb-4 ${!selectedCustomer ? 'opacity-50' : ''}`}>
        <div className="flex items-center gap-2 mb-3">
          <Search size={20} className="text-gray-500" />
          <h2 className="font-semibold text-gray-700">Step 2 — Search Spare Part</h2>
        </div>
        <form onSubmit={handleSearch} className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder={selectedCustomer ? 'Type spare part name, HSN code or rack no...' : 'Select a customer first'}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            disabled={!selectedCustomer}
            className="border border-gray-300 rounded-lg px-4 py-2 flex-1 min-w-[240px] focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:bg-gray-100"
          />
          <button
            type="submit"
            disabled={!selectedCustomer || searching}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-2 rounded-lg font-medium disabled:opacity-50"
          >
            {searching ? 'Searching...' : 'Search'}
          </button>
        </form>
        {selectedCustomer && (
          <p className="text-xs text-gray-400 mt-2">
            Searching for customer: <span className="font-medium text-gray-600">{selectedCustomer.name}</span> — this search will be logged.
          </p>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 text-red-700 px-4 py-3 rounded-lg mb-4">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {/* Results */}
      {results !== null && (
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50 flex justify-between items-center">
            <h3 className="font-semibold text-gray-700">
              {results.length} result{results.length !== 1 ? 's' : ''} for "{searchTerm}"
            </h3>
            <span className="text-xs text-emerald-700 bg-emerald-50 px-2 py-1 rounded">✓ Logged to audit trail</span>
          </div>
          {results.length === 0 ? (
            <p className="p-6 text-gray-500">No spare parts found. This "not found" search was also recorded.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-5 py-3">Particulars</th>
                    <th className="text-left px-5 py-3">Rack No</th>
                    <th className="text-left px-5 py-3">HSN Code</th>
                    <th className="text-right px-5 py-3">Current Stock</th>
                    <th className="text-left px-5 py-3">Unit</th>
                    <th className="text-left px-5 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((item) => {
                    const stock = Number(item.currentStock) || 0;
                    const reorder = Number(item.reorderLevel) || 0;
                    return (
                      <tr key={item.id} className="border-t hover:bg-gray-50">
                        <td className="px-5 py-3 font-medium text-gray-800">{item.particulars}</td>
                        <td className="px-5 py-3">{item.rackNo || '-'}</td>
                        <td className="px-5 py-3">{item.hsnCode || '-'}</td>
                        <td className="px-5 py-3 text-right font-semibold">{stock}</td>
                        <td className="px-5 py-3">{item.unit || '-'}</td>
                        <td className="px-5 py-3">
                          {stock <= 0 ? (
                            <span className="text-red-700 bg-red-50 px-2 py-1 rounded text-xs font-medium">Out of stock</span>
                          ) : stock <= reorder ? (
                            <span className="text-amber-700 bg-amber-50 px-2 py-1 rounded text-xs font-medium">Low stock</span>
                          ) : (
                            <span className="text-emerald-700 bg-emerald-50 px-2 py-1 rounded text-xs font-medium">Available</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
