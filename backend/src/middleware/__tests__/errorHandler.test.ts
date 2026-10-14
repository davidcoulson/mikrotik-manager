import { errorHandler } from '../errorHandler';
import type { Request, Response } from 'express';

function run(err: Error & { status?: number }) {
  const res = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  errorHandler(err, { method: 'GET', path: '/x' } as Request, res, jest.fn());
  return res;
}

// Auth review L4.
describe('errorHandler', () => {
  it('hides internal error text on a 500', () => {
    const res = run(new Error('invalid input syntax for type integer: "x"'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Internal server error' }));
  });

  it('keeps the message of a deliberate 4xx', () => {
    const res = run(Object.assign(new Error('Bad thing'), { status: 400 }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Bad thing' }));
  });
});
