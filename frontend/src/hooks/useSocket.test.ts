import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: () => null,
    length: 0,
  };
});

const sockets: Array<{ disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }> = [];
vi.mock('socket.io-client', () => ({
  io: () => {
    const s = { on: vi.fn(), off: vi.fn(), connect: vi.fn(), disconnect: vi.fn() };
    s.disconnect.mockReturnValue(s);
    sockets.push(s);
    return s;
  },
}));

import { useAuthStore } from '../store/authStore';
import { getSocket, ensureSocket } from './useSocket';

describe('shared socket lifecycle', () => {
  beforeEach(() => { sockets.length = 0; useAuthStore.getState().logout(); });

  it('drops the socket on logout so the next login gets a fresh one', () => {
    useAuthStore.getState().setAuth('a', { id: 1, username: 'a', role: 'admin' });
    ensureSocket();
    expect(getSocket()).toBe(sockets[0]);
    useAuthStore.getState().logout();
    expect(sockets[0].disconnect).toHaveBeenCalled();
    expect(getSocket()).toBeNull();
    useAuthStore.getState().setAuth('b', { id: 2, username: 'b', role: 'admin' });
    ensureSocket();
    expect(getSocket()).toBe(sockets[1]);
  });
});
