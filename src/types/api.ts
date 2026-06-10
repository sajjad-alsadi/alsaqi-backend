/**
 * Shared API response types and interfaces for the AL-SAQI unified response envelope.
 * These types ensure consistent response structure across all API endpoints.
 */

/**
 * Unified API response envelope.
 * All JSON responses from the API follow this structure.
 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T | null;
  error?: ApiError;
  meta?: ResponseMeta;
}

/**
 * Structured error object included in error responses (status >= 400).
 */
export interface ApiError {
  code: string;
  message: string;
  details?: any;
  traceId: string;
}

/**
 * Response metadata included in every API response.
 */
export interface ResponseMeta {
  pagination?: PaginationMeta;
  requestId: string;
  timestamp: string;
  version: string;
}

/**
 * Unified pagination metadata returned in list endpoint responses.
 * Computed from page, pageSize, and total record count.
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Error response type alias for convenience.
 */
export interface ErrorResponse {
  success: false;
  data: null;
  error: ApiError;
  meta: ResponseMeta;
}

/**
 * Success response type alias for convenience.
 */
export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  error?: undefined;
  meta: ResponseMeta;
}

/**
 * Health check status for the comprehensive health endpoint.
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    database: SubsystemCheck;
    redis: SubsystemCheck;
    filesystem: SubsystemCheck;
    memory: SubsystemCheck;
    websocket: SubsystemCheck;
    cron: SubsystemCheck;
  };
  uptime: number;
  version: string;
}

/**
 * Individual subsystem health check result.
 */
export interface SubsystemCheck {
  status: 'ok' | 'fail' | 'timeout';
  latency: number;
  details?: Record<string, any>;
}
