/**
 * Enxuga o atendimento de UM workspace: mantém só as N conversas mais recentes,
 * cada uma com as últimas M mensagens. Apaga o resto (conversas antigas, suas
 * mensagens, contatos e negócios que ficarem sem conversa). Não mexe no WhatsApp
 * do celular, nem em funis, etapas, agentes, etiquetas ou configurações.
 *
 * SEGURANÇA: resolve o cliente por WS_CODE + WS_NAME (os dois precisam bater);
 * DRY-RUN por padrão; só apaga com CONFIRM = nome exato do workspace.
 *
 * Uso (na pasta server/):
 *   WS_CODE=1006 WS_NAME="Camila Silva" npx tsx scripts/trim-workspace.ts
 *   WS_CODE=1006 WS_NAME="Camila Silva" CONFIRM="Camila Silva" npx tsx scripts/trim-workspace.ts
 * Opcional: KEEP_CHATS=30 KEEP_MSGS=10
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const WS_CODE = Number(process.env.WS_CODE ?? '0');
const WS_NAME = (process.env.WS_NAME ?? '').trim();
const CONFIRM = (process.env.CONFIRM ?? '').trim();
const KEEP_CHATS = Math.max(1, Number(process.env.KEEP_CHATS ?? 30) || 30);
const KEEP_MSGS = Math.max(1, Number(process.env.KEEP_MSGS ?? 10) || 10);
const BATCH = 500; // bem abaixo do limite de parâmetros do SQLite

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const chunks = <T,>(arr: T[]) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += BATCH) out.push(arr.slice(i, i + BATCH));
  return out;
};

async function main() {
  if (!WS_CODE || !WS_NAME) fail('Defina WS_CODE e WS_NAME.');
  const matches = await prisma.workspace.findMany({ where: { code: WS_CODE } });
  if (matches.length !== 1) fail(`Esperava 1 workspace com code #${WS_CODE}, achei ${matches.length}.`);
  const ws = matches[0];
  if (ws.name.trim().toLowerCase() !== WS_NAME.toLowerCase()) fail(`#${WS_CODE} se chama "${ws.name}", não "${WS_NAME}".`);
  const id = ws.id;

  const convs = await prisma.conversation.findMany({
    where: { workspaceId: id },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, contactId: true },
  });
  const keep = convs.slice(0, KEEP_CHATS);
  const drop = convs.slice(KEEP_CHATS);
  const keepConvIds = keep.map((c) => c.id);
  const dropConvIds = drop.map((c) => c.id);

  // Contatos que ficam sem nenhuma conversa mantida.
  const keepContactIds = new Set(keep.map((c) => c.contactId));
  const dropContactIds = [...new Set(drop.map((c) => c.contactId))].filter((cid) => !keepContactIds.has(cid));

  // Mensagens excedentes nas conversas mantidas (fica só as últimas KEEP_MSGS).
  const extraMsgIds: string[] = [];
  for (const cid of keepConvIds) {
    const old = await prisma.message.findMany({
      where: { conversationId: cid },
      orderBy: { createdAt: 'desc' },
      skip: KEEP_MSGS,
      select: { id: true },
    });
    extraMsgIds.push(...old.map((m) => m.id));
  }

  let dropMsgCount = 0;
  for (const b of chunks(dropConvIds)) dropMsgCount += await prisma.message.count({ where: { conversationId: { in: b } } });
  let dropDealCount = 0;
  for (const b of chunks(dropContactIds)) dropDealCount += await prisma.deal.count({ where: { workspaceId: id, contactId: { in: b } } });

  console.log(`\nCliente alvo:  #${ws.code}  ${ws.name}   (workspaceId ${id})`);
  console.log(`Mantém: ${keep.length} conversas mais recentes, até ${KEEP_MSGS} mensagens cada\n`);
  console.log('Será apagado:');
  console.log(`  • conversas antigas:              ${dropConvIds.length}`);
  console.log(`  • mensagens dessas conversas:     ${dropMsgCount}`);
  console.log(`  • mensagens antigas nas mantidas: ${extraMsgIds.length}`);
  console.log(`  • contatos sem conversa:          ${dropContactIds.length}`);
  console.log(`  • negócios desses contatos:       ${dropDealCount}\n`);

  if (CONFIRM !== ws.name.trim()) {
    console.log(`🟡 DRY-RUN: nada foi apagado. Para apagar: CONFIRM="${ws.name}"\n`);
    return;
  }

  // Tudo numa transação; cada operação em lotes para respeitar o limite do SQLite.
  const ops = [
    ...chunks(dropConvIds).map((b) => prisma.scheduledMessage.deleteMany({ where: { workspaceId: id, conversationId: { in: b } } })),
    ...chunks(dropConvIds).map((b) => prisma.message.deleteMany({ where: { conversationId: { in: b } } })),
    ...chunks(extraMsgIds).map((b) => prisma.message.deleteMany({ where: { id: { in: b } } })),
    ...chunks(dropConvIds).map((b) => prisma.conversation.deleteMany({ where: { workspaceId: id, id: { in: b } } })),
    ...chunks(dropContactIds).map((b) => prisma.deal.deleteMany({ where: { workspaceId: id, contactId: { in: b } } })),
    ...chunks(dropContactIds).map((b) => prisma.contact.deleteMany({ where: { workspaceId: id, id: { in: b } } })),
  ];
  await prisma.$transaction(ops);

  const left = await prisma.conversation.count({ where: { workspaceId: id } });
  console.log(`✅ Concluído. Conversas restantes: ${left}\n`);
}

main()
  .catch((e) => fail(e instanceof Error ? e.message : String(e)))
  .finally(() => prisma.$disconnect());
