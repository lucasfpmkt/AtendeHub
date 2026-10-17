import type { Server as IOServer } from 'socket.io';

// Guarda a instância do socket.io para que qualquer módulo possa emitir
// eventos em tempo real. Cada cliente (workspace) tem a própria sala:
// um escritório nunca recebe eventos de outro.
let io: IOServer | null = null;

export function setIO(instance: IOServer) {
  io = instance;
}

export const roomOf = (workspaceId: string) => `ws:${workspaceId}`;

export type WaStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

export type RealtimeEvent =
  | { type: 'wa:qr'; dataUrl: string }
  | { type: 'wa:status'; status: WaStatus; me?: string }
  | { type: 'message:new'; conversationId: string; message: unknown }
  | { type: 'conversation:update'; conversation: unknown };

export function emit(workspaceId: string, event: RealtimeEvent) {
  io?.to(roomOf(workspaceId)).emit(event.type, event);
}
