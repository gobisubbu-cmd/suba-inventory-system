import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import * as XLSX from 'xlsx';
import { BarChart3, Download } from 'lucide-react';
import { daysPending, LOCATION_STATUS } from '../putaway';
import { computeStockStatus } from '../lib/brands';

function toDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}

function download(filename, rows) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}

export default function Reports({ userRole }) {
  const [items, setItems] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [putawayLines, setPutawayLines] = useState([]);
  const [engineerIssues, setEngineerIssues] = useState([]);
  const [engineerReturns, setEngineerReturns] = useState([]);
  const [sparePartsUsed, setSparePartsUsed] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    const unsubItems = onSnapshot(query(collection(db, 'items'), orderBy('sno', 'asc')), (snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubTxns = onSnapshot(query(collection(db, 'transactions'), orderBy('createdAt', 'desc')), (snap) => {
      setTransactions(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubPutaway = onSnapshot(query(collection(db, 'putawayLines'), orderBy('createdAt', 'desc')), (snap) => {
      setPutawayLines(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubIssues = onSnapshot(collection(db, 'engineerIssues'), (snap) => {
      setEngineerIssues(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubReturns = onSnapshot(collection(db, 'engineerReturns'), (snap) => {
      setEngineerReturns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    const unsubUsed = onSnapshot(collection(db, 'sparePartsUsed'), (snap) => {
      setSparePartsUsed(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => {
      unsubItems();
      unsubTxns();
      unsubPutaway();
      unsubIssues();
      unsubReturns();
      unsubUsed();
    };
  }, []);

  const canSeeValue = userRole === 'admin' || userRole === 'inventory_manager';

  const filteredTxns = useMemo(() => {
    if (!startDate && !endDate) return transactions;
    const start = startDate ? new Date(startDate) : null;
    const end = endDate ? new Date(endDate + 'T23:59:59') : null;
    return transactions.filter((t) => {
      const d = toDate(t.createdAt);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }, [transactions, startDate, endDate]);

  const lowStock = items.filter((it) => Number(it.currentStock || 0) <= Number(it.reorderLevel || 0) && Number(it.currentStock || 0) > 0);
  const outOfStock = items.filter((it) => Number(it.currentStock || 0) <= 0);

  const exportStockSummary = () => {
    download(
      'stock_summary.xlsx',
      items.map((it) => ({
        'S.No': it.sno,
        Particulars: it.particulars,
        Unit: it.unit,
        'Rack No': it.rackNo,
        'HSN Code': it.hsnCode,
        'Current Stock': it.currentStock,
        'Reorder Level': it.reorderLevel,
        ...(canSeeValue ? { 'Avg Cost': it.avgCost, 'Stock Value': Number(it.currentStock || 0) * Number(it.avgCost || 0) } : {}),
      }))
    );
  };

  const exportLowStock = () => {
    download(
      'low_and_critical_stock.xlsx',
      [...outOfStock, ...lowStock].map((it) => ({
        Particulars: it.particulars,
        'Current Stock': it.currentStock,
        'Reorder Level': it.reorderLevel,
        Status: it.currentStock <= 0 ? 'Out of Stock' : 'Low Stock',
      }))
    );
  };

  const exportMovements = (filterType) => {
    const rows = filteredTxns
      .filter((t) => !filterType || t.type === filterType)
      .map((t) => ({
        Date: toDate(t.createdAt)?.toLocaleString() || '',
        Item: t.itemName,
        Type: t.type,
        Direction: t.direction,
        Quantity: t.quantity,
        'Unit Cost': t.unitCost || '',
        Reason: t.reason,
        'Performed By': t.performedByEmail,
      }));
    const name = filterType ? `${filterType}_movements.xlsx` : 'all_movements.xlsx';
    download(name, rows);
  };

  // --- Warehouse Put-away reports ---

  const exportPutawayReport = () => {
    download(
      'putaway_report.xlsx',
      putawayLines.map((l) => ({
        'Invoice Number': l.invoiceNumber,
        'Invoice Date': l.invoiceDate,
        Supplier: l.supplier,
        'Item Code': l.itemCode,
        Description: l.description,
        'Received Quantity': l.receivedQty,
        'Located Quantity': l.locatedQty,
        'Pending Quantity': l.pendingQty,
        Status: l.status,
      }))
    );
  };

  const exportPendingLocationReport = () => {
    const pending = putawayLines.filter((l) => l.status !== LOCATION_STATUS.COMPLETE);
    download(
      'pending_location_report.xlsx',
      pending.map((l) => ({
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
      }))
    );
  };

  const exportCompletedLocationReport = () => {
    const completed = putawayLines.filter((l) => l.status === LOCATION_STATUS.COMPLETE);
    download(
      'completed_location_report.xlsx',
      completed.map((l) => ({
        'Invoice Number': l.invoiceNumber,
        Item: l.description,
        'Received Qty': l.receivedQty,
        Locations: (l.allocations || []).map((a) => `${a.locationCode} (${a.qty})`).join(', '),
      }))
    );
  };

  const exportAgeingReport = () => {
    const pending = putawayLines.filter((l) => l.status !== LOCATION_STATUS.COMPLETE);
    download(
      'ageing_report.xlsx',
      pending
        .map((l) => ({ ...l, _days: daysPending(l.createdAt) }))
        .sort((a, b) => b._days - a._days)
        .map((l) => ({
          'Invoice Number': l.invoiceNumber,
          Item: l.description,
          'Pending Qty': l.pendingQty,
          'Days Pending': l._days,
          Band: l._days <= 2 ? 'Yellow (1-2 days)' : l._days <= 7 ? 'Orange (3-7 days)' : 'Red (8+ days)',
        }))
    );
  };

  const exportLocationWiseStock = (groupField) => {
    const rollup = {};
    putawayLines.forEach((l) => {
      (l.allocations || []).forEach((a) => {
        const parts = String(a.locationCode || '').split('-');
        const key = groupField === 'rack' ? parts[0] : groupField === 'shelf' ? parts[1] : groupField === 'bin' ? parts[2] : a.locationCode;
        if (!key) return;
        rollup[key] = (rollup[key] || 0) + Number(a.qty || 0);
      });
    });
    download(
      `${groupField}_wise_stock.xlsx`,
      Object.entries(rollup).map(([key, qty]) => ({ [groupField === 'location' ? 'Location Code' : groupField.charAt(0).toUpperCase() + groupField.slice(1)]: key, Quantity: qty }))
    );
  };

  // --- Brand / master-catalogue reports ---

  const brands = useMemo(() => Array.from(new Set(items.map((it) => it.brand).filter(Boolean))).sort(), [items]);

  const exportBrandWise = () => {
    download(
      'brand_wise_inventory.xlsx',
      items.map((it) => ({
        Brand: it.brand || 'Unassigned',
        'Part Number': it.partNumber || it.partCode || '',
        Particulars: it.particulars,
        Category: it.category || '',
        'Current Stock': it.currentStock,
        Status: computeStockStatus(it),
        ...(canSeeValue ? { 'Stock Value': Number(it.currentStock || 0) * Number(it.avgCost || it.purchaseCost || 0) } : {}),
      }))
    );
  };

  const exportByStatus = (status, filename) => {
    download(
      filename,
      items
        .filter((it) => computeStockStatus(it) === status)
        .map((it) => ({
          Brand: it.brand || 'Unassigned',
          'Part Number': it.partNumber || it.partCode || '',
          Particulars: it.particulars,
          'Current Stock': it.currentStock,
          'Reorder Level': it.reorderLevel,
          Status: status,
        }))
    );
  };

  const exportCurrentStockReport = () => {
    download(
      'current_stock_report.xlsx',
      items.map((it) => ({
        Brand: it.brand || 'Unassigned',
        'Part Number': it.partNumber || it.partCode || '',
        Particulars: it.particulars,
        'Current Stock': it.currentStock,
        'Reorder Level': it.reorderLevel,
        Status: computeStockStatus(it),
      }))
    );
  };

  const exportInventoryValuation = () => {
    download(
      'inventory_valuation.xlsx',
      items.map((it) => ({
        Brand: it.brand || 'Unassigned',
        'Part Number': it.partNumber || it.partCode || '',
        Particulars: it.particulars,
        'Current Stock': it.currentStock,
        'Avg / Purchase Cost': it.avgCost || it.purchaseCost || 0,
        'Stock Value': Number(it.currentStock || 0) * Number(it.avgCost || it.purchaseCost || 0),
      }))
    );
  };

  const movementFrequency = useMemo(() => {
    const now = Date.now();
    const days90 = now - 90 * 24 * 60 * 60 * 1000;
    const days180 = now - 180 * 24 * 60 * 60 * 1000;
    const freq = {};
    const lastOut = {};
    transactions.forEach((t) => {
      if (t.direction !== 'out') return;
      const d = toDate(t.createdAt);
      if (!d) return;
      freq[t.itemId] = freq[t.itemId] || { last90: 0, lastMovement: 0 };
      if (d.getTime() >= days90) freq[t.itemId].last90 += 1;
      if (d.getTime() > (lastOut[t.itemId] || 0)) lastOut[t.itemId] = d.getTime();
    });
    return { freq, lastOut, days180 };
  }, [transactions]);

  const exportFastMoving = () => {
    const rows = items
      .filter((it) => (movementFrequency.freq[it.id]?.last90 || 0) >= 5)
      .map((it) => ({ Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Out-movements (90d)': movementFrequency.freq[it.id]?.last90 || 0, 'Current Stock': it.currentStock }));
    download('fast_moving_spares.xlsx', rows);
  };

  const exportSlowMoving = () => {
    const rows = items
      .filter((it) => {
        const c = movementFrequency.freq[it.id]?.last90 || 0;
        return c >= 1 && c < 5;
      })
      .map((it) => ({ Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Out-movements (90d)': movementFrequency.freq[it.id]?.last90 || 0, 'Current Stock': it.currentStock }));
    download('slow_moving_spares.xlsx', rows);
  };

  const exportDeadStock = () => {
    const rows = items
      .filter((it) => {
        if (Number(it.currentStock || 0) <= 0) return false;
        const last = movementFrequency.lastOut[it.id] || 0;
        return last === 0 || last < movementFrequency.days180;
      })
      .map((it) => ({
        Brand: it.brand || '',
        'Part Number': it.partNumber || it.partCode || '',
        Particulars: it.particulars,
        'Current Stock': it.currentStock,
        'Last Issued': movementFrequency.lastOut[it.id] ? new Date(movementFrequency.lastOut[it.id]).toLocaleDateString() : 'Never',
      }));
    download('dead_stock.xlsx', rows);
  };

  const exportMachineWise = () => {
    const rows = [];
    items.forEach((it) => {
      const models = String(it.machineModels || '').split(',').map((m) => m.trim()).filter(Boolean);
      if (models.length === 0) {
        rows.push({ 'Machine Model': '(unspecified)', Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Current Stock': it.currentStock });
      } else {
        models.forEach((m) => rows.push({ 'Machine Model': m, Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Current Stock': it.currentStock }));
      }
    });
    download('machine_wise_spares.xlsx', rows);
  };

  const exportSupplierWise = () => {
    download(
      'supplier_wise_spares.xlsx',
      items
        .filter((it) => it.supplier)
        .map((it) => ({ Supplier: it.supplier, Brand: it.brand || '', 'Part Number': it.partNumber || it.partCode || '', Particulars: it.particulars, 'Current Stock': it.currentStock }))
    );
  };

  const exportReorderReport = () => {
    download(
      'reorder_report.xlsx',
      items
        .filter((it) => computeStockStatus(it) === 'Low Stock' || computeStockStatus(it) === 'Out of Stock')
        .map((it) => {
          const target = Number(it.maxStock) > 0 ? Number(it.maxStock) : Number(it.reorderLevel) * 2;
          const suggested = Math.max(0, target - Number(it.currentStock || 0));
          return {
            Brand: it.brand || '',
            'Part Number': it.partNumber || it.partCode || '',
            Particulars: it.particulars,
            Supplier: it.supplier || '',
            'Current Stock': it.currentStock,
            'Reorder Level': it.reorderLevel,
            'Suggested Reorder Qty': suggested,
          };
        })
    );
  };

  const exportOldNewPartNumbers = () => {
    download(
      'old_new_part_number_crossref.xlsx',
      items
        .filter((it) => (it.oldPartNumbers || []).length > 0)
        .map((it) => ({
          Brand: it.brand || '',
          'New Part Number': it.partNumber || it.partCode || '',
          'Old Part Number(s)': (it.oldPartNumbers || []).join(', '),
          Particulars: it.particulars,
          'Current Stock': it.currentStock,
        }))
    );
  };

  // --- Engineer issue/return/consumption reports ---

  const exportEngineerIssues = () => {
    const rows = [];
    engineerIssues.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      'Service Job': doc.serviceJobNo, Engineer: doc.engineerName, Customer: doc.customerName, Date: doc.date,
      'Part Number': it.partNumber, Description: it.description, 'Qty Issued': it.qtyIssued,
    })));
    download('engineer_wise_issue.xlsx', rows);
  };

  const exportEngineerReturns = () => {
    const rows = [];
    engineerReturns.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      'Service Job': doc.serviceJobNo, Engineer: doc.engineerName, 'Return Date': doc.returnDate,
      'Part Number': it.partNumber, 'Qty Returned': it.qtyReturned, Condition: it.condition,
    })));
    download('engineer_wise_return.xlsx', rows);
  };

  const exportConsumptionByEngineer = () => {
    const byEngineer = {};
    engineerIssues.forEach((doc) => {
      const jobKey = doc.serviceJobNo;
      sparePartsUsed.filter((u) => u.serviceJobNo === jobKey).forEach((u) => {
        (u.items || []).forEach((it) => {
          byEngineer[doc.engineerName] = byEngineer[doc.engineerName] || 0;
          byEngineer[doc.engineerName] += Number(it.qtyUsed || 0);
        });
      });
    });
    download('consumption_by_engineer.xlsx', Object.entries(byEngineer).map(([engineer, qty]) => ({ Engineer: engineer, 'Total Qty Consumed': qty })));
  };

  const exportCustomerWiseUsage = () => {
    const rows = [];
    sparePartsUsed.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      Customer: doc.customerName, 'Machine Model': doc.machineModel, 'Serial No': doc.serialNumber,
      'Service Job': doc.serviceJobNo, 'Part Number': it.partNumber, 'Qty Used': it.qtyUsed,
      'Warranty/Chargeable': it.warrantyOrChargeable, Remarks: it.remarks,
    })));
    download('customer_wise_spare_usage.xlsx', rows);
  };

  const exportJobWiseUsage = () => {
    const rows = [];
    sparePartsUsed.forEach((doc) => (doc.items || []).forEach((it) => rows.push({
      'Service Job': doc.serviceJobNo, Customer: doc.customerName, 'Part Number': it.partNumber,
      Description: it.description, 'Qty Used': it.qtyUsed, 'Warranty/Chargeable': it.warrantyOrChargeable,
    })));
    download('service_job_wise_spare_usage.xlsx', rows);
  };

  const exportPendingWithEngineers = () => {
    const key = (e, j, p) => `${e}||${j}||${p}`;
    const map = new Map();
    engineerIssues.forEach((doc) => (doc.items || []).forEach((it) => {
      const k = key(doc.engineerName, doc.serviceJobNo, it.partNumber);
      const r = map.get(k) || { engineer: doc.engineerName, job: doc.serviceJobNo, partNumber: it.partNumber, description: it.description, issued: 0, returned: 0, used: 0 };
      r.issued += Number(it.qtyIssued || 0);
      map.set(k, r);
    }));
    engineerReturns.forEach((doc) => (doc.items || []).forEach((it) => {
      const k = key(doc.engineerName, doc.serviceJobNo, it.partNumber);
      const r = map.get(k) || { engineer: doc.engineerName, job: doc.serviceJobNo, partNumber: it.partNumber, description: '', issued: 0, returned: 0, used: 0 };
      r.returned += Number(it.qtyReturned || 0);
      map.set(k, r);
    }));
    sparePartsUsed.forEach((doc) => {
      const relatedIssue = engineerIssues.find((i) => i.serviceJobNo === doc.serviceJobNo);
      const engineer = relatedIssue ? relatedIssue.engineerName : '(unlinked job)';
      (doc.items || []).forEach((it) => {
        const k = key(engineer, doc.serviceJobNo, it.partNumber);
        const r = map.get(k) || { engineer, job: doc.serviceJobNo, partNumber: it.partNumber, description: it.description, issued: 0, returned: 0, used: 0 };
        r.used += Number(it.qtyUsed || 0);
        map.set(k, r);
      });
    });
    const rows = Array.from(map.values())
      .map((r) => ({ ...r, balance: r.issued - r.returned - r.used }))
      .filter((r) => r.balance > 0)
      .map((r) => ({ Engineer: r.engineer, 'Service Job': r.job, 'Part Number': r.partNumber, Description: r.description, Issued: r.issued, Returned: r.returned, Used: r.used, 'Pending with Engineer': r.balance }));
    download('pending_spare_parts_with_engineers.xlsx', rows);
  };

  const exportLostDamaged = () => {
    const rows = [];
    engineerReturns.forEach((doc) => (doc.items || []).forEach((it) => {
      if (it.condition === 'Damaged') {
        rows.push({ 'Service Job': doc.serviceJobNo, Engineer: doc.engineerName, 'Return Date': doc.returnDate, 'Part Number': it.partNumber, Quantity: it.qtyReturned, Condition: it.condition });
      }
    }));
    download('lost_or_damaged_spare_parts.xlsx', rows);
  };

  const exportMonthlyConsumption = () => {
    const byMonth = {};
    sparePartsUsed.forEach((doc) => {
      const d = toDate(doc.createdAt);
      const key = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : 'unknown';
      (doc.items || []).forEach((it) => {
        byMonth[key] = (byMonth[key] || 0) + Number(it.qtyUsed || 0);
      });
    });
    download('monthly_spare_parts_consumption.xlsx', Object.entries(byMonth).sort().map(([month, qty]) => ({ Month: month, 'Total Qty Consumed': qty })));
  };

  const exportEngineerAuditTrail = () => {
    const rows = transactions
      .filter((t) => ['engineerIssue', 'engineerReturn', 'consumption'].includes(t.type))
      .map((t) => ({
        'Date & Time': toDate(t.createdAt)?.toLocaleString() || '',
        User: t.performedByEmail,
        Engineer: t.engineer || '',
        'Transaction Type': t.type,
        'Part Number': t.itemName,
        Quantity: t.quantity,
        'Balance Stock': t.balanceAfter ?? '',
        Remarks: t.reason,
      }));
    download('spare_parts_audit_trail.xlsx', rows);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="text-emerald-700" size={28} />
        <h1 className="text-3xl font-bold text-gray-800">Reports</h1>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Quick Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton label="Stock Summary" onClick={exportStockSummary} />
          <ReportButton label="Low / Critical Stock" onClick={exportLowStock} />
          <ReportButton label="Purchases Only" onClick={() => exportMovements('purchase')} />
          <ReportButton label="Issues Only" onClick={() => exportMovements('issue')} />
          <ReportButton label="All Transactions (raw)" onClick={() => exportMovements(null)} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Brand &amp; Master Catalogue Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton label="Brand-wise Inventory" onClick={exportBrandWise} />
          <ReportButton label="Current Stock Report" onClick={exportCurrentStockReport} />
          <ReportButton label="Low Stock Report" onClick={() => exportByStatus('Low Stock', 'low_stock_report.xlsx')} />
          <ReportButton label="Out-of-Stock Report" onClick={() => exportByStatus('Out of Stock', 'out_of_stock_report.xlsx')} />
          <ReportButton label="Not Stocked Parts" onClick={() => exportByStatus('Not Stocked', 'not_stocked_parts.xlsx')} />
          <ReportButton label="Inventory Valuation" onClick={exportInventoryValuation} />
          <ReportButton label="Fast Moving Spares" onClick={exportFastMoving} />
          <ReportButton label="Slow Moving Spares" onClick={exportSlowMoving} />
          <ReportButton label="Dead Stock" onClick={exportDeadStock} />
          <ReportButton label="Machine-wise Spare Parts" onClick={exportMachineWise} />
          <ReportButton label="Supplier-wise Spare Parts" onClick={exportSupplierWise} />
          <ReportButton label="Reorder Report" onClick={exportReorderReport} />
          <ReportButton label="Old ↔ New Part Number Cross-ref" onClick={exportOldNewPartNumbers} />
        </div>
        {brands.length > 0 && <p className="text-xs text-gray-400">Brands in system: {brands.join(', ')}</p>}
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Engineer Issue &amp; Return Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton label="Engineer-wise Issue" onClick={exportEngineerIssues} />
          <ReportButton label="Engineer-wise Return" onClick={exportEngineerReturns} />
          <ReportButton label="Consumption by Engineer" onClick={exportConsumptionByEngineer} />
          <ReportButton label="Customer-wise Usage" onClick={exportCustomerWiseUsage} />
          <ReportButton label="Service Job-wise Usage" onClick={exportJobWiseUsage} />
          <ReportButton label="Pending with Engineers" onClick={exportPendingWithEngineers} />
          <ReportButton label="Lost / Damaged Parts" onClick={exportLostDamaged} />
          <ReportButton label="Monthly Consumption" onClick={exportMonthlyConsumption} />
          <ReportButton label="Spare Parts Audit Trail" onClick={exportEngineerAuditTrail} />
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Warehouse Put-away Reports</h2>
        <div className="flex flex-wrap gap-3">
          <ReportButton label="Put-away Report" onClick={exportPutawayReport} />
          <ReportButton label="Pending Location Report" onClick={exportPendingLocationReport} />
          <ReportButton label="Completed Location Report" onClick={exportCompletedLocationReport} />
          <ReportButton label="Ageing Report" onClick={exportAgeingReport} />
          <ReportButton label="Location-wise Stock" onClick={() => exportLocationWiseStock('location')} />
          <ReportButton label="Rack-wise Stock" onClick={() => exportLocationWiseStock('rack')} />
          <ReportButton label="Shelf-wise Stock" onClick={() => exportLocationWiseStock('shelf')} />
          <ReportButton label="Bin-wise Stock" onClick={() => exportLocationWiseStock('bin')} />
        </div>
        <p className="text-xs text-gray-400">
          For full Location History (every location change with user/date/time), see Warehouse Put-away &rarr;
          Location History in the left menu.
        </p>
      </div>

      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-800">Date-Range Movement Report</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <ReportButton label="Export Range" onClick={() => exportMovements(null)} />
        </div>

        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Item</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Type</th>
                <th className="text-right px-3 py-2 font-semibold text-gray-600">Qty</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">Reason</th>
                <th className="text-left px-3 py-2 font-semibold text-gray-600">By</th>
              </tr>
            </thead>
            <tbody>
              {filteredTxns.slice(0, 50).map((t) => (
                <tr key={t.id} className="border-b last:border-0">
                  <td className="px-3 py-2">{toDate(t.createdAt)?.toLocaleString() || ''}</td>
                  <td className="px-3 py-2">{t.itemName}</td>
                  <td className="px-3 py-2 capitalize">{t.type} ({t.direction})</td>
                  <td className="px-3 py-2 text-right">{t.quantity}</td>
                  <td className="px-3 py-2">{t.reason}</td>
                  <td className="px-3 py-2">{t.performedByEmail}</td>
                </tr>
              ))}
              {filteredTxns.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-400">No transactions in range.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReportButton({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 border border-emerald-700 text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-lg text-sm"
    >
      <Download size={16} /> {label}
    </button>
  );
}
