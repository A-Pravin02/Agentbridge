// ============================================
// AgentBridge - Typed Errors
// ============================================
// Every failure carries a stable machine-readable code and an HTTP status.
// External messages are deliberately generic for security failures: a caller
// must not be able to distinguish "no such agent" from "wrong signature", or
// learn which internal threshold it tripped.

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Extra fields merged into the response body. Must contain nothing sensitive. */
  readonly meta?: Record<string, unknown>;

  constructor(statusCode: number, code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.meta = meta;
  }
}

export class ValidationError extends AppError {
  readonly details: Array<{ path: string; message: string }>;
  constructor(details: Array<{ path: string; message: string }>) {
    super(400, 'VALIDATION_FAILED', 'Request validation failed');
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, 'NOT_FOUND', `${resource} not found`);
    this.name = 'NotFoundError';
  }
}

/** 401 — we do not know who you are. */
export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHENTICATED', message);
    this.name = 'UnauthenticatedError';
  }
}

/** 403 — we know who you are and you may not do this. */
export class ForbiddenError extends AppError {
  constructor(message = 'Not permitted', code = 'FORBIDDEN', meta?: Record<string, unknown>) {
    super(403, code, message, meta);
    this.name = 'ForbiddenError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', meta?: Record<string, unknown>) {
    super(409, code, message, meta);
    this.name = 'ConflictError';
  }
}

/**
 * A security control refused the request.
 *
 * The external message is always the same generic sentence; the specific
 * violation stays server-side in the audit trail and the incident record.
 * `violation` is exposed as a coarse code only where it does not leak
 * internal state.
 */
export class SecurityError extends AppError {
  readonly violation: string;
  constructor(violation: string, statusCode = 403, publicMessage = 'Request rejected by security policy') {
    super(statusCode, violation, publicMessage);
    this.name = 'SecurityError';
    this.violation = violation;
  }
}

export class StateError extends AppError {
  constructor(message: string, meta?: Record<string, unknown>) {
    super(409, 'INVALID_STATE', message, meta);
    this.name = 'StateError';
  }
}
