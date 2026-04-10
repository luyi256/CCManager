import type { Response } from 'express';

export function errorResponse(res: Response, status: number, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ message, ...details });
}
