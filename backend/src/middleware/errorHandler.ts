import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[${req.method} ${req.path.replace(/[\r\n]/g, '_')}]`, err.message);

  if (res.headersSent) return;

  const status = (err as { status?: number }).status || 500;
  // Driver and library text (SQL, constraint names, paths) stays in the log;
  // the client of a 5xx gets a generic line (auth review L4).
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}
