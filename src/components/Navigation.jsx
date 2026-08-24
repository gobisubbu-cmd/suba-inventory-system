import React, { useState, useEffect } from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { LogOut, Home, LayoutDashboard, Boxes, SlidersHorizontal, BarChart3, Wallet, Users, KeyRound, AlertTriangle, ScanLine, PackageSearch, ClipboardList, ShieldCheck, SearchCheck, Settings as SettingsIcon, PackageCheck, Warehouse, Tag, HardHat, Smartphone, Database, ChevronDown, ChevronRight, History, FileDown, Receipt } from 'lucide-react';

const ROLE_LABELS = {
  staff: 'STAFF',
  inventory_manager: 'INVENTORY MANAGER',
  admin: 'ADMIN',
};

export default function Navigation({ currentView, onViewChange, userRole, userName, exportBrands }) {
  const handleLogout = async () => {
    await signOut(auth);
  };

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: Home, show: true },
    { id: 'overview', label: 'Overview', icon: LayoutDashboard, show: true },
    { id: 'reorder', label: 'Reorder Items', icon: ClipboardList, show: true },
    // Staff also get Import Data now — but only the "Record Purchase /
    // Issue / DC" (inward/outward) mode inside it; the master-catalogue and
    // bulk-update modes stay admin/inventory-manager only (see ImportData.jsx).
    { id: 'import', label: 'Import Data', icon: ScanLine, show: userRole === 'admin' || userRole === 'inventory_manager' || userRole === 'staff' },
    // Standalone money ledger for service/handling charges billed when no
    // specific spare was advised — never touches stock. Same access as
    // Import Data since staff are the ones raising these out in the field.
    { id: 'servicecharges', label: 'Service Charges', icon: Receipt, show: userRole === 'admin' || userRole === 'inventory_manager' || userRole === 'staff' },
    { id: 'engineers', label: 'Engineer Issue/Return', icon: HardHat, show: true },
    { id: 'warehouse', label: 'Warehouse Put-away', icon: PackageCheck, show: true },
    { id: 'adjustment', label: 'Stock Adjustment', icon: SlidersHorizontal, show: userRole === 'admin' },
    { id: 'sparesearch', label: 'Spare Search', icon: PackageSearch, show: true },
    { id: 'audit', label: 'Audit Dashboard', icon: ShieldCheck, show: userRole === 'admin' },
    { id: 'reports', label: 'Reports', icon: BarChart3, show: true },
    { id: 'valuation', label: 'Inventory Valuation', icon: Wallet, show: userRole === 'admin' || userRole === 'inventory_manager' },
    { id: 'users', label: 'Manage Users', icon: Users, show: userRole === 'admin' },
    // Special permission: appears only for admins and for users the admin
    // has granted brand-limited stock export rights (exportBrands on the
    // user's doc, managed from Manage Users).
    { id: 'stockexport', label: 'Stock Export', icon: FileDown, show: userRole === 'admin' || (exportBrands && exportBrands.length > 0) },
    // Everyone can open the Activity Log: admin sees all users' actions
    // with a per-user filter, everyone else sees only their own trail.
    { id: 'activity', label: 'Activity Log', icon: History, show: true },
    { id: 'searchlogs', label: 'Search Logs', icon: SearchCheck, show: userRole === 'admin' },
    { id: 'settings', label: 'Settings', icon: SettingsIcon, show: userRole === 'admin' },
    { id: 'danger', label: 'Danger Zone', icon: AlertTriangle, show: userRole === 'admin' },
  ];

  // "Master Data" is its own collapsible group rather than flat menu items —
  // these three pages (Items, Brands, Locations) are the catalogue/reference
  // data that everything else in the app (stock, reports, put-away) is built
  // on top of, so grouping them together makes that relationship obvious and
  // keeps the top-level menu shorter.
  const masterDataItems = [
    { id: 'items', label: 'Manage Items', icon: Boxes, show: userRole === 'admin' || userRole === 'inventory_manager' },
    { id: 'brands', label: 'Brands', icon: Tag, show: true },
    { id: 'locations', label: 'Location Master', icon: Warehouse, show: userRole === 'admin' || userRole === 'inventory_manager' },
  ].filter((item) => item.show);

  const isMasterDataActive = masterDataItems.some((item) => item.id === currentView);
  const [masterDataOpen, setMasterDataOpen] = useState(isMasterDataActive);

  // Auto-expand the group whenever navigation lands on one of its pages
  // (e.g. a direct view-change from elsewhere in the app), without fighting
  // a user who deliberately collapsed it while sitting on a different page.
  useEffect(() => {
    if (isMasterDataActive) setMasterDataOpen(true);
  }, [isMasterDataActive]);

  return (
    <aside className="w-64 bg-gradient-to-b from-emerald-900 to-emerald-800 text-white shadow-lg h-screen flex flex-col">
      <div className="p-6 border-b border-emerald-700">
        <h2 className="text-2xl font-bold">SUBA Stock</h2>
        <p className="text-emerald-200 text-sm mt-1">{ROLE_LABELS[userRole] || ''}</p>
      </div>

      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
        <button
          onClick={() => onViewChange('field')}
          title="Phone-friendly Quick Scan, Engineer Issue/Return, and stock lookup"
          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-emerald-950 font-semibold transition mb-2"
        >
          <Smartphone size={20} />
          <span>Field Mode</span>
        </button>
        {menuItems.filter((item) => ['dashboard', 'overview', 'reorder'].includes(item.id)).map((item) => {
          if (!item.show) return null;
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition ${
                isActive ? 'bg-emerald-600 text-white' : 'text-emerald-100 hover:bg-emerald-700'
              }`}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}

        {masterDataItems.length > 0 && (
          <div>
            <button
              onClick={() => setMasterDataOpen((open) => !open)}
              aria-expanded={masterDataOpen}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition ${
                isMasterDataActive && !masterDataOpen ? 'bg-emerald-600 text-white' : 'text-emerald-100 hover:bg-emerald-700'
              }`}
            >
              <Database size={20} />
              <span className="flex-1 text-left">Master Data</span>
              {masterDataOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {masterDataOpen && (
              <div className="mt-1 space-y-1 pl-4 border-l border-emerald-700 ml-5">
                {masterDataItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = currentView === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => onViewChange(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                        isActive ? 'bg-emerald-600 text-white' : 'text-emerald-100 hover:bg-emerald-700'
                      }`}
                    >
                      <Icon size={16} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {menuItems.filter((item) => !['dashboard', 'overview', 'reorder'].includes(item.id)).map((item) => {
          if (!item.show) return null;
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition ${
                isActive ? 'bg-emerald-600 text-white' : 'text-emerald-100 hover:bg-emerald-700'
              }`}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 border-t border-emerald-700 space-y-2">
        <p className="text-emerald-200 text-sm px-4">Logged in as:</p>
        <p className="text-white text-sm font-medium px-4 truncate">{userName}</p>
        <button
          onClick={() => onViewChange('changepassword')}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition ${
            currentView === 'changepassword' ? 'bg-emerald-600 text-white' : 'text-emerald-100 hover:bg-emerald-700'
          }`}
        >
          <KeyRound size={20} />
          <span>Change Password</span>
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3 text-red-200 hover:bg-red-600 hover:text-white rounded-lg transition"
        >
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}
