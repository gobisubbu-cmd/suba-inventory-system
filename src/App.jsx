import React, { useState, useEffect } from 'react';
import { auth, db } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import Login from './components/Login';
import Navigation from './components/Navigation';
import Dashboard from './components/Dashboard';
import ManageItems from './components/ManageItems';
import ImportData from './components/ImportData';
import StockAdjustment from './components/StockAdjustment';
import Reports from './components/Reports';
import InventoryValuation from './components/InventoryValuation';
import ManageUsers from './components/ManageUsers';
import DangerZone from './components/DangerZone';
import ChangePassword from './components/ChangePassword';
import './index.css';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentView, setCurrentView] = useState('dashboard');
  const [userRole, setUserRole] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
          if (userDoc.exists()) {
            setUserRole(userDoc.data().role);
          } else {
            setUserRole('staff');
          }
        } catch (error) {
          console.error('Error fetching user role:', error);
          setUserRole('staff');
        }
      } else {
        setUser(null);
        setUserRole(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-emerald-600"></div>
          <p className="mt-4 text-gray-600">Loading SUBA Stock Management...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  const renderView = () => {
    switch (currentView) {
      case 'dashboard':
        return <Dashboard userRole={userRole} />;
      case 'items':
        return <ManageItems userRole={userRole} />;
      case 'import':
        return <ImportData userRole={userRole} />;
      case 'adjustment':
        return <StockAdjustment userRole={userRole} userEmail={user.email} />;
      case 'reports':
        return <Reports userRole={userRole} />;
      case 'valuation':
        return <InventoryValuation userRole={userRole} />;
      case 'users':
        return <ManageUsers userRole={userRole} />;
      case 'danger':
        return <DangerZone userRole={userRole} />;
      case 'changepassword':
        return <ChangePassword />;
      default:
        return <Dashboard userRole={userRole} />;
    }
  };

  return (
    <div className="flex h-screen bg-gray-100">
      <Navigation
        currentView={currentView}
        onViewChange={setCurrentView}
        userRole={userRole}
        userName={user.email}
      />
      <main className="flex-1 overflow-auto">
        <div className="p-6">{renderView()}</div>
      </main>
    </div>
  );
}
