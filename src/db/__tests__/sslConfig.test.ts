// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSSLConfig, validateSSLConnection } from "../sslConfig";
import fs from "fs";

// Mock fs.readFileSync for CA certificate tests
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
    },
    readFileSync: vi.fn(),
  };
});

describe("createSSLConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("production enforces SSL", () => {
    it("should return ssl config with rejectUnauthorized: true when NODE_ENV=production and DATABASE_URL is set", () => {
      const env = {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/alsaqi",
      };

      const result = createSSLConfig(env);

      expect(result).toBeDefined();
      expect(result!.ssl.rejectUnauthorized).toBe(true);
    });

    it("should not include ca property when DB_SSL_CA_PATH is not set", () => {
      const env = {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/alsaqi",
      };

      const result = createSSLConfig(env);

      expect(result).toBeDefined();
      expect(result!.ssl.ca).toBeUndefined();
    });
  });

  describe("development skips SSL", () => {
    it("should return undefined when NODE_ENV=development", () => {
      const env = {
        NODE_ENV: "development",
        DATABASE_URL: "postgres://user:pass@localhost:5432/alsaqi",
      };

      const result = createSSLConfig(env);

      expect(result).toBeUndefined();
    });

    it("should return undefined when NODE_ENV is not set (defaults to development)", () => {
      const env = {
        DATABASE_URL: "postgres://user:pass@localhost:5432/alsaqi",
      };

      const result = createSSLConfig(env);

      expect(result).toBeUndefined();
    });
  });

  describe("SSL config is undefined when DATABASE_URL is not set", () => {
    it("should return undefined when DATABASE_URL is not set in production", () => {
      const env = {
        NODE_ENV: "production",
      };

      const result = createSSLConfig(env);

      expect(result).toBeUndefined();
    });

    it("should return undefined when DATABASE_URL is not set in development", () => {
      const env = {
        NODE_ENV: "development",
      };

      const result = createSSLConfig(env);

      expect(result).toBeUndefined();
    });
  });

  describe("custom CA path loaded when DB_SSL_CA_PATH is set", () => {
    it("should read CA certificate file and include it in ssl config", () => {
      const fakeCaCert = "-----BEGIN CERTIFICATE-----\nMIIBxTCCAW...\n-----END CERTIFICATE-----";
      (fs.readFileSync as any).mockReturnValue(fakeCaCert);

      const env = {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/alsaqi",
        DB_SSL_CA_PATH: "/etc/ssl/certs/custom-ca.crt",
      };

      const result = createSSLConfig(env);

      expect(result).toBeDefined();
      expect(result!.ssl.rejectUnauthorized).toBe(true);
      expect(result!.ssl.ca).toBe(fakeCaCert);
      expect(fs.readFileSync).toHaveBeenCalledWith(
        "/etc/ssl/certs/custom-ca.crt",
        "utf-8"
      );
    });

    it("should throw an error if CA certificate file cannot be read", () => {
      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const env = {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/alsaqi",
        DB_SSL_CA_PATH: "/nonexistent/path/ca.crt",
      };

      expect(() => createSSLConfig(env)).toThrow(
        /Failed to read CA certificate from DB_SSL_CA_PATH/
      );
    });
  });
});

describe("validateSSLConnection", () => {
  it("should return true when connection query succeeds", async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
    };

    const result = await validateSSLConnection(mockPool);

    expect(result).toBe(true);
    expect(mockPool.query).toHaveBeenCalledWith("SELECT 1");
  });

  it("should throw an error when connection query fails", async () => {
    const mockPool = {
      query: vi.fn().mockRejectedValue(new Error("SSL connection refused")),
    };

    await expect(validateSSLConnection(mockPool)).rejects.toThrow(
      /Production SSL connection validation failed/
    );
  });

  it("should include the original error message in the thrown error", async () => {
    const mockPool = {
      query: vi
        .fn()
        .mockRejectedValue(
          new Error("self signed certificate in certificate chain")
        ),
    };

    await expect(validateSSLConnection(mockPool)).rejects.toThrow(
      /self signed certificate in certificate chain/
    );
  });
});
