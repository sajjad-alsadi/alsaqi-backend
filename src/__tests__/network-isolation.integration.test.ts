// @vitest-environment node
/**
 * Integration Tests: Network Isolation (Task 11.2)
 *
 * These tests verify that the Docker Compose production configuration
 * properly isolates internal services (postgres, redis) from the host
 * network while allowing the api service to reach them via internal hostnames.
 *
 * **Validates: Requirements 13.1, 13.2**
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(__dirname, '../../');
const COMPOSE_PATH = resolve(PROJECT_ROOT, 'docker-compose.yml');
const COMPOSE_OVERRIDE_PATH = resolve(PROJECT_ROOT, 'docker-compose.override.yml');

/**
 * Extracts a service section from docker-compose.yml content.
 * Only matches services defined directly under the top-level `services:` key
 * (indent level = 2 spaces). Returns all lines belonging to that service.
 */
function extractServiceSection(compose: string, serviceName: string): string {
  const lines = compose.split('\n');
  let inServicesBlock = false;
  let inService = false;
  let serviceIndent = -1;
  const serviceLines: string[] = [];

  for (const line of lines) {
    // Detect the top-level `services:` block
    if (line.match(/^services:\s*$/)) {
      inServicesBlock = true;
      continue;
    }

    if (!inServicesBlock) continue;

    // A top-level key (no indentation) means we've left the services block
    if (line.match(/^\S/) && line.trim() !== '') {
      if (inService) break;
      inServicesBlock = false;
      continue;
    }

    // Match the target service at the expected indentation (2 spaces for docker-compose)
    const serviceMatch = line.match(new RegExp(`^(  )${serviceName}:\\s*$`));
    if (serviceMatch && !inService) {
      inService = true;
      serviceIndent = 2; // services are at 2-space indent
      serviceLines.push(line);
      continue;
    }

    if (inService) {
      // Another service at the same indent level (2 spaces) means end of current service
      const currentIndent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (line.trim() !== '' && currentIndent <= serviceIndent && !line.match(/^\s*#/)) {
        break;
      }
      serviceLines.push(line);
    }
  }

  return serviceLines.join('\n');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Network Isolation - docker-compose.yml', () => {
  let composeContent: string;

  beforeAll(() => {
    expect(existsSync(COMPOSE_PATH)).toBe(true);
    composeContent = readFileSync(COMPOSE_PATH, 'utf-8');
  });

  describe('PostgreSQL service has NO port mapping (Requirement 13.1)', () => {
    it('postgres service section does not contain a ports directive', () => {
      const postgresSection = extractServiceSection(composeContent, 'postgres');
      expect(postgresSection).not.toBe('');

      // The postgres section should NOT have a `ports:` key
      expect(postgresSection).not.toMatch(/^\s+ports:/m);
    });

    it('postgres service does not expose port 5432 to the host', () => {
      const postgresSection = extractServiceSection(composeContent, 'postgres');

      // Should not contain any port mapping pattern like "5432:5432"
      expect(postgresSection).not.toMatch(/["']?\d+:5432["']?/);
    });
  });

  describe('Redis service has NO port mapping (Requirement 13.2)', () => {
    it('redis service section does not contain a ports directive', () => {
      const redisSection = extractServiceSection(composeContent, 'redis');
      expect(redisSection).not.toBe('');

      // The redis section should NOT have a `ports:` key
      expect(redisSection).not.toMatch(/^\s+ports:/m);
    });

    it('redis service does not expose port 6379 to the host', () => {
      const redisSection = extractServiceSection(composeContent, 'redis');

      // Should not contain any port mapping pattern like "6379:6379"
      expect(redisSection).not.toMatch(/["']?\d+:6379["']?/);
    });
  });

  describe('API service can reach postgres and redis via internal network', () => {
    it('api service references postgres hostname in DATABASE_URL', () => {
      const apiSection = extractServiceSection(composeContent, 'api');
      expect(apiSection).not.toBe('');

      // The api service should reference postgres by internal hostname
      expect(apiSection).toMatch(/DATABASE_URL=.*@postgres:\d+/);
    });

    it('api service references redis hostname in REDIS_URL', () => {
      const apiSection = extractServiceSection(composeContent, 'api');

      // The api service should reference redis by internal hostname
      expect(apiSection).toMatch(/REDIS_URL=.*@redis:\d+/);
    });

    it('api, postgres, and redis all share the alsaqi-network', () => {
      const apiSection = extractServiceSection(composeContent, 'api');
      const postgresSection = extractServiceSection(composeContent, 'postgres');
      const redisSection = extractServiceSection(composeContent, 'redis');

      // All three services must be on the same network
      expect(apiSection).toContain('alsaqi-network');
      expect(postgresSection).toContain('alsaqi-network');
      expect(redisSection).toContain('alsaqi-network');
    });

    it('alsaqi-network is defined as a bridge network', () => {
      // The networks section should define alsaqi-network with bridge driver
      expect(composeContent).toMatch(/networks:/);
      expect(composeContent).toMatch(/alsaqi-network:/);
      expect(composeContent).toMatch(/driver:\s*bridge/);
    });
  });

  describe('Only API service exposes port 3000 to the host', () => {
    it('api service exposes port 3000', () => {
      const apiSection = extractServiceSection(composeContent, 'api');

      // The api service should map port 3000
      expect(apiSection).toMatch(/ports:/);
      expect(apiSection).toMatch(/["']?3000:3000["']?/);
    });

    it('only the api service has a ports directive in production compose', () => {
      // Get all services that have a ports directive
      const services = ['api', 'postgres', 'redis'];
      const servicesWithPorts = services.filter((svc) => {
        const section = extractServiceSection(composeContent, svc);
        return section.match(/^\s+ports:/m) !== null;
      });

      // Only the api service should have ports
      expect(servicesWithPorts).toEqual(['api']);
    });
  });

  describe('docker-compose.override.yml re-exposes ports for development', () => {
    it('docker-compose.override.yml exists', () => {
      expect(existsSync(COMPOSE_OVERRIDE_PATH)).toBe(true);
    });

    it('override file re-exposes postgres port 5432 for dev', () => {
      const overrideContent = readFileSync(COMPOSE_OVERRIDE_PATH, 'utf-8');
      const postgresSection = extractServiceSection(overrideContent, 'postgres');

      expect(postgresSection).toMatch(/ports:/);
      expect(postgresSection).toMatch(/["']?5432:5432["']?/);
    });

    it('override file re-exposes redis port 6379 for dev', () => {
      const overrideContent = readFileSync(COMPOSE_OVERRIDE_PATH, 'utf-8');
      const redisSection = extractServiceSection(overrideContent, 'redis');

      expect(redisSection).toMatch(/ports:/);
      expect(redisSection).toMatch(/["']?6379:6379["']?/);
    });
  });
});
