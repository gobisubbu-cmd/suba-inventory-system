import React, { useState, useEffect, useMemo } from 'react';
import { db, auth } from '../firebase';
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  addDoc,
  updateDoc,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { Boxes, Plus, Pencil, Copy, ArrowLeftRight, X, Search } from 'lucide-react';
import { checkAndSendLowStockAlert } from '../lowStockAlert';
import { createPutawayLine } from '../putaway';
import { fetchBrands, ensureSeedBrands, computeStockStatus, STOCK_STATUS_STYLES, matchesSearch } from '../lib/brands';

const MOVEMENT_TYPES = [
  { id: 'purchase', label: 'Purchase (In)', direction: 'in' },
  { id: 'return', label: 'Return (In)', direction: 'in' },
  { id: 'issue', label: 'Issue (Out)', direction: 'out' },
  { id: 'dc', label: 'Delivery Challan (Out)', direction: 'out' },
];

const PAGE_SIZE = 100;

const BLANK_FORM = {
  brand: '',
  particulars: '',
  description: '',
  partNumber: '',
  oldPartNumbers: '',
  machineModels: '',
  category: '',
  unit: '',
  supplier: '',
  purchaseCost: '',
  sellingPrice: '',
  rackNo: '',
  minStock: '',
  maxStock: '',
  reorderLevel: '',
  hsnCode: '',
  avgCost: '',
  openingStock: '',
  masterOnly: false,
  remarks: '',
};

