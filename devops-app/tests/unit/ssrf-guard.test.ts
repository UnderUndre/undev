import { describe, it, expect } from "vitest";
import { isBlockedIp, validateUrlForProbe } from "../../server/lib/ssrf-guard.js";

describe("ssrf-guard (feature 006 T052)", () => {
  describe("isBlockedIp — IPv4 ranges", () => {
    it("blocks RFC 1918 10/8", () => {
      expect(isBlockedIp("10.0.0.1")).toBe(true);
      expect(isBlockedIp("10.255.255.254")).toBe(true);
    });
    it("blocks RFC 1918 172.16/12", () => {
      expect(isBlockedIp("172.16.0.1")).toBe(true);
      expect(isBlockedIp("172.31.255.254")).toBe(true);
      expect(isBlockedIp("172.32.0.1")).toBe(false); // outside /12
    });
    it("blocks RFC 1918 192.168/16", () => {
      expect(isBlockedIp("192.168.1.1")).toBe(true);
    });
    it("blocks RFC 3927 link-local incl. AWS/GCP/Azure IMDS", () => {
      expect(isBlockedIp("169.254.169.254")).toBe(true);
      expect(isBlockedIp("169.254.1.1")).toBe(true);
    });
    it("blocks loopback 127/8", () => {
      expect(isBlockedIp("127.0.0.1")).toBe(true);
      expect(isBlockedIp("127.42.42.42")).toBe(true);
    });
    it("blocks 0.0.0.0/8", () => {
      expect(isBlockedIp("0.0.0.0")).toBe(true);
      expect(isBlockedIp("0.1.2.3")).toBe(true);
    });
    it("allows public addresses", () => {
      expect(isBlockedIp("8.8.8.8")).toBe(false);
      expect(isBlockedIp("1.1.1.1")).toBe(false);
      expect(isBlockedIp("203.0.113.5")).toBe(false);
    });
  });

  describe("isBlockedIp — IPv6 ranges", () => {
    it("blocks ::1 loopback", () => {
      expect(isBlockedIp("::1")).toBe(true);
    });
    it("blocks fc00::/7 ULA", () => {
      expect(isBlockedIp("fc00::1")).toBe(true);
      expect(isBlockedIp("fd00::1")).toBe(true);
    });
    it("blocks fe80::/10 link-local", () => {
      expect(isBlockedIp("fe80::1")).toBe(true);
    });
    it("allows public IPv6", () => {
      expect(isBlockedIp("2001:4860:4860::8888")).toBe(false);
    });
  });

  describe("validateUrlForProbe", () => {
    it("rejects malformed URL", async () => {
      const r = await validateUrlForProbe("not a url");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid_url");
    });
    it("rejects literal private-IP URL without DNS", async () => {
      const r = await validateUrlForProbe("http://169.254.169.254/latest/meta-data/");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("private_ip");
    });
    it("rejects literal loopback", async () => {
      const r = await validateUrlForProbe("http://127.0.0.1/");
      expect(r.ok).toBe(false);
    });
    it("accepts literal public IP", async () => {
      const r = await validateUrlForProbe("http://8.8.8.8/");
      expect(r.ok).toBe(true);
    });
  });
});
