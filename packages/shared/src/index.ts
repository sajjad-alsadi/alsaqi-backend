// @alsaqi/shared - Shared types, validators, and constants
// This is the single entry point for all shared exports

// Types
export * from './types/api';
export * from './types/models';
export * from './types/enums';
export * from './types/endpoints';

// Validators (Zod schemas for request validation)
export * from './validators';

// Constants (Error codes, module names, API version)
export * from './constants';

// Public surface fingerprint (deterministic SHA-256 over the canonicalized public surface)
export { computeSharedSurfaceFingerprint } from './fingerprint';
