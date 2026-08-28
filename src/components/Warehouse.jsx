import React, { useState, useEffect, useMemo, useRef } from 'react';
import { db, auth } from '../firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import {
  PackageCheck,
  Clock,
  CheckCircle2,
  History,
  Download,
  UploadCloud,
  ShieldAlert,
  Search,
} from 'lucide-react';
import { LOCATION_STATUS, ageingColour, daysPending, applyLocationAllocation } from '../putaway';
import { matchesLoose } from '../lib/brands';

function toDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}

export default function Warehouse({ userRole, userEmail }) {
  const [tab, setTab] = useState('putaway'); // putaway | pending | completed | history
  const [lines, setLines] = useState([]);
  const [items, setItems] = useState([]);
  const [locations, setLocations] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [search, setSearch] = useState('');

  const canEdit = userRole === 'admin' || userRole === 'inventory_manager';

  useEffect(() => {
    const unsubLines = onSnapshot(query(collection(db, 'putawayLines'), orderBy('createdAt', 'desc')), (snap) => {
      setLines(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubItems = onSnapshot(collection(db, 'items'), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubLocs = onSnapshot(collection(db, 'locations'), (snap) => {
      setLocations(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubAudit = onSnapshot(
      query(collection(db, 'locationAuditLog'), orderBy('createdAt', 'desc')),
      (snap) => setAuditLog(snap.docs.slice(0, 500).map((d) => ({ id: d.id, ...d.data() })))
    );
    return () => {
      unsubLines();
      unsubItems();
      unsubLocs();
      unsubAudit();
    };
  }, []);

  const itemsById = useMemo(() => Object.fromEntries(items.map((it) => [it.id, it])), [items]);

  const matchesLine = (line) => {
    const locCodes = (line.allocations || []).map((a) => a.locationCode).join(' ');
    return matchesLoose(
      [line.invoiceNumber, line.supplier, line.description, line.itemCode, line.status, locCodes],
      search
    );
  };

  const filteredLines = useMemo(() => lines.filter(matchesLine), [lines, search]);
  const pendingLines = useMemo(
    () => filteredLines.filter((l) => l.status !== LOCATION_STATUS.COMPLETE),
    [filteredLines]
  );
  const completedLines = useMemo(
    () => filteredLines.filter((l) => l.status === LOCATION_STATUS.COMPLETE),
    [filteredLines]
  );

  if (userRole !== 'admin' && userRole !== 'inventory_manager' && userRole !== 'staff') {
    return (
      <div className="max-w-md mx-auto mt-20 text-center text-gray-500">
        <ShieldAlert className="mx-auto mb-3 text-gray-400" size={40} />
        <p>Warehouse Put-away is not available for this role.</p>
      </div>
    );
  }

  const tabs = [
    { id: 'putaway', label: 'Put-away Report', icon: PackageCheck },
    { id: 'pending', label: `Pending Locations (${pendingLines.length})`, icon: Clock },
    { id: 'completed', label: 'Completed', icon: CheckCircle2 },
    { id: 'history', label: 'Location History', icon: History },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <PackageCheck className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Warehouse Put-away</h1>
      </div>
      <p className="text-gray-500 text-sm max-w-2xl">
        Every purchase/return receipt shows up here as LOCATION PENDING the moment it's saved. Physically store the
        goods, then either allocate a location inline below or upload the completed Put-away Location Report.
      </p>

      <div className="flex gap-2 bg-gray-100 rounded-lg p-1 w-fit flex-wrap">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
                tab === t.id ? 'bg-white shadow text-emerald-700' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon size={16} /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by invoice no., supplier, item, location, status..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-600"
        />
      </div>

      {tab === 'putaway' && (
        <PutawayReportTable
          lines={filteredLines}
          itemsById={itemsById}
          locations={locations}
          canEdit={canEdit}
          userEmail={userEmail}
        />
      )}
      {tab === 'pending' && (
        <PendingLocationTable
          lines={pendingLines}
          locations={locations}
          canEdit={canEdit}
          userEmail={userEmail}
        />
      )}
      {tab === 'completed' && <CompletedTable lines={completedLines} />}
      {tab === 'history' && <HistoryTable auditLog={auditLog} />}
    </div>
  );
}

function download(filename, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}

function PutawayReportTable({ lines, itemsById, locations, canEdit, userEmail }) {
  const [allocating, setAllocating] = useState(null); // line id being allocated
  const [allocLocation, setAllocLocation] = useState('');
  const [allocQty, setAllocQty] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const startAllocate = (line) => {
    setAllocating(line.id);
    setAllocLocation('');
    setAllocQty(String(line.pendingQty || line.receivedQty || ''));
    setError('');
    setSuccess('');
  };

  const submitAllocate = async (line) => {
    setError('');
    const code = allocLocation.trim().toUpperCase();
    if (!code) {
      setError('Type a location code.');
      return;
    }
    setBusy(true);
    try {
      await applyLocationAllocation({
        line,
        locationCode: code,
        qty: allocQty,
        userEmail,
        action: 'LOCATION_CHANGE',
      });
      setSuccess(`Allocated ${allocQty} to ${code}.`);
      setAllocating(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const exportReport = () => {
    download(
      `putaway_report_${new Date().toISOString().slice(0, 10)}.xlsx`,
      lines.map((l) => {
        const item = itemsById[l.itemId] || {};
        const existingLocs = (l.allocations || []).map((a) => `${a.locationCode} (${a.qty})`).join(', ');
        const suggested = locations
          .filter((loc) => loc.status === 'ACTIVE' && (!loc.maxCapacity || loc.currentOccupancy < loc.maxCapacity))
          .slice(0, 3)
          .map((loc) => loc.locationCode)
          .join(', ');
        return {
          'Invoice Number': l.invoiceNumber,
          'Invoice Date': l.invoiceDate,
          Supplier: l.supplier,
          'Item Code': l.itemCode,
          Description: l.description,
          'Received Quantity': l.receivedQty,
          'Existing Stock': item.currentStock ?? '',
          'Existing Locations': existingLocs || 'None',
          'Suggested Locations': suggested || 'Assign in Location Master',
          'Location Status': l.status,
        };
      })
    );
  };

  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <div className="flex items-center justify-between p-4 border-b">
        <h2 className="font-semibold text-gray-800">{lines.length} receipt line(s)</h2>
        <button
          onClick={exportReport}
          disabled={lines.length === 0}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm disabled:opacity-50"
        >
          <Download size={16} /> Export
        </button>
      </div>
      {error && <div className="mx-4 mt-4 bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
      {success && <div className="mx-4 mt-4 bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded text-sm">{success}</div>}
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Invoice #</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Supplier</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Item</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600">Received</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600">Existing Stock</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Existing Locations</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && (
            <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">No receipts recorded yet.</td></tr>
          )}
          {lines.map((l) => {
            const item = itemsById[l.itemId] || {};
            const badge = ageingColour(l);
            const clickable = canEdit && l.status !== LOCATION_STATUS.COMPLETE;
            return (
              <React.Fragment key={l.id}>
                <tr className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-3 py-2">{l.invoiceNumber}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{l.invoiceDate}</td>
                  <td className="px-3 py-2">{l.supplier || '—'}</td>
                  <td className="px-3 py-2 font-medium text-gray-800">{l.description}</td>
                  <td className="px-3 py-2 text-right">{l.receivedQty}</td>
                  <td className="px-3 py-2 text-right">{item.currentStock ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {(l.allocations || []).length === 0
                      ? '—'
                      : l.allocations.map((a) => `${a.locationCode} (${a.qty})`).join(', ')}
                  </td>
                  <td className="px-3 py-2">
                    {clickable ? (
                      <button
                        type="button"
                        onClick={() => startAllocate(l)}
                        title="Click to enter the location manually"
                        className={`px-2 py-1 rounded-full text-xs font-medium border ${badge.color} hover:opacity-75 cursor-pointer`}
                      >
                        {l.status}
                      </button>
                    ) : (
                      <span className={`px-2 py-1 rounded-full text-xs font-medium border ${badge.color}`}>{l.status}</span>
                    )}
                  </td>
                </tr>
                {allocating === l.id && (
                  <tr className="bg-emerald-50">
                    <td colSpan={8} className="px-3 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Location (type manually)</label>
                          <input
                            type="text"
                            list="putaway-location-suggestions"
                            value={allocLocation}
                            onChange={(e) => setAllocLocation(e.target.value)}
                            placeholder="e.g. B6-R3"
                            autoFocus
                            className="w-40 px-2 py-1 border rounded text-sm uppercase"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                          <input
                            type="number"
                            value={allocQty}
                            onChange={(e) => setAllocQty(e.target.value)}
                            className="w-24 px-2 py-1 border rounded text-sm"
                          />
                        </div>
                        <button
                          onClick={() => submitAllocate(l)}
                          disabled={busy}
                          className="bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                        >
                          Save
                        </button>
                        <button onClick={() => setAllocating(null)} className="text-gray-500 text-sm">Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      <datalist id="putaway-location-suggestions">
        {locations.map((loc) => (
          <option key={loc.id} value={loc.locationCode} />
        ))}
      </datalist>
    </div>
  );
}

function PendingLocationTable({ lines, locations, canEdit, userEmail }) {
  const [allocating, setAllocating] = useState(null); // line id being allocated
  const [allocLocation, setAllocLocation] = useState('');
  const [allocQty, setAllocQty] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadResult, setUploadResult] = useState('');

  const activeLocations = useMemo(() => locations.filter((l) => l.status === 'ACTIVE'), [locations]);

  const startAllocate = (line) => {
    setAllocating(line.id);
    setAllocLocation('');
    setAllocQty(String(line.pendingQty || ''));
    setError('');
    setSuccess('');
  };

  const submitAllocate = async (line) => {
    setError('');
    const code = allocLocation.trim().toUpperCase();
    if (!code) {
      setError('Type a location code.');
      return;
    }
    setBusy(true);
    try {
      await applyLocationAllocation({
        line,
        locationCode: code,
        qty: allocQty,
        userEmail,
        action: 'LOCATION_CHANGE',
      });
      setSuccess(`Allocated ${allocQty} to ${code}.`);
      setAllocating(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    download(
      `Pending_Location_Report_${new Date().toISOString().slice(0, 10)}.xlsx`,
      lines.map((l) => ({
        'Line ID': l.id,
        'Invoice Number': l.invoiceNumber,
        'Invoice Date': l.invoiceDate,
        Supplier: l.supplier,
        'Item Code': l.itemCode,
        Description: l.description,
        'Received Qty': l.receivedQty,
        'Located Qty': l.locatedQty,
        'Pending Qty': l.pendingQty,
        'Days Pending': daysPending(l.createdAt),
        Status: l.status,
        Warehouse: '',
        Rack: '',
        Shelf: '',
        Bin: '',
        'Location Qty': '',
      }))
    );
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadResult('');
    setUploadBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
      let applied = 0;
      const failed = [];
      for (const row of rows) {
        const lineId = row['Line ID'];
        const rack = row['Rack'];
        const qty = row['Location Qty'];
        if (!lineId || !rack || !qty) continue;
        const line = lines.find((l) => l.id === lineId);
        if (!line) {
          failed.push(`Line ${lineId}: not found (may already be completed).`);
          continue;
        }
        const locationCode = [row['Rack'], row['Shelf'], row['Bin']]
          .filter(Boolean)
          .map((v) => String(v).trim())
          .join('-')
          .toUpperCase();
        try {
          await applyLocationAllocation({
            line,
            locationCode,
            qty,
            userEmail,
            action: 'LOCATION_UPLOAD',
          });
          applied += 1;
        } catch (err) {
          failed.push(`Line ${lineId}: ${err.message}`);
        }
      }
      setUploadResult(
        `Applied ${applied} allocation(s).` + (failed.length ? ` ${failed.length} failed: ${failed.join(' | ')}` : '')
      );
    } catch (err) {
      setUploadResult('Could not read that file: ' + err.message);
    } finally {
      setUploadBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="bg-white rounded-lg shadow p-4 flex flex-wrap items-center gap-3">
          <button
            onClick={downloadTemplate}
            className="flex items-center gap-2 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-lg text-sm"
          >
            <Download size={16} /> Download Pending Location Report
          </button>
          <label className="flex items-center gap-2 bg-emerald-700 hover:bg-emerald-800 text-white px-4 py-2 rounded-lg text-sm cursor-pointer">
            <UploadCloud size={16} />
            Upload Completed Report
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleUpload} className="hidden" />
          </label>
          {uploadBusy && <span className="text-sm text-gray-500">Processing...</span>}
          {uploadResult && <span className="text-sm text-gray-600">{uploadResult}</span>}
        </div>
      )}
      {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded text-sm">{error}</div>}
      {success && <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-2 rounded text-sm">{success}</div>}

      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Invoice #</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Supplier</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Item</th>
              <th className="text-right px-3 py-2 font-semibold text-gray-600">Received</th>
              <th className="text-right px-3 py-2 font-semibold text-gray-600">Located</th>
              <th className="text-right px-3 py-2 font-semibold text-gray-600">Pending</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-600">Ageing</th>
              {canEdit && <th className="px-3 py-2"></th>}
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr><td colSpan={canEdit ? 8 : 7} className="px-3 py-8 text-center text-gray-400">Nothing pending — all caught up.</td></tr>
            )}
            {lines.map((l) => {
              const badge = ageingColour(l);
              return (
                <React.Fragment key={l.id}>
                  <tr className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2">{l.invoiceNumber}</td>
                    <td className="px-3 py-2">{l.supplier || '—'}</td>
                    <td className="px-3 py-2 font-medium text-gray-800">{l.description}</td>
                    <td className="px-3 py-2 text-right">{l.receivedQty}</td>
                    <td className="px-3 py-2 text-right">{l.locatedQty}</td>
                    <td className="px-3 py-2 text-right font-semibold">{l.pendingQty}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium border ${badge.color}`}>{badge.label}</span>
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2">
                        <button
                          onClick={() => startAllocate(l)}
                          className="text-emerald-700 hover:text-emerald-900 text-xs font-medium"
                        >
                          Allocate
                        </button>
                      </td>
                    )}
                  </tr>
                  {allocating === l.id && (
                    <tr className="bg-emerald-50">
                      <td colSpan={canEdit ? 8 : 7} className="px-3 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Location</label>
                            <input
                              type="text"
                              list="pending-location-suggestions"
                              value={allocLocation}
                              onChange={(e) => setAllocLocation(e.target.value)}
                              placeholder="e.g. B6-R3"
                              className="w-40 px-2 py-1 border rounded text-sm uppercase"
                            />
                            <datalist id="pending-location-suggestions">
                              {activeLocations.map((loc) => (
                                <option key={loc.id} value={loc.locationCode} />
                              ))}
                            </datalist>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                            <input
                              type="number"
                              value={allocQty}
                              onChange={(e) => setAllocQty(e.target.value)}
                              className="w-24 px-2 py-1 border rounded text-sm"
                            />
                          </div>
                          <button
                            onClick={() => submitAllocate(l)}
                            disabled={busy}
                            className="bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-medium px-3 py-1.5 rounded disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button onClick={() => setAllocating(null)} className="text-gray-500 text-sm">Cancel</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompletedTable({ lines }) {
  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Invoice #</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Item</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600">Received</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Located At</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && (
            <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400">No completed put-aways yet.</td></tr>
          )}
          {lines.map((l) => (
            <tr key={l.id} className="border-b last:border-0 hover:bg-gray-50">
              <td className="px-3 py-2">{l.invoiceNumber}</td>
              <td className="px-3 py-2 font-medium text-gray-800">{l.description}</td>
              <td className="px-3 py-2 text-right">{l.receivedQty}</td>
              <td className="px-3 py-2 text-xs">
                {(l.allocations || []).map((a) => `${a.locationCode} (${a.qty})`).join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({ auditLog }) {
  return (
    <div className="bg-white rounded-lg shadow overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Date/Time</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Action</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Item</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">Old Location</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">New Location</th>
            <th className="text-right px-3 py-2 font-semibold text-gray-600">Qty</th>
            <th className="text-left px-3 py-2 font-semibold text-gray-600">User</th>
          </tr>
        </thead>
        <tbody>
          {auditLog.length === 0 && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">No history yet.</td></tr>
          )}
          {auditLog.map((a) => (
            <tr key={a.id} className="border-b last:border-0 hover:bg-gray-50">
              <td className="px-3 py-2 whitespace-nowrap">{toDate(a.createdAt)?.toLocaleString() || ''}</td>
              <td className="px-3 py-2">{a.action}</td>
              <td className="px-3 py-2">{a.itemName}</td>
              <td className="px-3 py-2">{a.oldLocationCode || '—'}</td>
              <td className="px-3 py-2">{a.newLocationCode || '—'}</td>
              <td className="px-3 py-2 text-right">{a.qty}</td>
              <td className="px-3 py-2">{a.userEmail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
