/** Feature 010 T046 — faceted audit log page (replaces legacy AuditPage when wired). */
import React, { useState } from "react";
import type { AuditFilters as Filters } from "../hooks/useAuditQuery.js";
import { AuditFilters } from "../components/audit/AuditFilters.js";
import { AuditTable } from "../components/audit/AuditTable.js";

const PAGE_SIZE = 50;

export function AuditQueryPage() {
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  return (
    <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4 p-4">
      <AuditFilters
        filters={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
        }}
      />
      <AuditTable
        filters={filters}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />
    </div>
  );
}
