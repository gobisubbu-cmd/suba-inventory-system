import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
  collection,
  onSnapshot,
  query,
  orderBy,
  doc,
  addDoc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { HardHat, Plus, Trash2, PackageMinus, PackagePlus, Wrench, ClipboardList } from 'lucide-react';
import { checkAndSendLowStockAlert } from '../lowStockAlert';
import { logActivity } from '../lib/activityLog';
import MobileItemPicker from './MobileItemPicker';

const CONDITIONS = ['New', 'Used', 'Damaged'];
const WARRANTY_OPTIONS = ['Warranty', 'Chargeable'];

function blankLine() {
  return { itemId: '', qty: '' };
}

export default function EngineerIssueReturn({ userRole, userEmail }) {
  const [tab, setTab] = useState('issue'); // issue | return | used | register
  const [items, setItems] = useState([]);
  const [issues, setIssues] = useState([]);
  const [returns, setReturns] = useState([]);
  const [used, setUsed] = useState([]);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
    return unsub;
  }, []);
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, 'engineerIssues'), orderBy('createdAt', 'desc')), (snap) =>
      setIssues(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return unsub;
  }, []);
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, 'engineerReturns'), orderBy('createdAt', 'desc')), (snap) =>
      setReturns(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return unsub;
  }, []);
  useEffect(() => {
    const unsub = onSnapshot(query(collection(db, 'sparePartsUsed'), orderBy('createdAt', 'desc')), (snap) =>
      setUsed(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
    );
    return unsub;
  }, []);

  const canEdit = userRole === 'admin' || userRole === 'inventory_manager' || userRole === 'staff';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <HardHat className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Engineer Spare Parts Issue &amp; Return</h1>
      </div>
      <p className="text-sm text-gray-500 max-w-3xl">
        Track spare parts engineers carry for service calls. Issuing deducts store stock immediately. Returning
        unused parts adds them back. Recording what was actually used at site is for consumption reporting only —
        it does not move stock again, since that stock already left the store at Issue time.
      </p>

      <div className="flex gap-2 bg-gray-100 rounded-lg p-1 w-fit flex-wrap">
        {[
          { id: 'issue', label: 'Issue to Engineer', icon: PackageMinus },
          { id: 'return', label: 'Return from Engineer', icon: PackagePlus },
          { id: 'used', label: 'Spare Parts Used', icon: Wrench },
          { id: 'register', label: 'Engineer Register', icon: ClipboardList },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.id ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'issue' && <IssueForm items={items} userEmail={userEmail} disabled={!canEdit} />}
      {tab === 'return' && <ReturnForm items={items} issues={issues} userEmail={userEmail} disabled={!canEdit} />}
      {tab === 'used' && <UsedForm items={items} userEmail={userEmail} disabled={!canEdit} />}
      {tab === 'register' && <EngineerRegister issues={issues} returns={returns} used={used} />}
    </div>
  );
}

