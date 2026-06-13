export enum ErrorCode {
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  SECURITY_ERROR = 'SECURITY_ERROR',
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCode;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, errorCode: ErrorCode = ErrorCode.INTERNAL_SERVER_ERROR, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  public readonly details?: any;
  constructor(message: string, details?: any) {
    super(message, 400, ErrorCode.VALIDATION_ERROR);
    this.details = details;
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized access') {
    super(message, 401, ErrorCode.UNAUTHORIZED);
  }
}

/**
 * A single, generic authentication failure used for all login-failure conditions
 * (unknown account, wrong password, suspended account, locked account).
 *
 * Anti-enumeration / timing safety (Requirement 15): every login failure MUST surface a
 * byte-for-byte identical client response — same status code, same error code, and same
 * message — so an attacker cannot distinguish which of the four conditions occurred
 * (Req 15.2, 15.3). The fixed message and status here are intentionally hardcoded so the
 * response cannot vary across call sites. Server-side side effects (failed-attempt counting,
 * lockout, admin notification, warn logs) are handled by the caller and do not change this
 * client-visible response.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('Invalid credentials', 401, ErrorCode.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Permission denied') {
    super(message, 403, ErrorCode.FORBIDDEN);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, ErrorCode.NOT_FOUND);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, ErrorCode.CONFLICT);
  }
}

export class DatabaseError extends AppError {
  constructor(message = 'Database operation failed') {
    super(message, 500, ErrorCode.DATABASE_ERROR, false);
  }
}

export class SecurityError extends AppError {
  constructor(message: string) {
    super(message, 403, ErrorCode.SECURITY_ERROR);
  }
}
