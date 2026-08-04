import React, { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import {
  collection, onSnapshot, doc, runTransaction, serverTimestamp,
} from 'firebase/firestore';
import {
  Camera, Loader2, CheckCircle2, Trash2, ArrowLeft, ShieldAlert,
} from 'lucide-react';
import { checkAndSendLowStockAlert } from '../lowStockAlert';
import { createPutawayLine } from '../putaway';
import {
  extractRowsFromFile, findBestMatch, MOVEMENT_TYPES, DOC_TYPE_LABELS, normalizeDateForInput,
} from '../lib/scanExtract';
import MobileItemPicker from './MobileItemPicker';

// Mobile-first, single-purpose version of Import Data: point the camera at
// a chit/invoice/DC, review the extracted lines as big cards (not a dense
// desktop table), confirm, done. Shares the exact same extraction/matching
// logic as the desktop screen via src/lib/scanExtract.js.
export default function MobileQuickScan({ userRole, userEmail, onExit }) {
  const [items, setItems] = useState([]);
  const [movementType, setMovementType] = useState('purchase');
  const [transactionDate, setTransactionDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const [supplier, setSupplier] = useState('');
  const [rows, setRows] = useState([]);
  const [detectedMeta, setDetectedMeta] = useState(null);
  const [sourceLabel, setSourceLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'items'), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  if (userRole !== 'admin' && userRole !== 'inventory_manager') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500 px-4">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Quick Scan is restricted to Admin and Inventory Manager users.</p>
        <button onClick={onExit} className="mt-4 text-emerald-700 font-medium">Back to Field Mode</button>
      </div>
    );
  }

  const movement = MOVEMENT_TYPES.find((m) => m.id === movementType);
  const isReceiving = movement.direction === 'in';

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setSuccess('');
    setRows([]);
    setDetectedMeta(null);
    setSourceLabel(file.name);
    setReason(file.name.replace(/\.[^/.]+$/, ''));
    setBusy(true);
    try {
      const { rows: mapped, meta } = await extractRowsFromFile(file);
      if (mapped.length === 0) {
        setError('No recognisable item rows found in that photo. Try a clearer, well-lit shot.');
      }
      const withMatches = mapped.map((r) => {
        const match = findBestMatch(r.particulars, items, r.partCode);
        return {
          particulars: r.particulars,
          quantity: r.quantity ?? '',
          unitCost: r.avgCost ?? '',
          itemId: match ? match.id : '',
        };
      });
      setRows(withMatches);
      setDetectedMeta(meta);
      if (meta?.documentType && MOVEMENT_TYPES.some((m) => m.id === meta.documentType)) {
        setMovementType(meta.documentType);
      }
      if (meta?.documentNumber) setReason(meta.documentNumber);
      if (meta?.partyName) setSupplier(meta.partyName);
      const parsedDate = normalizeDateForInput(meta?.documentDate);
      if (parsedDate) setTransactionDate(parsedDate);
    } catch (err) {
      setError(err.message || 'Could not read that file.');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateRow = (idx, field, value) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };
  const removeRow = (idx) => setRows((prev) => prev.filter((_, i) => i !== idx));

  const handleRecord = async () => {
    setError('');
    setSuccess('');
    const withQty = rows.filter((r) => Number(r.quantity) > 0);
    if (withQty.length === 0) {
      setError('Enter a quantity greater than 0 for at least one part.');
      return;
    }
    const matched = withQty.filter((r) => r.itemId);
    if (matched.length === 0) {
      setError('None of these rows are matched to a part yet. Tap each row to pick the right part.');
      return;
    }
    setBusy(true);
    let recorded = 0;
    const failed = [];
    try {
      for (const r of matched) {
        const qty = Number(r.quantity);
        let committedItemName = '';
        let committedItemCode = '';
        let committedTxnId = '';
        try {
          await runTransaction(db, async (tx) => {
            const itemRef = doc(db, 'items', r.itemId);
            const itemSnap = await tx.get(itemRef);
            if (!itemSnap.exists()) throw new Error('Item no longer exists.');
            const current = Number(itemSnap.data().currentStock || 0);
            const delta = movement.direction === 'in' ? qty : -qty;
            const newStock = current + delta;
            if (newStock < 0) {
              throw new Error(`${itemSnap.data().particulars}: would make stock negative (current ${current}, qty ${qty}).`);
            }
            const updates = { currentStock: newStock, updatedAt: serverTimestamp(), masterOnly: false };
            if (movement.id === 'purchase' && r.unitCost) {
              updates.avgCost = Number(r.unitCost);
            }
            tx.update(itemRef, updates);

            const txnRef = doc(collection(db, 'transactions'));
            tx.set(txnRef, {
              itemId: r.itemId,
              itemName: itemSnap.data().particulars,
              brand: itemSnap.data().brand || '',
              type: movement.id,
              direction: movement.direction,
              quantity: qty,
              unitCost: r.unitCost ? Number(r.unitCost) : null,
              reason: reason.trim() || `Mobile scan: ${sourceLabel}`,
              extractedName: r.particulars || '',
              ...(isReceiving ? { supplier: supplier.trim() } : { customerName: supplier.trim() }),
              performedByEmail: userEmail || '',
              transactionDate,
              recordedVia: 'mobile-quick-scan',
              createdAt: serverTimestamp(),
            });
            committedItemName = itemSnap.data().particulars;
            committedItemCode = itemSnap.data().sno;
            committedTxnId = txnRef.id;
          });
          await checkAndSendLowStockAlert(r.itemId);
          if (isReceiving) {
            await createPutawayLine({
              itemId: r.itemId,
              itemName: committedItemName,
              itemCode: committedItemCode,
              quantity: qty,
              invoiceNumber: reason.trim() || sourceLabel || 'N/A',
              invoiceDate: transactionDate,
              supplier: supplier.trim(),
              transactionId: committedTxnId,
              userEmail,
            });
          }
          recorded += 1;
        } catch (err) {
          failed.push(err.message);
        }
      }
      let message = `Recorded ${recorded} of ${matched.length} part(s).`;
      if (failed.length) message += ` ${failed.length} failed: ${failed.join(' ')}`;
      setSuccess(message);
      setRows((prev) => prev.filter((r) => !matched.includes(r) || failed.some((f) => f.includes(r.particulars))));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-28">
      <div className="sticky top-0 z-10 bg-emerald-700 text-white px-4 py-3 flex items-center gap-3 shadow">
        <button onClick={onExit} className="p-1 -ml-1"><ArrowLeft size={22} /></button>
        <div>
          <h1 className="font-bold text-lg leading-tight">Quick Scan</h1>
          <p className="text-xs text-emerald-100">Photograph a chit, invoice, or DC</p>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {rows.length === 0 && (
          <div className="bg-white rounded-2xl shadow p-6 text-center space-y-4">
            <Camera className="mx-auto text-emerald-600" size={48} />
            <p className="text-gray-600">Take a photo of the document, or choose one from your gallery.</p>
            <label className="block w-full bg-emerald-700 active:bg-emerald-800 text-white font-bold py-4 rounded-xl text-lg cursor-pointer">
              {busy ? 'Reading document...' : 'Scan Document'}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                onChange={handleFile}
                disabled={busy}
                className="hidden"
              />
            </label>
            {busy && (
              <p className="text-sm text-emerald-700 flex items-center justify-center gap-2">
                <Loader2 size={16} className="animate-spin" /> Reading with AI, one moment...
              </p>
            )}
          </div>
        )}

        {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0" /> {success}
          </div>
        )}

        {detectedMeta && (detectedMeta.documentType || detectedMeta.documentNumber || detectedMeta.partyName) && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 px-4 py-3 rounded-xl text-sm">
            Detected: {DOC_TYPE_LABELS[detectedMeta.documentType] || 'Document'}
            {detectedMeta.documentNumber ? ` #${detectedMeta.documentNumber}` : ''}
            {detectedMeta.partyName ? ` — ${detectedMeta.partyName}` : ''}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="bg-white rounded-2xl shadow p-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">Movement Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {MOVEMENT_TYPES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setMovementType(m.id)}
                      className={`py-2.5 rounded-lg text-sm font-medium border ${movementType === m.id ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-gray-50 text-gray-600 border-gray-200'}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">Transaction Date</label>
                <input
                  type="date"
                  value={transactionDate}
                  onChange={(e) => setTransactionDate(e.target.value)}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">
                  {isReceiving ? 'Invoice / Reference No.' : 'Reason / Reference'}
                </label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">
                  {isReceiving ? 'Supplier' : 'Customer'}
                </label>
                <input
                  type="text"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  className="w-full px-3 py-2.5 border rounded-lg text-base"
                />
              </div>
            </div>

            <div className="space-y-3">
              {rows.map((r, idx) => (
                <div key={idx} className="bg-white rounded-2xl shadow p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-gray-500 flex-1">{r.particulars || 'Unnamed row'}</p>
                    <button onClick={() => removeRow(idx)} className="text-red-400 active:text-red-600 shrink-0">
                      <Trash2 size={18} />
                    </button>
                  </div>
                  <MobileItemPicker
                    items={items}
                    value={r.itemId}
                    onChange={(id) => updateRow(idx, 'itemId', id)}
                    placeholder="No match — tap to pick the part"
                  />
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">Quantity</label>
                      <input
                        type="number"
                        value={r.quantity}
                        onChange={(e) => updateRow(idx, 'quantity', e.target.value)}
                        className="w-full px-3 py-2.5 border rounded-lg text-base"
                      />
                    </div>
                    {movement.id === 'purchase' && (
                      <div className="flex-1">
                        <label className="block text-xs font-semibold text-gray-500 mb-1 uppercase">Unit Cost</label>
                        <input
                          type="number"
                          step="0.01"
                          value={r.unitCost}
                          onChange={(e) => updateRow(idx, 'unitCost', e.target.value)}
                          className="w-full px-3 py-2.5 border rounded-lg text-base"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => { setRows([]); setDetectedMeta(null); setError(''); setSuccess(''); }}
              className="w-full text-center text-sm text-gray-400 py-2"
            >
              Scan a different document instead
            </button>
          </>
        )}
      </div>

      {rows.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t p-4 shadow-lg">
          <button
            onClick={handleRecord}
            disabled={busy}
            className="w-full bg-emerald-700 active:bg-emerald-800 text-white font-bold py-4 rounded-xl text-lg disabled:opacity-50"
          >
            {busy ? 'Recording...' : `Record ${rows.filter((r) => Number(r.quantity) > 0).length} Part(s)`}
          </button>
        </div>
      )}
    </div>
  );
}
