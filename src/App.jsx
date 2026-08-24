import React, { useState, useEffect } from 'react';
import { Home } from 'lucide-react';
import { auth, db } from './firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import Login from './components/Login';
import Navigation from './components/Navigation';
import Dashboard from './components/Dashboard';
import Overview from './components/Overview';
import ReorderItems from './components/ReorderItems';
import ManageItems from './components/ManageItems';
import ImportData from './components/ImportData';
import StockAdjustment from './components/StockAdjustment';
import Reports from './components/Reports';
import InventoryValuation from './components/InventoryValuation';
import ManageUsers from './components/ManageUsers';
import DangerZone from './components/DangerZone';
import ChangePassword from './components/ChangePassword';
import SpareSearch from './components/SpareSearch';
import AuditDashboard from './components/AuditDashboard';
import SearchLogs from './components/SearchLogs';
import Settings from './components/Settings';
import Warehouse from './components/Warehouse';
import LocationMaster from './components/LocationMaster';
import PutawayAlertPopup from './components/PutawayAlertPopup';
import Brands from './components/Brands';
import EngineerIssueReturn from './components/EngineerIssueReturn';
import FieldMode from './components/FieldMode';
import MobileQuickScan from './components/MobileQuickScan';
import MobileEngineerIssue from './components/MobileEngineerIssue';
import ActivityLog from './components/ActivityLog';
import { runDailyBackupIfNeeded } from './backup';
import './index.css';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // Phones (and small tablets in portrait) land straight in Field Mode —
  // the desktop shell below (fixed sidebar + dense pages) was never built
  // with a mobile breakpoint, so showing it on a small screen just means a
  // squeezed, hard-to-use desktop layout. This check runs once on mount;
  // it does not re-run on resize/rotation, so a user who explicitly exits
  // Field Mode (or a tablet user who rotates to landscape) can still reach
  // the full desktop app if they need it.
  const [currentView, setCurrentView] = useState(() =>
    (typeof window !== 'undefined' && window.innerWidth <= 768) ? 'field' : 'dashboard'
  );
  const [userRole, setUserRole] = useState(null);
  // Set when a brand name is clicked on the Brands page — carries a
  // "brand::timestamp" token so Dashboard's effect fires even if the same
  // brand is clicked twice in a row. See goToDashboardFiltered below.
  const [dashboardBrandFilter, setDashboardBrandFilter] = useState(null);

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

  // Daily stock safety-backup — RE-ENABLED.
  // Earlier testing saw this hang indefinitely (reported as batch.commit()
  // never resolving/rejecting). Root cause fix: the READ step (getDocs) had
  // no timeout at all, unlike the write step which already raced against a
  // 15s timeout — so a stall there could hang forever with nothing able to
  // catch it. The read is now timeout-protected the same way (20s), so
  // every async step in the backup is bounded and will fail loudly instead
  // of hanging, even for collections that error out. It's also still fully
  // non-blocking (this effect never touches `loading`) and wrapped in its
  // own try/catch, so worst case is a failed backup, never a broken app.
  // To verify a run actually completed, check window.__backupDebug.status
  // in the browser console — it should progress through
  // fetching-<collection>/writing-<collection>-... and land on 'success'.
  useEffect(() => {
    if (user) {
      runDailyBackupIfNeeded();
    }
  }, [user]);

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

  // Every page renders inside <main> below; this one button gives every
  // page — without touching each one individually — a way to bail out of
  // whatever's on screen (an unfinished import, a half-filled form, etc.)
  // and land back on the Dashboard. Switching currentView unmounts the
  // current page's component, which discards its local unsaved state, so
  // this doubles as "cancel" and "back to dashboard" in one click.
  const goToDashboard = () => {
    if (currentView === 'dashboard') return;
    if (window.confirm('Cancel what you\'re doing on this page and go back to the Dashboard? Anything not yet saved will be lost.')) {
      setCurrentView('dashboard');
    }
  };

  // Clicking a brand name on the Brands page jumps straight to the
  // Dashboard, pre-filtered to that brand's stock — no confirm prompt since
  // nothing on the Brands page can be "unsaved".
  const goToDashboardFiltered = (brand) => {
    setDashboardBrandFilter(`${brand}::${Date.now()}`);
    setCurrentView('dashboard');
  };

  // Field Mode and its two sub-screens are a deliberately separate,
  // full-screen mobile experience — no desktop sidebar, no p-6 desktop
  // padding, no floating "Dashboard" button (each screen has its own
  // back/exit control). Handled before the normal Navigation+main shell
  // below rather than inside renderView, since they replace that whole
  // shell rather than filling the <main> slot within it.
  if (currentView === 'field') {
    return (
      <FieldMode
        userRole={userRole}
        onOpenScan={() => setCurrentView('mobileScan')}
        onOpenEngineer={() => setCurrentView('mobileEngineer')}
        onExit={() => setCurrentView('dashboard')}
      />
    );
  }
  if (currentView === 'mobileScan') {
    return (
      <MobileQuickScan
        userRole={userRole}
        userEmail={user.email}
        onExit={() => setCurrentView('field')}
      />
    );
  }
  if (currentView === 'mobileEngineer') {
    return (
      <MobileEngineerIssue
        userEmail={user.email}
        onExit={() => setCurrentView('field')}
      />
    );
  }

  const renderView = () => {
    switch (currentView) {
      case 'dashboard':
        return <Dashboard userRole={userRole} userEmail={user.email} initialBrandFilter={dashboardBrandFilter} />;
      case 'overview':
        return <Overview userRole={userRole} onViewChange={setCurrentView} onSelectBrand={goToDashboardFiltered} />;
      case 'reorder':
        return <ReorderItems userRole={userRole} />;
      case 'brands':
        return <Brands userRole={userRole} onSelectBrand={goToDashboardFiltered} />;
      case 'items':
        return <ManageItems userRole={userRole} />;
      case 'engineers':
        return <EngineerIssueReturn userRole={userRole} userEmail={user.email} />;
      case 'import':
        return <ImportData userRole={userRole} userEmail={user.email} />;
      case 'adjustment':
        return <StockAdjustment userRole={userRole} userEmail={user.email} />;
      case 'reports':
        return <Reports userRole={userRole} userEmail={user.email} />;
      case 'valuation':
        return <InventoryValuation userRole={userRole} />;
      case 'sparesearch':
        return <SpareSearch userRole={userRole} userEmail={user.email} />;
      case 'audit':
        return <AuditDashboard userRole={userRole} userEmail={user.email} />;
      case 'users':
        return <ManageUsers userRole={userRole} />;
      case 'searchlogs':
        return <SearchLogs userRole={userRole} />;
      case 'activity':
        return <ActivityLog userRole={userRole} userEmail={user.email} />;
      case 'settings':
        return <Settings userRole={userRole} />;
      case 'warehouse':
        return <Warehouse userRole={userRole} userEmail={user.email} />;
      case 'locations':
        return <LocationMaster userRole={userRole} />;
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
      <main className="flex-1 overflow-auto relative">
        {currentView !== 'dashboard' && (
          <button
            onClick={goToDashboard}
            title="Cancel and back to Dashboard"
            className="fixed top-4 right-6 z-40 flex items-center gap-2 bg-white shadow-lg border border-gray-200 hover:bg-red-50 hover:border-red-300 hover:text-red-600 text-gray-600 pl-3 pr-4 py-2 rounded-full transition"
          >
            <Home size={18} />
            <span className="text-sm font-medium">Dashboard</span>
          </button>
        )}
        <div className="p-6">{renderView()}</div>
      </main>
      <PutawayAlertPopup userRole={userRole} onViewReport={() => setCurrentView('warehouse')} />
    </div>
  );
}
