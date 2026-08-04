import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import {
  collection, onSnapshot, addDoc, doc, runTransaction, serverTimestamp,
} from 'firebase/firestore';
import {
  ArrowLeft, Plus, Trash2, PackageMinus, PackagePlus, CheckCircle2,
} from 'lucide-react';
import { checkAndSendLowStockAlert } from '../lowStockAlert';
import MobileItemPicker from './MobileItemPicker';

const CONDITIONS = ['New', 'Used', 'Damaged'];

function blankLine() {
  return { itemId: '', qty: '' };
}

// Mobile-first Issue / Return for engineers heading out to (or coming back
// from) a service call — same underlying ledger writes as the desktop
// Engineer Issue & Return screen, condensed to one thumb-friendly flow.
export default function MobileEngineerIssue({ userEmail, onExit }) {
  const [tab, setTab] = useState('issue'); // 'issue' | 'return'
  const [items, setItems] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return unsub;
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 pb-10">
      <div className="sticky top-0 z-10 bg-emerald-700 text-white px-4 py-3 shadow">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={onExit} className="p-1 -ml-1"><ArrowLeft size={22} /></button>
          <div>
            <h1 className="font-bold text-lg leading-tight">Engineer Issue / Return</h1>
            <p className="text-xs text-emerald-100">Spare parts for a service call</p>
          </div>
        </div>
        <div className="flex gap-2 bg-emerald-800/50 rounded-lg p-1">
          <button
            onClick={() => setTab('issue')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium ${tab === 'issue' ? 'bg-white text-emerald-700' : 'text-emerald-100'}`}
          >
            <PackageMinus size={16} /> Issue
          </button>
          <button
            onClick={() => setTab('return')}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-sm font-medium ${tab === 'return' ? 'bg-white text-emerald-700' : 'text-emerald-100'}`}
          >
            <PackagePlus size={16} /> Return
          </button>
        </div>
      </div>

      {tab === 'issue' ? (
        <MobileIssueForm items={items} userEmail={userEmail} />
      ) : (
        <MobileReturnForm items={items} userEmail={userEmail} />
      )}
    </div>
  );
}

