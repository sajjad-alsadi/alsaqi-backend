// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  buildArtifactManifest,
  type ResolvedImage,
  type ScanSummary,
} from '../buildArtifactManifest';

/**
 * Build_Artifact_Manifest pure-logic unit tests (Req 20.5).
 *
 * Under test: the pure `buildArtifactManifest(builtAt, images, scan)` generator,
 * which records the resolved digest for each base image plus the vulnerability
 * scan summary (tool, HIGH/CRITICAL counts, and the `completed` flag).
 */

const builtAt = '2026-06-13T12:34:56.000Z';

describe('buildArtifactManifest', () => {
  it('records each base image with its ref and resolvedDigest (one entry per input)', () => {
    const images: ResolvedImage[] = [
      { ref: 'node:20-alpine', resolvedDigest: 'sha256:aaa111' },
      { ref: 'gcr.io/distroless/nodejs20', resolvedDigest: 'sha256:bbb222' },
    ];
    const scan: ScanSummary = {
      tool: 'trivy',
      highCount: 0,
      criticalCount: 0,
      completed: true,
    };

    const manifest = buildArtifactManifest(builtAt, images, scan);

    // One entry per input image, in order, with digests preserved.
    expect(manifest.images).toHaveLength(images.length);
    expect(manifest.images).toEqual([
      { ref: 'node:20-alpine', resolvedDigest: 'sha256:aaa111' },
      { ref: 'gcr.io/distroless/nodejs20', resolvedDigest: 'sha256:bbb222' },
    ]);
  });

  it('handles an empty image list', () => {
    const scan: ScanSummary = {
      tool: 'trivy',
      highCount: 0,
      criticalCount: 0,
      completed: true,
    };

    const manifest = buildArtifactManifest(builtAt, [], scan);

    expect(manifest.images).toEqual([]);
  });

  it('records the scan summary with completed=true', () => {
    const scan: ScanSummary = {
      tool: 'trivy',
      highCount: 3,
      criticalCount: 1,
      completed: true,
    };

    const manifest = buildArtifactManifest(builtAt, [], scan);

    expect(manifest.scan).toEqual({
      tool: 'trivy',
      highCount: 3,
      criticalCount: 1,
      completed: true,
    });
  });

  it('records the scan summary with completed=false (fail-closed)', () => {
    const scan: ScanSummary = {
      tool: 'grype',
      highCount: 0,
      criticalCount: 0,
      completed: false,
    };

    const manifest = buildArtifactManifest(builtAt, [], scan);

    expect(manifest.scan.tool).toBe('grype');
    expect(manifest.scan.highCount).toBe(0);
    expect(manifest.scan.criticalCount).toBe(0);
    expect(manifest.scan.completed).toBe(false);
  });

  it('carries builtAt through unchanged', () => {
    const scan: ScanSummary = {
      tool: 'trivy',
      highCount: 0,
      criticalCount: 0,
      completed: true,
    };

    const manifest = buildArtifactManifest(builtAt, [], scan);

    expect(manifest.builtAt).toBe(builtAt);
  });
});
