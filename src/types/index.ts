export * from './api';
export * from './middleware';
export * from './pdf';

import { Request } from 'express';
import { UploadedFile } from 'express-fileupload';

/**
 * User interface for the API server's authenticated request context.
 * This is a minimal interface representing the JWT-decoded user.
 */
export interface ApiUser {
  id: string;
  username: string;
  name: string;
  email?: string;
  role: string;
  department?: string;
  session_version?: number;
}

export interface AuthenticatedRequest extends Request {
  user: ApiUser;
}

export interface FileUploadRequest extends AuthenticatedRequest {
  files?: {
    [key: string]: UploadedFile | UploadedFile[];
  };
}

export type OperationType = 'create' | 'update' | 'delete' | 'list' | 'get' | 'write';
