/**
 * Endpoint contract interfaces for the Auth module.
 * Defines the request/response shapes for each route.
 */
import type { User } from '../models';
import type { LoginInput, RegisterInput, ChangePasswordInput } from '../../validators/auth';

export interface AuthEndpoints {
  'POST /auth/login': {
    body: LoginInput;
    response: { user: User; accessToken: string; refreshToken: string };
  };
  'POST /auth/register': {
    body: RegisterInput;
    response: { user: User };
  };
  'POST /auth/refresh': {
    body: { refreshToken: string };
    response: { accessToken: string; refreshToken: string };
  };
  'POST /auth/logout': {
    body: undefined;
    response: { success: boolean };
  };
  'POST /auth/change-password': {
    body: ChangePasswordInput;
    response: { success: boolean };
  };
}
