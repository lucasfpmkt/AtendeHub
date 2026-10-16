import { io } from 'socket.io-client';
import { getToken } from './api';

// Conecta na mesma origem (em dev, o Vite faz proxy do /socket.io).
// O token é lido a cada tentativa de conexão (callback), então funciona
// mesmo que o login aconteça depois do carregamento da página.
export const socket = io({
  path: '/socket.io',
  autoConnect: false,
  auth: (cb) => cb({ token: getToken() ?? '' }),
});

export function connectSocket() {
  if (!socket.connected) socket.connect();
}
export function disconnectSocket() {
  if (socket.connected) socket.disconnect();
}
