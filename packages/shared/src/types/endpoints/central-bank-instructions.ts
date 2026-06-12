/**
 * Endpoint contract interfaces for the Central Bank Instructions module.
 * Defines the request/response shapes for each route.
 *
 * The `central_bank_instructions` entity is served end-to-end by the CRUD
 * generator (`generateRoutes("central_bank_instructions", "central-bank-instructions", "Policies")`
 * in `src/utils/crudGenerator.ts`) and typed by the `CentralBankInstruction`
 * model (see `packages/shared/src/types/models.ts`).
 */
import type { CentralBankInstruction } from '../models';

export interface CentralBankInstructionsEndpoints {
  'GET /central-bank-instructions': {
    query: { page?: number; pageSize?: number; status?: string; category?: string };
    response: CentralBankInstruction[];
  };
  'GET /central-bank-instructions/:id': {
    params: { id: string };
    response: CentralBankInstruction;
  };
  'POST /central-bank-instructions': {
    body: Omit<CentralBankInstruction, 'id'>;
    response: CentralBankInstruction;
  };
  'PUT /central-bank-instructions/:id': {
    params: { id: string };
    body: Partial<Omit<CentralBankInstruction, 'id'>>;
    response: CentralBankInstruction;
  };
  'DELETE /central-bank-instructions/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
