import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { 
  Users, 
  ShieldAlert, 
  ShieldCheck, 
  UserX,
  UserCheck,
  Search,
  LogOut,
  ChevronLeft,
  KeyRound,
  Trash2
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';

interface AdminUser {
  id: number;
  email: string;
  full_name: string | null;
  is_active: boolean;
  is_superuser: boolean;
}

const AdminDashboard: React.FC = () => {
  const { user, logout } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');

  const fetchUsers = async () => {
    try {
      const response = await api.get('/api/admin/users');
      setUsers(response.data);
    } catch (err) {
      setError('Failed to load users.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const toggleUserStatus = async (targetId: number, field: 'is_active' | 'is_superuser', currentValue: boolean) => {
    try {
      const payload = { [field]: !currentValue };
      await api.put(`/api/admin/users/${targetId}/status`, payload);
      // Optimistic update
      setUsers(users.map(u => u.id === targetId ? { ...u, ...payload } : u));
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to update user status');
    }
  };

  const deleteUser = async (targetId: number) => {
    if (!window.confirm('Are you sure you want to PERMANENTLY delete this user? This action cannot be undone.')) return;
    
    try {
      await api.delete(`/api/admin/users/${targetId}`);
      setUsers(users.filter(u => u.id !== targetId));
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to delete user');
    }
  };

  const changePassword = async (targetId: number) => {
    const newPassword = window.prompt('Enter new password for this user:');
    if (!newPassword) return;
    
    try {
      await api.put(`/api/admin/users/${targetId}/password`, { new_password: newPassword });
      alert('Password changed successfully.');
    } catch (err: any) {
      alert(err.response?.data?.detail || 'Failed to change password');
    }
  };

  const filteredUsers = users.filter(u => 
    u.email.toLowerCase().includes(searchTerm.toLowerCase()) || 
    (u.full_name && u.full_name.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 transition-colors duration-200">
      {/* Top Navbar */}
      <nav className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30 shadow-sm dark:shadow-lg transition-colors duration-200">
        <div className="mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-4">
              <Link to="/dashboard" className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors bg-slate-100 dark:bg-slate-800 p-2 rounded-lg">
                <ChevronLeft className="w-5 h-5" />
              </Link>
              <div className="bg-indigo-600 p-2 rounded-lg">
                <ShieldCheck className="text-white w-5 h-5" />
              </div>
              <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-500 dark:from-indigo-400 to-purple-600 dark:to-purple-400">
                Admin Console
              </span>
            </div>
            
            <div className="flex items-center space-x-4 sm:space-x-6">
              <ThemeToggle />
              <div className="flex flex-col text-right">
                <span className="text-sm font-medium text-slate-900 dark:text-white">{user?.full_name || 'Admin'}</span>
                <span className="text-xs text-indigo-600 dark:text-indigo-400">Superuser</span>
              </div>
              <button
                onClick={logout}
                className="text-slate-500 dark:text-slate-400 hover:text-red-500 dark:hover:text-red-400 p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                title="Sign out"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        
        <div className="flex sm:flex-row flex-col sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">User Management</h1>
            <p className="text-slate-500 dark:text-slate-400 mt-1">Manage accounts, roles, and access across the platform.</p>
          </div>
        </div>

        {error && (
            <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-4 rounded-xl border border-red-100 dark:border-red-500/50 flex items-start">
              <div className="flex-1">{error}</div>
            </div>
        )}

        <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden transition-colors duration-200">
          
          {/* Toolbar */}
          <div className="p-4 border-b border-slate-100 dark:border-slate-700/50 bg-slate-50/50 dark:bg-slate-800/50 flex justify-between items-center transition-colors">
             <div className="relative max-w-sm w-full">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-4 w-4 text-slate-400 dark:text-slate-500" />
              </div>
              <input
                type="text"
                placeholder="Search users by name or email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 px-4 py-2 bg-white dark:bg-slate-900/50 border border-slate-200 dark:border-slate-600 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:focus:ring-indigo-500/50 focus:border-indigo-500 transition-all text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500"
              />
            </div>
            <div className="flex items-center space-x-2 text-sm text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-900/50 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-600 shadow-sm transition-colors">
              <Users className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
              <span className="font-medium text-slate-900 dark:text-white">{filteredUsers.length}</span> Users
            </div>
          </div>

          {/* Data Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-slate-50 dark:bg-slate-800/80 text-slate-500 dark:text-slate-400 font-medium transition-colors">
                <tr>
                  <th className="px-6 py-4">User</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Role</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {filteredUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-700/30 transition-colors group">
                    <td className="px-6 py-4">
                      <div className="flex items-center">
                        <div className="h-10 w-10 rounded-full bg-gradient-to-br from-indigo-100 to-purple-100 dark:from-indigo-900 dark:to-purple-900 flex items-center justify-center text-indigo-700 dark:text-indigo-300 font-semibold ring-2 ring-white dark:ring-slate-800 shadow-sm transition-colors">
                          {u.full_name ? u.full_name.charAt(0).toUpperCase() : u.email.charAt(0).toUpperCase()}
                        </div>
                        <div className="ml-4">
                          <div className="font-medium text-slate-900 dark:text-white">{u.full_name || 'No Name Provided'}</div>
                          <div className="text-slate-500 dark:text-slate-400 max-w-[200px] truncate">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {u.is_active ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-500/30 shadow-sm">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5 animate-pulse"></span>
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 shadow-sm">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 mr-1.5"></span>
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {u.is_superuser ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 border border-indigo-200/60 dark:border-indigo-500/30 shadow-sm">
                          <ShieldCheck className="w-3 h-3 mr-1" />
                          Admin
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 shadow-sm">
                          <Users className="w-3 h-3 mr-1" />
                          User
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right space-x-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      
                      {/* Admin Toggle */}
                      {u.id !== user?.id && (
                        <button
                          onClick={() => toggleUserStatus(u.id, 'is_superuser', u.is_superuser)}
                          className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            u.is_superuser 
                              ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/50 border border-amber-200/60 dark:border-amber-500/30' 
                              : 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 border border-indigo-200/60 dark:border-indigo-500/30'
                          }`}
                        >
                          {u.is_superuser ? (
                            <><ShieldAlert className="w-3.5 h-3.5 mr-1" /> Revoke Admin</>
                          ) : (
                            <><ShieldCheck className="w-3.5 h-3.5 mr-1" /> Make Admin</>
                          )}
                        </button>
                      )}

                      {/* Active Toggle */}
                      {u.id !== user?.id && (
                        <button
                          onClick={() => toggleUserStatus(u.id, 'is_active', u.is_active)}
                          className={`inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            u.is_active 
                              ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 border border-red-200/60 dark:border-red-500/30' 
                              : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 border border-emerald-200/60 dark:border-emerald-500/30'
                          }`}
                        >
                          {u.is_active ? (
                            <><UserX className="w-3.5 h-3.5 mr-1" /> Deactivate</>
                          ) : (
                            <><UserCheck className="w-3.5 h-3.5 mr-1" /> Activate</>
                          )}
                        </button>
                      )}

                      {/* Password Reset */}
                      <button
                        onClick={() => changePassword(u.id)}
                        className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-50 dark:bg-slate-900/30 text-slate-700 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900/50 border border-slate-200 dark:border-slate-700 shadow-sm transition-all"
                        title="Change Password"
                      >
                        <KeyRound className="w-3.5 h-3.5 mr-1" /> Password
                      </button>

                      {/* Delete User */}
                      {u.id !== user?.id && (
                        <button
                          onClick={() => deleteUser(u.id)}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-medium bg-red-50/50 dark:bg-red-950/20 text-red-600 dark:text-red-500 hover:bg-red-100 dark:hover:bg-red-900/40 border border-red-200/50 dark:border-red-900/30 transition-all"
                          title="Delete User"
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {filteredUsers.length === 0 && (
                   <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-slate-500 dark:text-slate-400">
                      <Users className="w-8 h-8 text-slate-300 dark:text-slate-600 mx-auto mb-3" />
                      <p>No users found matching "{searchTerm}"</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AdminDashboard;
