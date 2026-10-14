export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export const badRequest = (m: string, d?: unknown) => new AppError(400, 'BAD_REQUEST', m, d);
export const unauthorized = (m = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', m);
export const forbidden = (m: string) => new AppError(403, 'FORBIDDEN', m);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, m: string, d?: unknown) => new AppError(409, code, m, d);
export const invalidState = (m: string) => new AppError(409, 'INVALID_STATE', m);
export const staleVersion = (expected: number, actual: number) =>
  new AppError(409, 'STALE_VERSION', `Record changed (you have v${expected}, current is v${actual}). Reload or raise an amendment.`, { expected, actual });
