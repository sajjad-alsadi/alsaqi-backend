import fs from "fs";

/**
 * SSL configuration for PostgreSQL database connections.
 * 
 * - Production: enforces SSL with rejectUnauthorized: true
 * - Development: no SSL required (PGlite doesn't use network)
 * - Supports custom CA certificate via DB_SSL_CA_PATH
 */

export interface DBSSLConfig {
  ssl: {
    rejectUnauthorized: boolean;
    ca?: string;
  };
}

/**
 * Creates SSL configuration based on environment variables.
 * 
 * @param env - The process environment variables
 * @returns SSL config object for pg.Pool, or undefined if SSL is not needed
 */
export function createSSLConfig(env: NodeJS.ProcessEnv): DBSSLConfig | undefined {
  const nodeEnv = env.NODE_ENV || "development";
  const databaseUrl = env.DATABASE_URL;

  // No DATABASE_URL means PGlite (embedded) — no SSL needed
  if (!databaseUrl) {
    return undefined;
  }

  // Development mode: no SSL required (PGlite or local PostgreSQL)
  if (nodeEnv !== "production") {
    return undefined;
  }

  // Production mode: enforce SSL
  const sslConfig: DBSSLConfig = {
    ssl: {
      rejectUnauthorized: true,
    },
  };

  // Support custom CA certificate via DB_SSL_CA_PATH
  const caPath = env.DB_SSL_CA_PATH;
  if (caPath) {
    try {
      const caCert = fs.readFileSync(caPath, "utf-8");
      sslConfig.ssl.ca = caCert;
    } catch (err: any) {
      throw new Error(
        `[DB SSL] Failed to read CA certificate from DB_SSL_CA_PATH="${caPath}": ${err.message}`
      );
    }
  }

  return sslConfig;
}

/**
 * Validates that the SSL connection to the database works in production.
 * If DATABASE_URL is set in production and SSL connection fails, the server should refuse to start.
 * 
 * @param pool - The pg.Pool instance to test
 * @returns true if connection succeeds, throws if it fails
 */
export async function validateSSLConnection(pool: any): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (err: any) {
    const message = err.message || String(err);
    throw new Error(
      `[DB SSL] Production SSL connection validation failed: ${message}. ` +
      `The server cannot start without a secure database connection in production.`
    );
  }
}
