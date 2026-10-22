/**
 * Limpa TODO o dado de atendimento de UM workspace (cliente), para recomeçar do zero.
 *
 * Apaga, apenas do workspace resolvido:
 *   ScheduledMessage → Message → Conversation → Deal → Contact
 * Mantém: Workspace, usuários, funis, etapas, agentes, etiquetas, respostas rápidas,
 *         regras de palavra-chave, campanhas, tarefas, agenda e todas as configurações.
 *
 * SEGURANÇA:
 *  - Resolve o cliente por CODE + NOME (os dois precisam bater). Aborta se achar 0 ou >1.
 *  - É DRY-RUN por padrão: só mostra o que seria apagado.
 *  - Só apaga de verdade se a env CONFIRM for EXATAMENTE o nome do workspace.
 *
 * Uso (dentro da pasta server/):
 *   # 1) Simulação (não apaga nada):
 *   WS_CODE=1004 WS_NAME="Cunha Domingues" npx tsx scripts/wipe-workspace.ts
 *
 *   # 2) Apagar de verdade:
 *   WS_CODE=1004 WS_NAME="Cunha Domingues" CONFIRM="Cunha Domingues" npx tsx scripts/wipe-workspace.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const WS_CODE = Number(process.env.WS_CODE ?? '0');
const WS_NAME = (process.env.WS_NAME ?? '').trim();
const CONFIRM = (process.env.CONFIRM ?? '').trim();

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

async function main() {
  if (!WS_CODE || !WS_NAME) fail('Defina WS_CODE e WS_NAME. Ex.: WS_CODE=1004 WS_NAME="Cunha Domingues"');

  // Resolve o workspace pelo code E pelo nome — os dois precisam bater.
  const matches = await prisma.workspace.findMany({ where: { code: WS_CODE } });
  if (matches.length === 0) fail(`Nenhum workspace com code #${WS_CODE}.`);
  if (matches.length > 1) fail(`Mais de um workspace com code #${WS_CODE}. Abortei por segurança.`);

  const ws = matches[0];
  if (ws.name.trim().toLowerCase() !== WS_NAME.toLowerCase()) {
    fail(`O workspace #${WS_CODE} se chama "${ws.name}", não "${WS_NAME}". Abortei — nome não confere.`);
  }

  const id = ws.id;
  console.log(`\nCliente alvo:  #${ws.code}  ${ws.name}`);
  console.log(`workspaceId:   ${id}\n`);

  // Ids das conversas deste workspace (para apagar as mensagens por conversationId).
  const convs = await prisma.conversation.findMany({ where: { workspaceId: id }, select: { id: true } });
  const convIds = convs.map((c) => c.id);

  const counts = {
    mensagensAgendadas: await prisma.scheduledMessage.count({ where: { workspaceId: id } }),
    mensagens: convIds.length ? await prisma.message.count({ where: { conversationId: { in: convIds } } }) : 0,
    conversas: convIds.length,
    negocios: await prisma.deal.count({ where: { workspaceId: id } }),
    contatos: await prisma.contact.count({ where: { workspaceId: id } }),
  };

  console.log('Será apagado:');
  console.log(`  • mensagens agendadas: ${counts.mensagensAgendadas}`);
  console.log(`  • mensagens:           ${counts.mensagens}`);
  console.log(`  • conversas:           ${counts.conversas}`);
  console.log(`  • negócios (CRM):      ${counts.negocios}`);
  console.log(`  • contatos:            ${counts.contatos}\n`);

  if (CONFIRM !== ws.name.trim()) {
    console.log('🟡 DRY-RUN: nada foi apagado.');
    console.log(`   Para apagar de verdade, rode de novo com: CONFIRM="${ws.name}"\n`);
    return;
  }

  // Exclusão atômica, na ordem de chave estrangeira, estritamente por este workspaceId.
  // Também marca importHistory=false: ao reconectar o WhatsApp, só entram mensagens
  // NOVAS — nada do histórico antigo do aparelho é puxado de volta.
  const [sched, msgs, conv, deals, contacts] = await prisma.$transaction([
    prisma.scheduledMessage.deleteMany({ where: { workspaceId: id } }),
    prisma.message.deleteMany({ where: { conversationId: { in: convIds } } }),
    prisma.conversation.deleteMany({ where: { workspaceId: id } }),
    prisma.deal.deleteMany({ where: { workspaceId: id } }),
    prisma.contact.deleteMany({ where: { workspaceId: id } }),
    prisma.workspace.update({ where: { id }, data: { importHistory: false } }),
  ]);

  console.log('✅ Limpeza concluída:');
  console.log(`   mensagens agendadas apagadas: ${sched.count}`);
  console.log(`   mensagens apagadas:           ${msgs.count}`);
  console.log(`   conversas apagadas:           ${conv.count}`);
  console.log(`   negócios apagados:            ${deals.count}`);
  console.log(`   contatos apagados:            ${contacts.count}`);
  console.log(`   importHistory → false (não puxa histórico antigo ao reconectar)\n`);
}

main()
  .catch((e) => fail(e instanceof Error ? e.message : String(e)))
  .finally(() => prisma.$disconnect());
