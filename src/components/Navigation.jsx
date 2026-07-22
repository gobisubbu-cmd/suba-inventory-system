import React from 'react';
import { signOut } from 'firebase/auth';
import { auth } from '../firebase';
import { LogOut, Home, Boxes, SlidersHorizontal, BarChart3, Wallet, Users, KeyRound, AlertTriangle, ScanLine } from 'lucide-react';

const ROLE_LABELS = {
  staff: 'STAFF',
  inventory_manager: 'INVENTORY MANAGER',
  admin: 'ADMIN',
};

export default function Navigation({ currentView, onViewChange, userRole, userName }) {
  const handleLogout = async () => {
    await signOut(auth);
  };

  const menuItems = [
    { id: 'dashboard', label: 'Dashboard', icon: Home, show: true },
    { id: 'items', label: 'Manage Items', icon: Boxes, show: userRole === 'admin' || userRole === 'inventory_manager' },
    { id: 'import', label: 'Import Data', icon: ScanLine, show: userRole === 'admin' || userRole === 'inventory_manager' },
    { id: 'adjustment', label: 'Stock Adjustment', icon: SlidersHorizontal, show: userRole === 'admin' },
    { id: 'reports', label: 'Reports', icon: BarChart3, show: true },
    { id: 'valuation', label: 'Inventory Valuation', icon: Wallet, show: userRole === 'admin' || userRole === 'inventory_manager' },
    { id: 'users', label: 'Manage Users', icon: Users, show: userRole === 'admin' },
    { id: 'danger', label: 'Danger Zone', icon: AlertTriangle, show: userRole === 'admin' },
  ];

  return (
    <aside className="w-64 bg-gradient-to-b from-emerald-900 to-emerald-800 text-white shadow-lg h-screen flex flex-col">
      <div className="p-6 border-b border-emerald-700">
        <h2 className="text-2xl font-bold">SUBA Stock</h2>
        <p className="text-emerald-200 text-sm mt-1">{ROLE_LABELS[userRole] || ''}</p>
      </div>

      <nav className="flex-1 overflow-y-auto p-4 space-y-2">
        {menuItems.map((item) => {
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
