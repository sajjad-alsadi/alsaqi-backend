/**
 * Endpoint contract interfaces for the Users module.
 * Defines the request/response shapes for each route.
 */
import type { User } from '../models';
import type { CreateUserInput, UpdateUserInput } from '../../validators/users';

export interface UsersEndpoints {
  'GET /users': {
    query: { page?: number; pageSize?: number; role?: string; status?: string };
    response: User[];
  };
  'GET /users/:id': {
    params: { id: string };
    response: User;
  };
  'POST /users': {
    body: CreateUserInput;
    response: User;
  };
  'PUT /users/:id': {
    params: { id: string };
    body: UpdateUserInput;
    response: User;
  };
  'DELETE /users/:id': {
    params: { id: string };
    response: { deleted: boolean };
  };
}
