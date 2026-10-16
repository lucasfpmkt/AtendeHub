import type { Server as IOServer } from 'socket.io';

// Guarda a instância do socket.io para que qualquer módulo possa emitir
// eventos em tempo real para o frontend (QR, status, novas mensagens).
let io: IOServer | null = null;

export function setIO(instance: IOServer) {
  io = instance;
}

export type RealtimeEvent =
  | { type: 'wa:qr'; dataUrl: string }
  | { type: 'wa:status'; status: WaStatus; me?: string }
  | { type: 'message:new'; conversationId: string; message: unknown }
  | { type: 'conversation:update'; conversation: unknown };

export type WaStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

export function emit(event: RealtimeEvent) {
  io?.emit(event.type, event);
}
