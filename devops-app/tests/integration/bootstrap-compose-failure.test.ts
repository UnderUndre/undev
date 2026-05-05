/** Feature 009 T036 — compose failure → Edit Config → retry → ACTIVE. Skipped pending harness. */
import { describe, it } from "vitest";
describe.skip("bootstrap compose failure (T036 — needs harness)", () => {
  it("failed_compose → Edit Config → retry → active", () => {
    /* TODO: harness — broken compose, PATCH config, POST retry */
  });
});
