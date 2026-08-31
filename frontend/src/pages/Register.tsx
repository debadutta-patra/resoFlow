import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { Atom, CheckCircle2 } from 'lucide-react';
import { ThemeToggle } from '../components/ThemeToggle';

const Register: React.FC = () => {
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      setIsLoading(false);
      return;
    }

    try {
      await api.post('/auth/register', {
        email,
        full_name: fullName,
        password
      });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex flex-col justify-center py-12 sm:px-6 lg:px-8 transition-colors duration-200 relative">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center mb-6">
          <div className="rounded-full bg-blue-600 dark:bg-indigo-600 p-3 shadow-lg shadow-blue-500/30 dark:shadow-indigo-500/20">
            <Atom className="text-white w-8 h-8" />
          </div>
        </div>
        <h2 className="mt-2 text-center text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
          Create an Account
        </h2>
        <p className="mt-2 text-center text-sm text-slate-600 dark:text-slate-400">
          Join the platform for NMR relaxation analysis
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white dark:bg-slate-800 py-8 px-4 shadow-xl shadow-slate-200/50 dark:shadow-none sm:rounded-lg sm:px-10 border border-slate-100 dark:border-slate-700 transition-colors duration-200">
          {success ? (
            <div className="text-center space-y-4">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 mb-4">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Registration Successful!</h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Your account has been created and is currently <strong>pending administrative approval</strong>.
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                You will be able to log in once an administrator activates your account.
              </p>
              <div className="pt-4">
                <Link to="/login" className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 dark:bg-indigo-600 hover:bg-blue-700 dark:hover:bg-indigo-500 transition-colors">
                  Back to Sign In
                </Link>
              </div>
            </div>
          ) : (
            <form className="space-y-6" onSubmit={handleSubmit}>
              {error && (
                <div className="bg-red-50 dark:bg-red-900/30 border-l-4 border-red-500 dark:border-red-500/50 p-4 rounded-md">
                  <div className="flex">
                    <div className="ml-3">
                      <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
                    </div>
                  </div>
                </div>
              )}
              
              <div>
                <label htmlFor="fullName" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                  Full Name
                </label>
                <div className="mt-1">
                  <input
                    id="fullName"
                    name="fullName"
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="appearance-none block w-full px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-300 dark:border-slate-600 rounded-md shadow-sm placeholder-slate-400 dark:placeholder-slate-500 text-slate-900 dark:text-white focus:outline-none focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 sm:text-sm transition-colors"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="email" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                  Email Address
                </label>
                <div className="mt-1">
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="appearance-none block w-full px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-300 dark:border-slate-600 rounded-md shadow-sm placeholder-slate-400 dark:placeholder-slate-500 text-slate-900 dark:text-white focus:outline-none focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 sm:text-sm transition-colors"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                  Password
                </label>
                <div className="mt-1">
                  <input
                    id="password"
                    name="password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="appearance-none block w-full px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-300 dark:border-slate-600 rounded-md shadow-sm placeholder-slate-400 dark:placeholder-slate-500 text-slate-900 dark:text-white focus:outline-none focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 sm:text-sm transition-colors"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                  Confirm Password
                </label>
                <div className="mt-1">
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="appearance-none block w-full px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-300 dark:border-slate-600 rounded-md shadow-sm placeholder-slate-400 dark:placeholder-slate-500 text-slate-900 dark:text-white focus:outline-none focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 sm:text-sm transition-colors"
                  />
                </div>
              </div>

              <div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 dark:bg-indigo-600 hover:bg-blue-700 dark:hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-indigo-500 dark:focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isLoading ? 'Registering...' : 'Register'}
                </button>
              </div>
            </form>
          )}

          {!success && (
            <div className="mt-6 border-t border-slate-200 dark:border-slate-700 pt-6">
              <div className="text-center">
                <span className="text-sm text-slate-500 dark:text-slate-400 mr-2">Already have an account?</span>
                <Link to="/login" className="font-medium text-sm text-blue-600 dark:text-indigo-400 hover:text-blue-500 dark:hover:text-indigo-300 transition-colors">
                  Sign in
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Register;
