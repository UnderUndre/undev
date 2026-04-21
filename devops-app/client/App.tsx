import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoginPage } from "./pages/LoginPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { ServerPage } from "./pages/ServerPage.js";
import { AppPage } from "./pages/AppPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { RunDetail } from "./components/scripts/RunDetail.js";
import { Layout } from "./components/layout/Layout.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<Layout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/servers/:serverId" element={<ServerPage />} />
            <Route path="/apps/:appId" element={<AppPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/runs/:runId" element={<RunDetail />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
