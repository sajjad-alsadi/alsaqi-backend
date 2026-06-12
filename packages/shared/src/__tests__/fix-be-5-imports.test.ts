/**
 * Import tests for the FIX-BE-5 typed-contract coverage additions.
 *
 * Covers the contracts/validators actually wired up in the FIX-BE-5 wave:
 * the risk-register Endpoint_Contract and Validator_Schemas. Asserts each is
 * importable *by name* from the package root (`@alsaqi/shared`), which the
 * package entry re-exports via `export *` from `./types/endpoints` and
 * `./validators`.
 *
 * Requirements:
 *   5.5 - Each added Endpoint_Contract is exported from the package root so
 *         both repositories can import it by name.
 *   5.6 - Each added Validator_Schema is exported from the package root so
 *         both repositories can import it by name.
 *
 * Spec: .kiro/specs/backend-consistency-fixes (task 6.8)
 */
import { describe, it, expect } from 'vitest';

// ── Type-level import (Requirement 5.5) ─────────────────────────────────────
// `RiskRegisterEndpoints` is an interface that is erased at runtime. Importing
// it here and using it in a type position acts as a compile-time assertion
// that the contract is exported by name from the package root. If the export
// is removed or renamed, `tsc` (and the Vitest transform) fails to compile.
import type { RiskRegisterEndpoints } from '../index';

// ── Runtime import by name (Requirement 5.6) ────────────────────────────────
// Zod schemas are runtime values, so we import them by name directly and
// assert they are present and behave like Zod schemas.
import {
  CreateRiskRegisterSchema,
  UpdateRiskRegisterSchema,
} from '../index';

// Also import the inferred input types by name to assert they are exported
// (compile-time only; erased at runtime).
import type {
  CreateRiskRegisterInput,
  UpdateRiskRegisterInput,
} from '../index';

// Namespace import of the entry point. Confirms the whole module graph
// (index -> types/endpoints, validators, ...) loads and compiles.
import * as shared from '../index';

describe('FIX-BE-5 package-root imports', () => {
  describe('Validator_Schema exports (Requirement 5.6)', () => {
    it('exposes CreateRiskRegisterSchema as a Zod schema by name', () => {
      expect(CreateRiskRegisterSchema).toBeDefined();
      expect(typeof CreateRiskRegisterSchema.safeParse).toBe('function');
      expect(typeof CreateRiskRegisterSchema.parse).toBe('function');
    });

    it('exposes UpdateRiskRegisterSchema as a Zod schema by name', () => {
      expect(UpdateRiskRegisterSchema).toBeDefined();
      expect(typeof UpdateRiskRegisterSchema.safeParse).toBe('function');
      expect(typeof UpdateRiskRegisterSchema.parse).toBe('function');
    });

    it('re-exports the risk-register schemas on the package namespace', () => {
      expect(shared.CreateRiskRegisterSchema).toBe(CreateRiskRegisterSchema);
      expect(shared.UpdateRiskRegisterSchema).toBe(UpdateRiskRegisterSchema);
    });

    it('CreateRiskRegisterSchema validates a minimal valid payload', () => {
      const result = CreateRiskRegisterSchema.safeParse({
        description: 'Liquidity risk during stress scenarios',
      });
      expect(result.success).toBe(true);
    });

    it('CreateRiskRegisterSchema rejects a payload missing the required description', () => {
      const result = CreateRiskRegisterSchema.safeParse({ owner: 'Risk Team' });
      expect(result.success).toBe(false);
    });
  });

  describe('Endpoint_Contract exports (Requirement 5.5)', () => {
    it('imports RiskRegisterEndpoints by name from the package root (compile-time)', () => {
      // The type-only import above already enforces this at compile time.
      // The assignments below pin the contract shape so a rename/removal of
      // the contract or its routes breaks compilation, failing this test file.
      type GetList = RiskRegisterEndpoints['GET /risk-register'];
      type CreateBody = RiskRegisterEndpoints['POST /risk-register'];

      const listRouteResponseIsArray: GetList['response'] extends unknown[]
        ? true
        : false = true;
      const createRouteHasBody: CreateBody extends { body: unknown }
        ? true
        : false = true;

      expect(listRouteResponseIsArray).toBe(true);
      expect(createRouteHasBody).toBe(true);
    });
  });

  describe('Inferred input type exports (Requirement 5.6)', () => {
    it('imports CreateRiskRegisterInput / UpdateRiskRegisterInput by name (compile-time)', () => {
      // Construct values typed by the inferred input types to assert they are
      // exported by name and usable. Erased at runtime; enforced by the compiler.
      const createInput: CreateRiskRegisterInput = {
        description: 'Operational risk in payment processing',
      };
      const updateInput: UpdateRiskRegisterInput = {
        status: 'mitigated',
      };

      expect(createInput.description).toBeTypeOf('string');
      expect(updateInput.status).toBeTypeOf('string');
    });
  });
});
