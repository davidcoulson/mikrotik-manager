import { createShutdown } from '../shutdown';

describe('createShutdown', () => {
  it('runs every step even when one throws, then exits non-zero', async () => {
    const ran: string[] = [];
    const exit = jest.fn();
    const sd = createShutdown([
      { name: 'a', run: () => { ran.push('a'); throw new Error('boom'); } },
      { name: 'b', run: async () => { ran.push('b'); } },
    ], { exit, log: () => undefined });
    await sd();
    expect(ran).toEqual(['a', 'b']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 0 on success and ignores a second signal', async () => {
    const run = jest.fn();
    const exit = jest.fn();
    const sd = createShutdown([{ name: 'a', run }], { exit, log: () => undefined });
    await sd(); await sd();
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces exit when a step hangs', async () => {
    jest.useFakeTimers();
    const exit = jest.fn();
    const sd = createShutdown([{ name: 'hang', run: () => new Promise(() => undefined) }],
      { exit, timeoutMs: 1000, log: () => undefined });
    void sd();
    await jest.advanceTimersByTimeAsync(1001);
    expect(exit).toHaveBeenCalledWith(1);
    jest.useRealTimers();
  });
});
