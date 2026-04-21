import React, { useEffect, useState } from "react";
import { Outlet, useNavigate, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { useWebSocket } from "../../hooks/useWebSocket.js";

interface User {
  username: string;
}

export function Layout() {
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api.get<{ user: User }>("/auth/me"),
  });

  // Initialize WebSocket connection
  useWebSocket();

  useEffect(() => {
    if (error) {
      navigate("/login");
    }
  }, [error, navigate]);

  if (isLoading) {
    return (
      <div className="h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="animate-pulse text-lg">Loading...</div>
      </div>
    );
  }

  const handleLogout = async () => {
    await api.post("/auth/logout");
    navigate("/login");
  };

  // h-screen + overflow-hidden on root caps the layout to the viewport so
  // the inner <aside> and <main> can own their own scrollbars (Claude
  // desktop / VSCode pattern). With min-h-screen the page itself scrolled,
  // dragging the sidebar off-screen along with main content.
  return (
    <div className="h-screen bg-gray-950 text-white flex overflow-hidden">
      {/* Sidebar — independent scroll if nav grows */}
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col overflow-y-auto">
        <div className="p-4 border-b border-gray-800">
          <Link to="/" className="text-xl font-bold text-white hover:text-brand-purple">
            DevOps Dashboard
          </Link>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <Link
            to="/"
            className="block px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white"
          >
            Servers
          </Link>
          <Link
            to="/audit"
            className="block px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white"
          >
            Audit Trail
          </Link>
          <Link
            to="/settings"
            className="block px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-800 hover:text-white"
          >
            Settings
          </Link>
        </nav>
        <div className="p-4 border-t border-gray-800">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-400">
              {data?.user?.username}
            </span>
            <button
              onClick={handleLogout}
              className="text-sm text-gray-500 hover:text-red-400"
            >
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