function LineItemsEditor({ lines, setLines, items, qtyLabel = 'Qty' }) {
  const update = (idx, field, value) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  const remove = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const add = () => setLines((prev) => [...prev, blankLine()]);
  const sorted = useMemo(() => [...items].sort((a, b) => (a.particulars || '').localeCompare(b.particulars || '')), [items]);

  return (
    <div className="space-y-2">
      {lines.map((l, idx) => {
        const item = items.find((it) => it.id === l.itemId);
        return (
          <div key={idx} className="flex items-center gap-2">
            <div className="flex-1">
              <MobileItemPicker
                items={sorted}
                value={l.itemId}
                onChange={(id) => update(idx, 'itemId', id)}
                placeholder="Select spare part..."
              />
            </div>
            <input
              type="number"
              placeholder={qtyLabel}
              value={l.qty}
              onChange={(e) => update(idx, 'qty', e.target.value)}
              className="w-28 px-3 py-2 border rounded-lg"
            />
            {item && Number(l.qty) > Number(item.currentStock) && qtyLabel === 'Qty Issued' && (
              <span className="text-xs text-red-600">only {item.currentStock} in stock</span>
            )}
            <button type="button" onClick={() => remove(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
          </div>
        );
      })}
      <button type="button" onClick={add} className="flex items-center gap-1 text-emerald-700 text-sm font-medium">
        <Plus size={14} /> Add line
      </button>
    </div>
  );
}

function IssueForm({ items, userEmail, disabled }) {
  const [serviceJobNo, setServiceJobNo] = useState('');
  const [engineerName, setEngineerName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([blankLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
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
            // Effective date of the movement, as entered on the form — kept
            // separate from createdAt (system upload time) per the
            // date-based stock rule: reports must key off when it actually
            // happened, not when it was typed in.
            transactionDate: date,
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
      logActivity(userEmail, 'Engineer issue (outward)', `${valid.length} part(s) to ${engineerName} · job ${serviceJobNo}`);
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
    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4 max-w-3xl">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded text-sm">{success}</div>}
      <div className="grid sm:grid-cols-2 gap-4">
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Service Job Number *</label>
          <input value={serviceJobNo} onChange={(e) => setServiceJobNo(e.target.value)} className="w-full px-3 py-2 border rounded-lg" required /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Engineer Name *</label>
          <input value={engineerName} onChange={(e) => setEngineerName(e.target.value)} className="w-full px-3 py-2 border rounded-lg" required /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="w-full px-3 py-2 border rounded-lg" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full px-3 py-2 border rounded-lg" /></div>
      </div>
      <div><label className="block text-sm font-medium text-gray-700 mb-2">Spare Parts to Issue</label>
        <LineItemsEditor lines={lines} setLines={setLines} items={items} qtyLabel="Qty Issued" /></div>
      <button type="submit" disabled={disabled || busy} className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50">
        {busy ? 'Issuing...' : 'Issue Spare Parts'}
      </button>
    </form>
  );
}

function ReturnForm({ items, issues, userEmail, disabled }) {
  const [serviceJobNo, setServiceJobNo] = useState('');
  const [engineerName, setEngineerName] = useState('');
  const [returnDate, setReturnDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([{ ...blankLine(), condition: 'New' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const jobOptions = useMemo(() => Array.from(new Set(issues.map((i) => i.serviceJobNo))).sort(), [issues]);

  const updateLine = (idx, field, value) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const addLine = () => setLines((prev) => [...prev, { ...blankLine(), condition: 'New' }]);
  const sortedItems = useMemo(() => [...items].sort((a, b) => (a.particulars || '').localeCompare(b.particulars || '')), [items]);

  const handleSubmit = async (e) => {
    e.preventDefault();
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
      logActivity(userEmail, 'Engineer return (inward)', `${valid.length} part(s) from ${engineerName} · job ${serviceJobNo}`);
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
    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4 max-w-3xl">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded text-sm">{success}</div>}
      <div className="grid sm:grid-cols-2 gap-4">
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Service Job Number *</label>
          <input list="job-options" value={serviceJobNo} onChange={(e) => setServiceJobNo(e.target.value)} className="w-full px-3 py-2 border rounded-lg" required />
          <datalist id="job-options">{jobOptions.map((j) => <option key={j} value={j} />)}</datalist>
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Engineer Name *</label>
          <input value={engineerName} onChange={(e) => setEngineerName(e.target.value)} className="w-full px-3 py-2 border rounded-lg" required /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Return Date</label>
          <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} className="w-full px-3 py-2 border rounded-lg" /></div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Spare Parts Returned</label>
        <div className="space-y-2">
          {lines.map((l, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <div className="flex-1">
                <MobileItemPicker
                  items={sortedItems}
                  value={l.itemId}
                  onChange={(id) => updateLine(idx, 'itemId', id)}
                  placeholder="Select spare part..."
                />
              </div>
              <input type="number" placeholder="Qty Returned" value={l.qty} onChange={(e) => updateLine(idx, 'qty', e.target.value)} className="w-32 px-3 py-2 border rounded-lg" />
              <select value={l.condition} onChange={(e) => updateLine(idx, 'condition', e.target.value)} className="w-32 px-3 py-2 border rounded-lg">
                {CONDITIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button type="button" onClick={() => removeLine(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
            </div>
          ))}
          <button type="button" onClick={addLine} className="flex items-center gap-1 text-emerald-700 text-sm font-medium"><Plus size={14} /> Add line</button>
        </div>
        <p className="text-xs text-gray-400 mt-1">Damaged returns are logged but not added back to sellable stock.</p>
      </div>
      <button type="submit" disabled={disabled || busy} className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50">
        {busy ? 'Recording...' : 'Record Return'}
      </button>
    </form>
  );
}

function UsedForm({ items, userEmail, disabled }) {
  const [serviceJobNo, setServiceJobNo] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [machineModel, setMachineModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [serviceDate, setServiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState([{ ...blankLine(), warrantyOrChargeable: 'Chargeable', remarks: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const sortedItems = useMemo(() => [...items].sort((a, b) => (a.particulars || '').localeCompare(b.particulars || '')), [items]);

  const updateLine = (idx, field, value) => setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const addLine = () => setLines((prev) => [...prev, { ...blankLine(), warrantyOrChargeable: 'Chargeable', remarks: '' }]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!serviceJobNo.trim()) {
      setError('Service Job Number is required.');
      return;
    }
    const valid = lines.filter((l) => l.itemId && Number(l.qty) > 0);
    if (valid.length === 0) {
      setError('Add at least one used spare part with a quantity.');
      return;
    }
    setBusy(true);
    try {
      const lineRecords = valid.map((l) => {
        const item = items.find((it) => it.id === l.itemId);
        return {
          itemId: l.itemId,
          partNumber: item?.partNumber || item?.partCode || '',
          description: item?.particulars || '',
          qtyUsed: Number(l.qty),
          warrantyOrChargeable: l.warrantyOrChargeable,
          remarks: l.remarks || '',
        };
      });
      for (const lr of lineRecords) {
        await addDoc(collection(db, 'transactions'), {
          itemId: lr.itemId,
          itemName: lr.description,
          type: 'consumption',
          direction: 'none',
          quantity: lr.qtyUsed,
          reason: `Consumed at ${customerName || 'customer site'} — job ${serviceJobNo} (${lr.warrantyOrChargeable})`,
          serviceJobNo,
          performedByEmail: userEmail || '',
          transactionDate: serviceDate,
          createdAt: serverTimestamp(),
        });
      }
      await addDoc(collection(db, 'sparePartsUsed'), {
        serviceJobNo: serviceJobNo.trim(),
        customerName: customerName.trim(),
        machineModel: machineModel.trim(),
        serialNumber: serialNumber.trim(),
        serviceDate,
        items: lineRecords,
        createdByEmail: userEmail || '',
        createdAt: serverTimestamp(),
      });
      setSuccess(`Recorded ${valid.length} part(s) used for job ${serviceJobNo}.`);
      logActivity(userEmail, 'Parts used on job', `${valid.length} part(s) · job ${serviceJobNo}`);
      setServiceJobNo('');
      setCustomerName('');
      setMachineModel('');
      setSerialNumber('');
      setServiceDate(new Date().toISOString().slice(0, 10));
      setLines([{ ...blankLine(), warrantyOrChargeable: 'Chargeable', remarks: '' }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-4 max-w-3xl">
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded text-sm">{success}</div>}
      <div className="grid sm:grid-cols-2 gap-4">
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Service Job Number *</label>
          <input value={serviceJobNo} onChange={(e) => setServiceJobNo(e.target.value)} className="w-full px-3 py-2 border rounded-lg" required /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
          <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="w-full px-3 py-2 border rounded-lg" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Machine Model</label>
          <input value={machineModel} onChange={(e) => setMachineModel(e.target.value)} className="w-full px-3 py-2 border rounded-lg" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Serial Number</label>
          <input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} className="w-full px-3 py-2 border rounded-lg" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">Service Date</label>
          <input type="date" value={serviceDate} onChange={(e) => setServiceDate(e.target.value)} className="w-full px-3 py-2 border rounded-lg" /></div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Spare Parts Used</label>
        <div className="space-y-2">
          {lines.map((l, idx) => (
            <div key={idx} className="flex items-center gap-2 flex-wrap">
              <div className="flex-1 min-w-[220px]">
                <MobileItemPicker
                  items={sortedItems}
                  value={l.itemId}
                  onChange={(id) => updateLine(idx, 'itemId', id)}
                  placeholder="Select spare part..."
                />
              </div>
              <input type="number" placeholder="Qty Used" value={l.qty} onChange={(e) => updateLine(idx, 'qty', e.target.value)} className="w-28 px-3 py-2 border rounded-lg" />
              <select value={l.warrantyOrChargeable} onChange={(e) => updateLine(idx, 'warrantyOrChargeable', e.target.value)} className="w-36 px-3 py-2 border rounded-lg">
                {WARRANTY_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
              <input placeholder="Remarks" value={l.remarks} onChange={(e) => updateLine(idx, 'remarks', e.target.value)} className="w-40 px-3 py-2 border rounded-lg" />
              <button type="button" onClick={() => removeLine(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={16} /></button>
            </div>
          ))}
          <button type="button" onClick={addLine} className="flex items-center gap-1 text-emerald-700 text-sm font-medium"><Plus size={14} /> Add line</button>
        </div>
      </div>
      <button type="submit" disabled={disabled || busy} className="bg-emerald-700 hover:bg-emerald-800 text-white font-bold py-2 px-4 rounded-lg disabled:opacity-50">
        {busy ? 'Saving...' : 'Record Spare Parts Used'}
      </button>
    </form>
  );
}

function EngineerRegister({ issues, returns, used }) {
  const [engineerFilter, setEngineerFilter] = useState('All');

  const rows = useMemo(() => {
    const key = (engineer, jobNo, partNumber) => `${engineer}||${jobNo}||${partNumber}`;
    const map = new Map();
    const touch = (engineer, jobNo, partNumber, description) => {
      const k = key(engineer, jobNo, partNumber);
      if (!map.has(k)) map.set(k, { engineer, jobNo, partNumber, description, issued: 0, returned: 0, used: 0 });
      return map.get(k);
    };
    issues.forEach((doc) => {
      (doc.items || []).forEach((it) => {
        const r = touch(doc.engineerName, doc.serviceJobNo, it.partNumber, it.description);
        r.issued += Number(it.qtyIssued || 0);
      });
    });
    returns.forEach((doc) => {
      (doc.items || []).forEach((it) => {
        const r = touch(doc.engineerName, doc.serviceJobNo, it.partNumber, '');
        r.returned += Number(it.qtyReturned || 0);
      });
    });
    used.forEach((doc) => {
      (doc.items || []).forEach((it) => {
        // Used entries aren't tied to a specific engineer name, only a job — attribute
        // to any engineer already seen on that job for register purposes.
        const relatedIssue = issues.find((i) => i.serviceJobNo === doc.serviceJobNo);
        const engineer = relatedIssue ? relatedIssue.engineerName : '(unlinked job)';
        const r = touch(engineer, doc.serviceJobNo, it.partNumber, it.description);
        r.used += Number(it.qtyUsed || 0);
      });
    });
    return Array.from(map.values()).map((r) => ({
      ...r,
      balance: r.issued - r.returned,
      status: r.issued - r.returned - r.used === 0 ? 'Reconciled' : 'Pending',
    }));
  }, [issues, returns, used]);

  const engineers = useMemo(() => ['All', ...Array.from(new Set(rows.map((r) => r.engineer))).sort()], [rows]);
  const filtered = engineerFilter === 'All' ? rows : rows.filter((r) => r.engineer === engineerFilter);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">Engineer</label>
        <select value={engineerFilter} onChange={(e) => setEngineerFilter(e.target.value)} className="px-3 py-2 border rounded-lg">
          {engineers.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Engineer</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Service Job</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Part Number</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Issued</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Returned</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Used</th>
              <th className="text-right px-4 py-3 font-semibold text-gray-600">Balance with Engineer</th>
              <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, idx) => (
              <tr key={idx} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3">{r.engineer}</td>
                <td className="px-4 py-3">{r.jobNo}</td>
                <td className="px-4 py-3 font-mono text-xs">{r.partNumber || '-'}</td>
                <td className="px-4 py-3 text-right">{r.issued}</td>
                <td className="px-4 py-3 text-right">{r.returned}</td>
                <td className="px-4 py-3 text-right">{r.used}</td>
                <td className="px-4 py-3 text-right font-semibold">{r.balance - r.used}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-semibold px-2 py-1 rounded border ${
                    r.status === 'Reconciled' ? 'bg-green-100 text-green-700 border-green-300' : 'bg-yellow-100 text-yellow-800 border-yellow-300'
                  }`}>{r.status}</span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No engineer transactions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
