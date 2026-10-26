import React from 'react';
import { Route, Navigate, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { ServerNameProvider } from './ServerNameContext';
import { UserListPanelProvider } from './UserListPanelContext';
import { ToastProvider } from './ToastContext';
import Layout from './Layout';
import Login from './pages/Login';
import Register from './pages/Register';
import Chat from './pages/Chat';
import Profile from './pages/Profile';
import Settings from './pages/Settings';
import Admin from './pages/Admin';
import VerificationWaiting from './pages/VerificationWaiting';
import AccountDeleted from './pages/AccountDeleted';
import AccountRejected from './pages/AccountRejected';
import InternalServerError from './pages/InternalServerError';
import Forbidden from './pages/Forbidden';
import ConnectionError from './pages/ConnectionError';

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading-center">Загрузка…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const PublicOnlyRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();

  if (loading) return <div className="app-loading-center">Загрузка…</div>;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
};

function VerificationCheckRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading-center">Загрузка…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.verified) return <VerificationWaiting />;
  return <>{children}</>;
}

/** Участники без прав модерации не видят админку (403). */
function AdminRoleGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading-center">Загрузка…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'member') return <Navigate to="/403" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <Login />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnlyRoute>
            <Register />
          </PublicOnlyRoute>
        }
      />
      <Route path="/account-deleted" element={<AccountDeleted />} />
      <Route path="/account-rejected" element={<AccountRejected />} />
      <Route path="/500" element={<InternalServerError />} />
      <Route path="/403" element={<Forbidden />} />
      <Route path="/connection-error" element={<ConnectionError />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <Layout />
          </PrivateRoute>
        }
      >
        <Route index element={<Navigate to="/chat" replace />} />
        <Route
          path="chat"
          element={
            <VerificationCheckRoute>
              <Chat />
            </VerificationCheckRoute>
          }
        />
        <Route
          path="chat/:roomId"
          element={
            <VerificationCheckRoute>
              <Chat />
            </VerificationCheckRoute>
          }
        />
        <Route path="profile" element={<Profile />} />
        <Route path="settings" element={<Settings />} />
        <Route
          path="admin"
          element={
            <VerificationCheckRoute>
              <AdminRoleGate>
                <Admin />
              </AdminRoleGate>
            </VerificationCheckRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ServerNameProvider>
        <UserListPanelProvider>
          <ToastProvider>
            <AppRoutes />
          </ToastProvider>
        </UserListPanelProvider>
      </ServerNameProvider>
    </AuthProvider>
  );
}
