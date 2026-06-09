import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectDuplicates,
  logDuplicateRoutes,
  methodNotAllowed,
  registerRoute,
  registerRoutes,
  getRegisteredRoutes,
  clearRegistry,
  RouteRegistration,
} from '../routeRegistry';
import { createMockRequest, createMockResponse, createMockNext } from '../../__tests__/helpers/apiTestUtils';

describe('routeRegistry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  describe('registerRoute', () => {
    it('adds a route to the registry', () => {
      registerRoute('GET', '/api/users', 'users.ts');
      const routes = getRegisteredRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({ method: 'GET', path: '/api/users', source: 'users.ts' });
    });

    it('normalizes method to uppercase', () => {
      registerRoute('get', '/api/users', 'users.ts');
      const routes = getRegisteredRoutes();
      expect(routes[0].method).toBe('GET');
    });

    it('normalizes path with double slashes', () => {
      registerRoute('GET', '/api//users', 'users.ts');
      const routes = getRegisteredRoutes();
      expect(routes[0].path).toBe('/api/users');
    });
  });

  describe('registerRoutes', () => {
    it('registers multiple methods for the same path', () => {
      registerRoutes(['GET', 'POST', 'PUT', 'DELETE'], '/api/items', 'crudGenerator');
      const routes = getRegisteredRoutes();
      expect(routes).toHaveLength(4);
      expect(routes.map(r => r.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    });
  });

  describe('detectDuplicates', () => {
    it('returns empty array when no duplicates exist', () => {
      const routes: RouteRegistration[] = [
        { method: 'GET', path: '/api/users', source: 'users.ts' },
        { method: 'POST', path: '/api/users', source: 'users.ts' },
        { method: 'GET', path: '/api/roles', source: 'roles.ts' },
      ];

      const duplicates = detectDuplicates(routes);
      expect(duplicates).toHaveLength(0);
    });

    it('detects duplicate route registrations with same method and path', () => {
      const routes: RouteRegistration[] = [
        { method: 'GET', path: '/api/audit-tasks', source: 'crudGenerator' },
        { method: 'GET', path: '/api/audit-tasks', source: 'auditTasks.ts' },
        { method: 'POST', path: '/api/audit-tasks', source: 'crudGenerator' },
      ];

      const duplicates = detectDuplicates(routes);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]).toEqual({
        method: 'GET',
        path: '/api/audit-tasks',
        sources: ['crudGenerator', 'auditTasks.ts'],
      });
    });

    it('detects multiple duplicate groups', () => {
      const routes: RouteRegistration[] = [
        { method: 'GET', path: '/api/audit-tasks', source: 'crudGenerator' },
        { method: 'GET', path: '/api/audit-tasks', source: 'auditTasks.ts' },
        { method: 'GET', path: '/api/recommendations', source: 'crudGenerator' },
        { method: 'GET', path: '/api/recommendations', source: 'recommendations.ts' },
        { method: 'GET', path: '/api/users', source: 'users.ts' },
      ];

      const duplicates = detectDuplicates(routes);
      expect(duplicates).toHaveLength(2);
    });

    it('treats different methods on same path as distinct (no duplicate)', () => {
      const routes: RouteRegistration[] = [
        { method: 'GET', path: '/api/audit-tasks', source: 'auditTasks.ts' },
        { method: 'PATCH', path: '/api/audit-tasks', source: 'auditTasks.ts' },
        { method: 'DELETE', path: '/api/audit-tasks', source: 'crudGenerator' },
      ];

      const duplicates = detectDuplicates(routes);
      expect(duplicates).toHaveLength(0);
    });

    it('detects three-way duplicates', () => {
      const routes: RouteRegistration[] = [
        { method: 'GET', path: '/api/items', source: 'source1' },
        { method: 'GET', path: '/api/items', source: 'source2' },
        { method: 'GET', path: '/api/items', source: 'source3' },
      ];

      const duplicates = detectDuplicates(routes);
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].sources).toHaveLength(3);
    });

    it('uses the global registry when no routes argument is provided', () => {
      registerRoute('GET', '/api/items', 'source1');
      registerRoute('GET', '/api/items', 'source2');

      const duplicates = detectDuplicates();
      expect(duplicates).toHaveLength(1);
      expect(duplicates[0].sources).toEqual(['source1', 'source2']);
    });
  });

  describe('logDuplicateRoutes', () => {
    it('logs warnings for duplicate routes in the registry', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registerRoute('GET', '/api/audit-tasks', 'crudGenerator');
      registerRoute('GET', '/api/audit-tasks', 'auditTasks.ts');

      const duplicates = logDuplicateRoutes();

      expect(duplicates).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('[RouteRegistry]');
      expect(warnSpy.mock.calls[0][0]).toContain('Duplicate route detected');
      expect(warnSpy.mock.calls[0][0]).toContain('GET');
      expect(warnSpy.mock.calls[0][0]).toContain('/api/audit-tasks');
      expect(warnSpy.mock.calls[0][0]).toContain('crudGenerator');
      expect(warnSpy.mock.calls[0][0]).toContain('auditTasks.ts');

      warnSpy.mockRestore();
    });

    it('returns empty array and does not log when no duplicates exist', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registerRoute('GET', '/api/users', 'users.ts');
      registerRoute('POST', '/api/users', 'users.ts');
      registerRoute('GET', '/api/roles', 'roles.ts');

      const duplicates = logDuplicateRoutes();
      expect(duplicates).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('logs multiple warnings for multiple duplicate groups', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registerRoute('GET', '/api/audit-tasks', 'crudGenerator');
      registerRoute('GET', '/api/audit-tasks', 'auditTasks.ts');
      registerRoute('GET', '/api/recommendations', 'crudGenerator');
      registerRoute('GET', '/api/recommendations', 'recommendations.ts');

      const duplicates = logDuplicateRoutes();
      expect(duplicates).toHaveLength(2);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      warnSpy.mockRestore();
    });
  });

  describe('methodNotAllowed', () => {
    it('returns 405 status with Allow header', () => {
      const middleware = methodNotAllowed(['GET', 'PATCH']);
      const req = createMockRequest({ method: 'DELETE', url: '/api/audit-tasks/1' });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res as any, next);

      expect(res.statusCode).toBe(405);
      expect(res._headers['allow']).toBe('GET, PATCH');
      expect(res._json).toEqual({
        success: false,
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'Method DELETE is not allowed on this resource. Allowed methods: GET, PATCH',
        },
      });
    });

    it('includes all allowed methods in Allow header', () => {
      const middleware = methodNotAllowed(['GET', 'POST', 'PUT', 'DELETE']);
      const req = createMockRequest({ method: 'PATCH', url: '/api/items' });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res as any, next);

      expect(res._headers['allow']).toBe('GET, POST, PUT, DELETE');
      expect(res.statusCode).toBe(405);
    });

    it('normalizes method names to uppercase', () => {
      const middleware = methodNotAllowed(['get', 'post']);
      const req = createMockRequest({ method: 'PUT', url: '/api/items' });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res as any, next);

      expect(res._headers['allow']).toBe('GET, POST');
    });

    it('does not call next()', () => {
      const middleware = methodNotAllowed(['GET']);
      const req = createMockRequest({ method: 'DELETE', url: '/api/items' });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res as any, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('includes error code METHOD_NOT_ALLOWED in response', () => {
      const middleware = methodNotAllowed(['POST']);
      const req = createMockRequest({ method: 'GET', url: '/api/items' });
      const res = createMockResponse();
      const next = createMockNext();

      middleware(req, res as any, next);

      expect(res._json.error.code).toBe('METHOD_NOT_ALLOWED');
    });
  });

  describe('clearRegistry', () => {
    it('removes all registered routes', () => {
      registerRoute('GET', '/api/users', 'users.ts');
      registerRoute('POST', '/api/users', 'users.ts');
      expect(getRegisteredRoutes()).toHaveLength(2);

      clearRegistry();
      expect(getRegisteredRoutes()).toHaveLength(0);
    });
  });
});
