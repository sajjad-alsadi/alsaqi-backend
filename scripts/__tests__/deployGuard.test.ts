/**
 * Unit tests for the production override guard (Task 9.3, Requirement 5.2).
 *
 * Verifies the pure, side-effect-free logic of `detectAutoLoadedOverride` and
 * `evaluateDeployGuard` from `scripts/deployGuard.ts`:
 *   - presence of `docker-compose.override.yml` ⇒ launch must FAIL
 *   - absence of it ⇒ launch may PASS
 *   - case sensitivity and similar-but-different filenames do NOT trip the guard
 *   - the failure message names the offending file
 *
 * _Requirements: 5.2_
 */

import { describe, it, expect } from 'vitest';
import {
  AUTO_LOADED_OVERRIDE_FILENAME,
  detectAutoLoadedOverride,
  evaluateDeployGuard,
} from '../deployGuard';

describe('detectAutoLoadedOverride (Requirement 5.2)', () => {
  it('returns true when docker-compose.override.yml is present in the deploy dir', () => {
    const files = ['docker-compose.yml', 'docker-compose.override.yml', '.env'];
    expect(detectAutoLoadedOverride(files)).toBe(true);
  });

  it('returns true when the override file is the only entry', () => {
    expect(detectAutoLoadedOverride(['docker-compose.override.yml'])).toBe(true);
  });

  it('returns false when the override file is absent', () => {
    const files = ['docker-compose.yml', 'Dockerfile', '.env', 'package.json'];
    expect(detectAutoLoadedOverride(files)).toBe(false);
  });

  it('returns false for an empty deploy directory', () => {
    expect(detectAutoLoadedOverride([])).toBe(false);
  });

  it('is case sensitive: differently-cased names do not match', () => {
    expect(detectAutoLoadedOverride(['Docker-Compose.Override.yml'])).toBe(false);
    expect(detectAutoLoadedOverride(['DOCKER-COMPOSE.OVERRIDE.YML'])).toBe(false);
    expect(detectAutoLoadedOverride(['docker-compose.Override.yml'])).toBe(false);
  });

  it('does not match similar-but-different filenames', () => {
    const lookalikes = [
      'docker-compose.override.yaml', // .yaml, not .yml
      'docker-compose.yml',
      'docker-compose.override.yml.bak',
      'my-docker-compose.override.yml',
      'docker-compose.override',
      'docker-compose.prod.yml',
    ];
    expect(detectAutoLoadedOverride(lookalikes)).toBe(false);
  });

  it('uses the documented auto-loaded override filename constant', () => {
    expect(AUTO_LOADED_OVERRIDE_FILENAME).toBe('docker-compose.override.yml');
  });
});

describe('evaluateDeployGuard (Requirement 5.2)', () => {
  it('fails (ok=false) with a message naming the file when the override is present', () => {
    const result = evaluateDeployGuard(['docker-compose.yml', 'docker-compose.override.yml']);
    expect(result.ok).toBe(false);
    expect(result.message).not.toBeNull();
    expect(result.message).toContain(AUTO_LOADED_OVERRIDE_FILENAME);
  });

  it('passes (ok=true) with no message when the override is absent', () => {
    const result = evaluateDeployGuard(['docker-compose.yml', 'Dockerfile']);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it('passes (ok=true) for an empty deploy directory', () => {
    const result = evaluateDeployGuard([]);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  it('does not fail on similar-but-different filenames', () => {
    const result = evaluateDeployGuard([
      'docker-compose.override.yaml',
      'docker-compose.yml',
    ]);
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });
});
