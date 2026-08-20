import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  addDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';
import { Warehouse, Plus, Pencil, Copy, X, ShieldAlert } from 'lucide-react';

function buildLocationCode({ rack, shelf, bin }) {
  return [rack, shelf, bin].filter(Boolean).join('-').toUpperCase();
}

const emptyForm = { warehouse: '', rack: '', shelf: '', bin: '', maxCapacity: '', status: 'ACTIVE' };

export default function LocationMaster({ userRole }) {
  const [locations, setLocations] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingLoc, setEditingLoc] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const canEdit = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const q = query(collection(db, 'locations'), orderBy('locationCode', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setLocations(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  if (userRole !== 'admin' && userRole !== 'inventory_manager' && userRole !== 'staff') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Location Master is not available for this role.</p>
      </div>
    );
  }

  const openAdd = () => {
    setForm(emptyForm);
    setEditingLoc(null);
    setError('');
    setShowForm(true);
  };

  const openEdit = (loc) => {
    setForm({
      warehouse: loc.warehouse || '',
      rack: loc.rack || '',
      shelf: loc.shelf || '',
      bin: loc.bin || '',
      maxCapacity: loc.maxCapacity ?? '',
      status: loc.status || 'ACTIVE',
    });
    setEditingLoc(loc);
    setError('');
    setShowForm(true);
  };

  // Clone reuses the Add form (editingLoc stays null so Save creates a new
  // location doc) pre-filled from an existing one. Bin is left blank since
  // warehouse+rack+shelf+bin together must be unique — leaving bin empty
  // forces the user to fill in something that makes the new location code
  // distinct before it will save.
  const openClone = (loc) => {
    setForm({
      warehouse: loc.warehouse || '',
      rack: loc.rack || '',
      shelf: loc.shelf || '',
      bin: '',
      maxCapacity: loc.maxCapacity ?? '',
      status: loc.status || 'ACTIVE',
    });
    setEditingLoc(null);
    setError('');
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.rack.trim()) {
      setError('Rack is required.');
      return;
    }
    const locationCode = buildLocationCode(form);
    const dupe = locations.find((l) => l.locationCode === locationCode && l.id !== editingLoc?.id);
    if (dupe) {
      setError(`Location code "${locationCode}" already exists.`);
      return;
    }
    try {
      if (editingLoc) {
        await updateDoc(doc(db, 'locations', editingLoc.id), {
          warehouse: form.warehouse.trim(),
          rack: form.rack.trim(),
          shelf: form.shelf.trim(),
          bin: form.bin.trim(),
          locationCode,
          maxCapacity: Number(form.maxCapacity) || 0,
          status: form.status,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, 'locations'), {
          warehouse: form.warehouse.trim(),
          rack: form.rack.trim(),
          shelf: form.shelf.trim(),
          bin: form.bin.trim(),
          locationCode,
          maxCapacity: Number(form.maxCapacity) || 0,
          currentOccupancy: 0,
          status: form.status,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      setShowForm(false);
      setForm(emptyForm);
      setEditingLoc(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const filtered = locations.filter((l) => {
    const s = search.trim().toLowerCase();
    if (!s) return true;
    return (
      (l.locationCode || '').toLowerCase().includes(s) ||
      (l.warehouse || '').toLowerCase().includes(s) ||
      (l.rack || '').toLowerCase().includes(s)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Warehouse className="text-emerald-700" size={28} />
          <h1 className="text-3xl font-bold text-gray-800">Location Master</h1>
        </div>
        {canEdit && (
          <button
            onClick={openAdd}
            className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg"
          >
            <Plus size={18} /> Add Location
          </button>
        )}
      </div>
      <p className="text-gray-500 text-sm max-w-2xl">
        Define every warehouse / rack / shelf / bin combination your team uses. Locations set up here appear as
        choices when completing the Put-away Location Report, and their occupancy updates automatically as stock
        is put away.
      </p>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by location code, warehouse, or rack..."
        className="w-full max-w-md px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
      />

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-lg text-gray-800">{editingLoc ? 'Edit Location' : 'Add Location'}</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-sm">{error}</div>}
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Warehouse</label>
                <input
                  value={form.warehouse}
                  onChange={(e) => setForm((f) => ({ ...f, warehouse: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="e.g. Main Warehouse"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Rack *</label>
                  <input
                    value={form.rack}
                    onChange={(e) => setForm((f) => ({ ...f, rack: e.target.value }))}
                    className="w-full px-3 py-2 border rounded-lg"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Shelf</label>
                  <input
                    value={form.shelf}
                    onChange={(e) => setForm((f) => ({ ...f, shelf: e.target.value }))}
                    className="w-full px-3 py-2 border rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bin</label>
                  <input
                    value={form.bin}
                    onChange={(e) => setForm((f) => ({ ...f, bin: e.target.value }))}
                    className="w-full px-3 py-2 border rounded-lg"
                  />
                </div>
              </div>
              <p className="text-xs text-gray-400">Location code preview: <strong>{buildLocationCode(form) || '—'}</strong></p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Maximum Capacity</label>
                <input
                  type="number"
                  value={form.maxCapacity}
                  onChange={(e) => setForm((f) => ({ ...f, maxCapacity: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                  className="w-full px-3 py-2 border rounded-lg"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
              <button
                type="submit"
                className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg"
              >
                {editingLoc ? 'Save Changes' : 'Add Location'}
              </button>
            </form>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Location Code</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Warehouse</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Rack</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Shelf</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Bin</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Occupancy / Capacity</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
              {canEdit && <th className="px-4 py-3"></th>}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 8 : 7} className="px-4 py-8 text-center text-gray-400">
                  No locations defined yet.
                </td>
              </tr>
            )}
            {filtered.map((l) => {
              const occ = Number(l.currentOccupancy || 0);
              const cap = Number(l.maxCapacity || 0);
              const over = cap > 0 && occ > cap;
              return (
                <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{l.locationCode}</td>
                  <td className="px-4 py-3">{l.warehouse}</td>
                  <td className="px-4 py-3">{l.rack}</td>
                  <td className="px-4 py-3">{l.shelf}</td>
                  <td className="px-4 py-3">{l.bin}</td>
                  <td className={`px-4 py-3 text-right ${over ? 'text-red-600 font-semibold' : ''}`}>
                    {occ} / {cap || '∞'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${
                        l.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {l.status}
                    </span>
                  </td>
                  {canEdit && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button onClick={() => openEdit(l)} className="text-gray-400 hover:text-emerald-700" title="Edit">
                          <Pencil size={16} />
                        </button>
                        <button onClick={() => openClone(l)} className="text-gray-400 hover:text-emerald-700" title="Clone">
                          <Copy size={16} />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