function MobileIssueForm({ items, userEmail }) {
  const [serviceJobNo, setServiceJobNo] = useState('');
  const [engineerName, setEngineerName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([blankLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const updateLine = (idx, field, value) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const addLine = () => setLines((prev) => [...prev, blankLine()]);

  const handleSubmit = async () => {
    setError('');
    setSuccess('');
    if (!serviceJobNo.trim() || !engineerName.trim()) {
      setError('Service Job Number and Engineer Name are required.');
      return;
    }
    const valid = lines.filter((l) => l.itemId && Number(l.qty) > 0);
    if (valid.length === 0) {
      setError('Add at least one spare part with a quantity.');
      return;
    }
    setBusy(true);
    try {
      const lineRecords = [];
      for (const l of valid) {
        const qty = Number(l.qty);
        await runTransaction(db, async (tx) => {
          const itemRef = doc(db, 'items', l.itemId);
          const snap = await tx.get(itemRef);
          if (!snap.exists()) throw new Error('Item no longer exists.');
          const current = Number(snap.data().currentStock || 0);
          if (current - qty < 0) throw new Error(`${snap.data().particulars}: only ${current} in stock.`);
          tx.update(itemRef, { currentStock: current - qty, updatedAt: serverTimestamp() });

          const txnRef = doc(collection(db, 'transactions'));
          tx.set(txnRef, {
            itemId: l.itemId,
            itemName: snap.data().particulars,
            brand: snap.data().brand || '',
            type: 'engineerIssue',
            direction: 'out',
            quantity: qty,
            balanceAfter: current - qty,
            reason: `Issued to ${engineerName} for job ${serviceJobNo}`,
            engineer: engineerName,
            serviceJobNo,
            performedByEmail: userEmail || '',
            transactionDate: date,
            recordedVia: 'mobile-engineer-issue',
            createdAt: serverTimestamp(),
          });
          lineRecords.push({
            itemId: l.itemId,
            partNumber: snap.data().partNumber || snap.data().partCode || '',
            description: snap.data().particulars,
            qtyIssued: qty,
          });
        });
        await checkAndSendLowStockAlert(l.itemId);
      }
      await addDoc(collection(db, 'engineerIssues'), {
        serviceJobNo: serviceJobNo.trim(),
        engineerName: engineerName.trim(),
        customerName: customerName.trim(),
        date,
        items: lineRecords,
        createdByEmail: userEmail || '',
        createdAt: serverTimestamp(),
      });
      setSuccess(`Issued ${valid.length} part(s) to ${engineerName} for job ${serviceJobNo}.`);
      setServiceJobNo('');
      setEngineerName('');
      setCustomerName('');
      setLines([blankLine()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4 pb-28">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" /> {success}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow p-4 space-y-3">
        <Field label="Service Job Number *">
          <input value={serviceJobNo} onChange={(e) => setServiceJobNo(e.target.value)} className="w-full px-3 py-2.5 border rounded-lg text-base" />
        </Field>
        <Field label="Engineer Name *">
          <input value={engineerName} onChange={(e) => setEngineerName(e.target.value)} className="w-full px-3 py-2.5 border rounded-lg text-base" />
        </Field>
        <Field label="Customer Name">
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="w-full px-3 py-2.5 border rounded-lg text-base" />
        </Field>
        <Field label="Date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-3 py-2.5 border rounded-lg text-base" />
        </Field>
      </div>

      <div className="space-y-3">
        {lines.map((l, idx) => {
          const item = items.find((it) => it.id === l.itemId);
          return (
            <div key={idx} className="bg-white rounded-2xl shadow p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase">Part {idx + 1}</span>
                {lines.length > 1 && (
                  <button onClick={() => removeLine(idx)} className="text-red-400 active:text-red-600"><Trash2 size={18} /></button>
                )}
              </div>
              <MobileItemPicker items={items} value={l.itemId} onChange={(id) => updateLine(idx, 'itemId', id)} />
              <input
                type="number"
                placeholder="Quantity to issue"
                value={l.qty}
                onChange={(e) => updateLine(idx, 'qty', e.target.value)}
                className="w-full px-3 py-2.5 border rounded-lg text-base"
              />
              {item && Number(l.qty) > Number(item.currentStock) && (
                <p className="text-xs text-red-600">Only {item.currentStock} in stock</p>
              )}
            </div>
          );
        })}
        <button onClick={addLine} className="w-full flex items-center justify-center gap-2 text-emerald-700 font-medium py-3 border-2 border-dashed border-emerald-200 rounded-xl">
          <Plus size={16} /> Add another part
        </button>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t p-4 shadow-lg">
        <button
          onClick={handleSubmit}
          disabled={busy}
          className="w-full bg-emerald-700 active:bg-emerald-800 text-white font-bold py-4 rounded-xl text-lg disabled:opacity-50"
        >
          {busy ? 'Issuing...' : 'Issue Spare Parts'}
        </button>
      </div>
    </div>
  );
}

function MobileReturnForm({ items, userEmail }) {
  const [serviceJobNo, setServiceJobNo] = useState('');
  const [engineerName, setEngineerName] = useState('');
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([{ ...blankLine(), condition: 'New' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const updateLine = (idx, field, value) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const addLine = () => setLines((prev) => [...prev, { ...blankLine(), condition: 'New' }]);

  const handleSubmit = async () => {
    setError('');
    setSuccess('');
    if (!serviceJobNo.trim() || !engineerName.trim()) {
      setError('Service Job Number and Engineer Name are required.');
      return;
    }
    const valid = lines.filter((l) => l.itemId && Number(l.qty) > 0);
    if (valid.length === 0) {
      setError('Add at least one returned spare part with a quantity.');
      return;
    }
    setBusy(true);
    try {
      const lineRecords = [];
      for (const l of valid) {
        const qty = Number(l.qty);
        const addBackToStock = l.condition !== 'Damaged';
        await runTransaction(db, async (tx) => {
          const itemRef = doc(db, 'items', l.itemId);
          const snap = await tx.get(itemRef);
          if (!snap.exists()) throw new Error('Item no longer exists.');
          const current = Number(snap.data().currentStock || 0);
          const newStock = addBackToStock ? current + qty : current;
          tx.update(itemRef, { currentStock: newStock, updatedAt: serverTimestamp() });

          const txnRef = doc(collection(db, 'transactions'));
          tx.set(txnRef, {
            itemId: l.itemId,
            itemName: snap.data().particulars,
            brand: snap.data().brand || '',
            type: 'engineerReturn',
            direction: addBackToStock ? 'in' : 'none',
            quantity: qty,
            balanceAfter: newStock,
            reason: `Returned by ${engineerName} for job ${serviceJobNo} (${l.condition})${addBackToStock ? '' : ' — not added back to sellable stock'}`,
            engineer: engineerName,
            serviceJobNo,
            performedByEmail: userEmail || '',
            transactionDate: returnDate,
            recordedVia: 'mobile-engineer-return',
            createdAt: serverTimestamp(),
          });
          lineRecords.push({
            itemId: l.itemId,
            partNumber: snap.data().partNumber || snap.data().partCode || '',
            qtyReturned: qty,
            condition: l.condition,
          });
        });
      }
      await addDoc(collection(db, 'engineerReturns'), {
        serviceJobNo: serviceJobNo.trim(),
        engineerName: engineerName.trim(),
        returnDate,
        items: lineRecords,
        createdByEmail: userEmail || '',
        createdAt: serverTimestamp(),
      });
      setSuccess(`Recorded return of ${valid.length} part(s) from ${engineerName} for job ${serviceJobNo}.`);
      setServiceJobNo('');
      setEngineerName('');
      setLines([{ ...blankLine(), condition: 'New' }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-4 pb-28">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>}
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0" /> {success}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow p-4 space-y-3">
        <Field label="Service Job Number *">
          <input value={serviceJobNo} onChange={(e) => setServiceJobNo(e.target.value)} className="w-full px-3 py-2.5 border rounded-lg text-base" />
        </Field>
        <Field label="Engineer Name *">
          <input value={engineerName} onChange={(e) => setEngineerName(e.target.value)} className="w-full px-3 py-2.5 border rounded-lg text-base" />
        </Field>
        <Field label="Return Date">
          <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} className="w-full px-3 py-2.5 border rounded-lg text-base" />
        </Field>
      </div>

      <div className="space-y-3">
        {lines.map((l, idx) => (
          <div key={idx} className="bg-white rounded-2xl shadow p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400 uppercase">Part {idx + 1}</span>
              {lines.length > 1 && (
                <button onClick={() => removeLine(idx)} className="text-red-400 active:text-red-600"><Trash2 size={18} /></button>
              )}
            </div>
            <MobileItemPicker items={items} value={l.itemId} onChange={(id) => updateLine(idx, 'itemId', id)} />
            <input
              type="number"
              placeholder="Quantity returned"
              value={l.qty}
              onChange={(e) => updateLine(idx, 'qty', e.target.value)}
              className="w-full px-3 py-2.5 border rounded-lg text-base"
            />
            <div className="grid grid-cols-3 gap-2">
              {CONDITIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => updateLine(idx, 'condition', c)}
                  className={`py-2 rounded-lg text-sm font-medium border ${l.condition === c ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-gray-50 text-gray-600 border-gray-200'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button onClick={addLine} className="w-full flex items-center justify-center gap-2 text-emerald-700 font-medium py-3 border-2 border-dashed border-emerald-200 rounded-xl">
          <Plus size={16} /> Add another part
        </button>
        <p className="text-xs text-gray-400 px-1">Damaged returns are logged but not added back to sellable stock.</p>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white border-t p-4 shadow-lg">
        <button
          onClick={handleSubmit}
          disabled={busy}
          className="w-full bg-emerald-700 active:bg-emerald-800 text-white font-bold py-4 rounded-xl text-lg disabled:opacity-50"
        >
          {busy ? 'Recording...' : 'Record Return'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">{label}</label>
      {children}
    </div>
  );
}