export default function ManageItems({ userRole }) {
  const [items, setItems] = useState([]);
  const [brands, setBrands] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [movementItem, setMovementItem] = useState(null);
  const [error, setError] = useState('');
  const [brandFilter, setBrandFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const [form, setForm] = useState(BLANK_FORM);

  useEffect(() => {
    const q = query(collection(db, 'items'), orderBy('sno', 'asc'));
    const unsub = onSnapshot(q, (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  useEffect(() => {
    ensureSeedBrands(auth.currentUser?.email).then(() =>
      fetchBrands().then(setBrands)
    );
  }, []);

  const refreshBrands = () => fetchBrands().then(setBrands);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (brandFilter !== 'All' && (it.brand || 'Unassigned') !== brandFilter) return false;
      if (statusFilter !== 'All' && computeStockStatus(it) !== statusFilter) return false;
      if (search && !matchesSearch(it, search)) return false;
      return true;
    });
  }, [items, brandFilter, statusFilter, search]);

  useEffect(() => setPage(0), [brandFilter, statusFilter, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const resetForm = () => {
    setForm(BLANK_FORM);
    setEditingItem(null);
    setError('');
  };

  const openAdd = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (item) => {
    setEditingItem(item);
    setForm({
      brand: item.brand || '',
      particulars: item.particulars || '',
      description: item.description || '',
      partNumber: item.partNumber || item.partCode || '',
      oldPartNumbers: (item.oldPartNumbers || []).join(', '),
      machineModels: item.machineModels || '',
      category: item.category || '',
      unit: item.unit || '',
      supplier: item.supplier || '',
      purchaseCost: item.purchaseCost ?? '',
      sellingPrice: item.sellingPrice ?? '',
      rackNo: item.rackNo || '',
      minStock: item.minStock ?? '',
      maxStock: item.maxStock ?? '',
      reorderLevel: item.reorderLevel ?? '',
      hsnCode: item.hsnCode || '',
      avgCost: item.avgCost ?? '',
      openingStock: '',
      masterOnly: Boolean(item.masterOnly),
      remarks: item.remarks || '',
    });
    setError('');
    setShowForm(true);
  };

  // Clone reuses the Add form (editingItem stays null so Save creates a new
  // document) but pre-fills every field from the source item. Stock-specific
  // fields — current stock, S.No — are intentionally NOT carried over since
  // those belong to this one physical item, not the new one being created.
  // The name gets a "(Copy)" suffix so it doesn't immediately collide with
  // the duplicate-name check; the user is expected to adjust it before saving.
  const openClone = (item) => {
    setEditingItem(null);
    setForm({
      brand: item.brand || '',
      particulars: item.particulars ? `${item.particulars} (Copy)` : '',
      description: item.description || '',
      partNumber: '',
      oldPartNumbers: '',
      machineModels: item.machineModels || '',
      category: item.category || '',
      unit: item.unit || '',
      supplier: item.supplier || '',
      purchaseCost: item.purchaseCost ?? '',
      sellingPrice: item.sellingPrice ?? '',
      rackNo: item.rackNo || '',
      minStock: item.minStock ?? '',
      maxStock: item.maxStock ?? '',
      reorderLevel: item.reorderLevel ?? '',
      hsnCode: item.hsnCode || '',
      avgCost: item.avgCost ?? '',
      openingStock: '',
      masterOnly: Boolean(item.masterOnly),
      remarks: item.remarks || '',
    });
    setError('');
    setShowForm(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setError('');
    const name = form.particulars.trim();
    const brand = form.brand.trim();
    if (!name) {
      setError('Part Name / Particulars is required.');
      return;
    }
    if (!brand) {
      setError('Brand is required. Every spare part must belong to one brand.');
      return;
    }
    const duplicate = items.some(
      (it) => it.particulars?.trim().toLowerCase() === name.toLowerCase() && it.brand === brand && it.id !== editingItem?.id
    );
    if (duplicate) {
      setError('An item with this name already exists for this brand.');
      return;
    }

    const oldPartNumbers = form.oldPartNumbers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      if (editingItem) {
        await updateDoc(doc(db, 'items', editingItem.id), {
          brand,
          particulars: name,
          description: form.description.trim(),
          partNumber: form.partNumber.trim(),
          partCode: form.partNumber.trim(), // kept in sync for backward compatibility
          oldPartNumbers,
          machineModels: form.machineModels.trim(),
          category: form.category.trim(),
          unit: form.unit.trim(),
          supplier: form.supplier.trim(),
          purchaseCost: Number(form.purchaseCost) || 0,
          sellingPrice: Number(form.sellingPrice) || 0,
          rackNo: form.rackNo.trim(),
          minStock: Number(form.minStock) || 0,
          maxStock: Number(form.maxStock) || 0,
          reorderLevel: Number(form.reorderLevel) || 0,
          hsnCode: form.hsnCode.trim(),
          avgCost: Number(form.avgCost) || 0,
          masterOnly: form.masterOnly,
          remarks: form.remarks.trim(),
          updatedAt: serverTimestamp(),
        });
      } else {
        const nextSno = items.length ? Math.max(...items.map((it) => Number(it.sno) || 0)) + 1 : 1;
        const opening = form.masterOnly ? 0 : Number(form.openingStock) || 0;
        const newItemRef = await addDoc(collection(db, 'items'), {
          sno: nextSno,
          brand,
          particulars: name,
          description: form.description.trim(),
          partNumber: form.partNumber.trim(),
          partCode: form.partNumber.trim(),
          oldPartNumbers,
          machineModels: form.machineModels.trim(),
          category: form.category.trim(),
          unit: form.unit.trim(),
          supplier: form.supplier.trim(),
          purchaseCost: Number(form.purchaseCost) || 0,
          sellingPrice: Number(form.sellingPrice) || 0,
          rackNo: form.rackNo.trim(),
          minStock: Number(form.minStock) || 0,
          maxStock: Number(form.maxStock) || 0,
          reorderLevel: Number(form.reorderLevel) || 0,
          hsnCode: form.hsnCode.trim(),
          avgCost: Number(form.avgCost) || 0,
          currentStock: opening,
          masterOnly: form.masterOnly,
          remarks: form.remarks.trim(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        if (opening > 0) {
          await addDoc(collection(db, 'transactions'), {
            itemId: newItemRef.id,
            itemName: name,
            brand,
            type: 'opening',
            direction: 'in',
            quantity: opening,
            reason: 'Opening stock',
            performedByEmail: auth.currentUser?.email || '',
            createdAt: serverTimestamp(),
          });
        }
        if (!form.masterOnly) checkAndSendLowStockAlert(newItemRef.id);
      }
      setShowForm(false);
      resetForm();
    } catch (err) {
      setError(err.message);
    }
  };

  const canEdit = userRole === 'admin' || userRole === 'inventory_manager';
  const brandNames = brands.map((b) => b.name);
  const filterBrandOptions = ['All', ...Array.from(new Set(items.map((it) => it.brand).filter(Boolean))).sort()];
  const statusOptions = ['All', 'In Stock', 'Low Stock', 'Out of Stock', 'Not Stocked'];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Boxes className="text-emerald-700" size={28} />
          <h1 className="text-3xl font-bold text-gray-800">Manage Items</h1>
        </div>
        {canEdit && (
          <button
            onClick={openAdd}
            className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg"
          >
            <Plus size={18} /> Add New Item
          </button>
        )}
      </div>

      <div className="bg-white rounded-lg shadow p-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[220px]">
          <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Part number (old or new), name, model, category, supplier..."
              className="w-full pl-9 pr-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Brand</label>
          <select value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
            {filterBrandOptions.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Stock Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
            {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="text-sm text-gray-500 pb-2">{filtered.length} of {items.length} items</div>
      </div>

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Brand</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Part Number</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Particulars</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Category</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Unit</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Storage Location</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Current Stock</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Reorder Level</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
              {canEdit && <th className="text-left px-4 py-3 font-semibold text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {pageItems.map((it) => {
              const status = computeStockStatus(it);
              return (
              <tr key={it.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className="inline-block bg-emerald-50 text-emerald-800 text-xs font-semibold px-2 py-1 rounded">
                    {it.brand || 'Unassigned'}
                  </span>
                </td>
                <td className="px-4 py-3 font-semibold text-emerald-700">
                  {it.partNumber || it.partCode || '-'}
                  {it.oldPartNumbers?.length > 0 && (
                    <div className="text-xs text-gray-400 font-normal">was: {it.oldPartNumbers.join(', ')}</div>
                  )}
                </td>
                <td className="px-4 py-3 font-medium text-gray-800">{it.particulars}</td>
                <td className="px-4 py-3 text-gray-500">{it.category || '-'}</td>
                <td className="px-4 py-3">{it.unit}</td>
                <td className="px-4 py-3">{it.rackNo}</td>
                <td className="px-4 py-3 text-right">{it.currentStock}</td>
                <td className="px-4 py-3 text-right">{it.reorderLevel}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block text-xs font-semibold px-2 py-1 rounded border ${STOCK_STATUS_STYLES[status]}`}>
                    {status}
                  </span>
                </td>
                {canEdit && (
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(it)} className="text-gray-500 hover:text-emerald-700" title="Edit">
                        <Pencil size={16} />
                      </button>
                      <button onClick={() => openClone(it)} className="text-gray-500 hover:text-emerald-700" title="Clone">
                        <Copy size={16} />
                      </button>
                      <button
                        onClick={() => setMovementItem(it)}
                        className="text-gray-500 hover:text-emerald-700"
                        title="Record Movement"
                      >
                        <ArrowLeftRight size={16} />
                      </button>
                    </div>
                  </td>
                )}
              </tr>
              );
            })}
            {pageItems.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  No items match these filters.
                </td>
              </tr>
            )}
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

      {showForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 my-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-gray-800">{editingItem ? 'Edit Item' : 'Add New Item'}</h2>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600">
                <X size={20} />
              </button>
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-4 text-sm">
                {error}
              </div>
            )}
            <form onSubmit={handleSave} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Brand *</label>
                  <input
                    list="brand-options"
                    value={form.brand}
                    onChange={(e) => setForm({ ...form, brand: e.target.value.toUpperCase() })}
                    onBlur={refreshBrands}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    placeholder="SINMAG, RATIONAL, JIPA, or type a new brand"
                    required
                  />
                  <datalist id="brand-options">
                    {brandNames.map((b) => <option key={b} value={b} />)}
                  </datalist>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Part Name / Particulars *</label>
                  <input
                    type="text"
                    value={form.particulars}
                    onChange={(e) => setForm({ ...form, particulars: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    required
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  rows={2}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Part Number (current / new)</label>
                  <input
                    type="text"
                    value={form.partNumber}
                    onChange={(e) => setForm({ ...form, partNumber: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    placeholder="e.g., 70.01.530S"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Old Part Number(s)</label>
                  <input
                    type="text"
                    value={form.oldPartNumbers}
                    onChange={(e) => setForm({ ...form, oldPartNumbers: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    placeholder="comma-separated if more than one"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Machine Model(s)</label>
                  <input
                    type="text"
                    value={form.machineModels}
                    onChange={(e) => setForm({ ...form, machineModels: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    placeholder="comma-separated"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <input
                    type="text"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                  <input
                    type="text"
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                    placeholder="pcs, kg, box..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Storage Location</label>
                  <input
                    type="text"
                    value={form.rackNo}
                    onChange={(e) => setForm({ ...form, rackNo: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
                  <input
                    type="text"
                    value={form.supplier}
                    onChange={(e) => setForm({ ...form, supplier: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Min Stock</label>
                  <input type="number" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max Stock</label>
                  <input type="number" value={form.maxStock} onChange={(e) => setForm({ ...form, maxStock: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reorder Level</label>
                  <input type="number" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">HSN Code</label>
                  <input type="text" value={form.hsnCode} onChange={(e) => setForm({ ...form, hsnCode: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Standard Purchase Cost (₹)</label>
                  <input type="number" step="0.01" value={form.purchaseCost} onChange={(e) => setForm({ ...form, purchaseCost: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Standard Selling Price (₹)</label>
                  <input type="number" step="0.01" value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Avg Cost (₹, actuals)</label>
                  <input type="number" step="0.01" value={form.avgCost} onChange={(e) => setForm({ ...form, avgCost: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
                </div>
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.masterOnly}
                    onChange={(e) => setForm({ ...form, masterOnly: e.target.checked })}
                  />
                  Master catalogue entry only (not currently stocked — Current Stock stays 0, Status shows "Not Stocked")
                </label>
              </div>
              {!editingItem && !form.masterOnly && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Opening Stock</label>
                  <input
                    type="number"
                    value={form.openingStock}
                    onChange={(e) => setForm({ ...form, openingStock: e.target.value })}
                    className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Remarks</label>
                <input type="text" value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
              </div>
              <button
                type="submit"
                className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg mt-2"
              >
                {editingItem ? 'Save Changes' : 'Add Item'}
              </button>
            </form>
          </div>
        </div>
      )}

      {movementItem && (
        <MovementModal item={movementItem} onClose={() => setMovementItem(null)} />
      )}
    </div>
  );
}

function MovementModal({ item, onClose }) {
  const [type, setType] = useState('purchase');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const [supplier, setSupplier] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isReceiving = type === 'purchase' || type === 'return';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      setError('Enter a valid quantity greater than 0.');
      return;
    }
    const movement = MOVEMENT_TYPES.find((m) => m.id === type);
    setSaving(true);
    try {
      let committedItemName = item.particulars;
      let committedItemCode = item.sno;
      let committedTxnId = '';
      await runTransaction(db, async (tx) => {
        const itemRef = doc(db, 'items', item.id);
        const itemSnap = await tx.get(itemRef);
        if (!itemSnap.exists()) throw new Error('Item no longer exists.');
        const current = Number(itemSnap.data().currentStock || 0);
        const delta = movement.direction === 'in' ? qty : -qty;
        const newStock = current + delta;
        if (newStock < 0) throw new Error('This would make stock negative. Check the quantity.');

        const updates = { currentStock: newStock, updatedAt: serverTimestamp(), masterOnly: false };
        if (movement.id === 'purchase' && unitCost) {
          updates.avgCost = Number(unitCost);
        }
        tx.update(itemRef, updates);

        const txnRef = doc(collection(db, 'transactions'));
        tx.set(txnRef, {
          itemId: item.id,
          itemName: item.particulars,
          brand: itemSnap.data().brand || '',
          type: movement.id,
          direction: movement.direction,
          quantity: qty,
          unitCost: unitCost ? Number(unitCost) : null,
          reason: reason.trim(),
          performedByEmail: auth.currentUser?.email || '',
          createdAt: serverTimestamp(),
        });
        committedItemName = itemSnap.data().particulars;
        committedItemCode = itemSnap.data().sno;
        committedTxnId = txnRef.id;
      });
      await checkAndSendLowStockAlert(item.id);
      if (isReceiving) {
        await createPutawayLine({
          itemId: item.id,
          itemName: committedItemName,
          itemCode: committedItemCode,
          quantity: qty,
          invoiceNumber: reason.trim() || 'N/A',
          invoiceDate: new Date().toISOString().slice(0, 10),
          supplier: supplier.trim(),
          transactionId: committedTxnId,
          userEmail: auth.currentUser?.email || '',
        });
      }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">Record Movement — {item.particulars}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-4">Current stock: {item.currentStock} {item.unit}</p>
        {isReceiving && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded mb-4 text-xs">
            This will be recorded as <strong>LOCATION PENDING</strong> in Warehouse Put-away until a location is assigned.
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded mb-4 text-sm">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Movement Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
            >
              {MOVEMENT_TYPES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Quantity</label>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              required
            />
          </div>
          {type === 'purchase' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Unit Cost (₹, optional — updates Avg Cost)</label>
              <input
                type="number"
                step="0.01"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              />
            </div>
          )}
          {isReceiving && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Supplier</label>
              <input
                type="text"
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
                placeholder="Supplier name"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reason / Reference</label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg focus:outline-none focus:border-emerald-600"
              placeholder="Invoice no., customer, notes..."
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="w-full bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Record Movement'}
          </button>
        </form>
      </div>
    </div>
  );
}
