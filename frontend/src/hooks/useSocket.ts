import { useEffect, useLayoutEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store/authStore';

let globalSocket: Socket | null = null;

// A new token (password change, another sign-in) reconnects the socket with it
// straight away; the server re-checks the session on connect (U8). Logout (or
// any token change away from a user) drops the socket here, not in a component
// effect, because the consuming pages unmount in the same commit.
useAuthStore.subscribe((state, prev) => {
  if (state.token === prev.token || !globalSocket) return;
  if (!state.token) {
    globalSocket.disconnect();
    globalSocket = null;
  } else if (prev.token) {
    globalSocket.disconnect().connect();
  } else {
    // null -> token with a leftover socket: never reuse a previous session's.
    globalSocket.disconnect();
    globalSocket = null;
  }
});

export function getSocket(): Socket | null {
  return globalSocket;
}

/** Create the shared socket if there is none (exported for tests). */
export function ensureSocket(): Socket {
  if (!globalSocket) {
    globalSocket = io('/', {
      path: '/socket.io',
      // Read at every (re)connect, never frozen (outside review U8): a token
      // reissued by a password change, or a new sign-in, is what the socket
      // presents next time, instead of the old one that the server refuses.
      auth: (cb) => cb({ token: useAuthStore.getState().token }),
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
    });
  }
  return globalSocket;
}

export function useSocket(
  events: Record<string, (data: unknown) => void>
): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const eventsRef = useRef(events);
  useLayoutEffect(() => { eventsRef.current = events; });

  useEffect(() => {
    if (!isAuthenticated) {
      // Drop the shared socket on logout so a later login reconnects with a fresh token.
      if (globalSocket) {
        globalSocket.disconnect();
        globalSocket = null;
      }
      return;
    }

    const socket = ensureSocket();
    const handlers: Array<[string, (d: unknown) => void]> = [];

    for (const event of Object.keys(eventsRef.current)) {
      // Look the handler up at call time so state-dependent callers are never stale.
      const wrapped = (data: unknown) => eventsRef.current[event]?.(data);
      socket.on(event, wrapped);
      handlers.push([event, wrapped]);
    }

    return () => {
      for (const [event, handler] of handlers) {
        socket.off(event, handler);
      }
    };
  }, [isAuthenticated]);
}
