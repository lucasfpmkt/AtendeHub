import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { enc, dec } from '../crypto.js';
import { env } from '../env.js';
import { emit } from '../realtime.js';

/**
 * Leads de formulário → CRM.
 *  - Meta Lead Ads: o Meta avisa pelo webhook "leadgen" (instantâneo) e, por
 *    segurança, o LawHub também busca os leads novos a cada 10 minutos.
 *  - Entrada externa (Zapier/Make/site): POST com JSON num endereço com chave.
 * Cada lead vira contato + negócio na etapa escolhida, sem duplicar.
 */

const GRAPH = `https://graph.facebook.com/${env.graphVersion}`;
const LEAD_FIELDS = 'id,created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id,platform,is_organic';

export interface LeadIn {
  externalId: string;
  source: 'meta' | 'externo';
  name?: string;
  phone?: string;
  email?: string;
  answers: { q: string; a: string }[];
  formName?: string;
  campaign?: string;
  ad?: string;
  platform?: string;
  createdAt?: Date; // quando o lead preencheu (Meta); ausente = agora
}

/* ------------------------------- Telefone -------------------------------- */

// DDDs válidos no Brasil.
const DDDS = new Set(
  '11 12 13 14 15 16 17 18 19 21 22 24 27 28 31 32 33 34 35 37 38 41 42 43 44 45 46 47 48 49 51 53 54 55 61 62 63 64 65 66 67 68 69 71 73 74 75 77 79 81 82 83 84 85 86 87 88 89 91 92 93 94 95 96 97 98 99'.split(' '),
);
// Códigos de operadora usados em discagem de longa distância (0 + XX + DDD + número).
const CARRIERS = new Set(['12', '14', '15', '21', '23', '25', '31', '41', '43']);

/**
 * Número em dígitos com DDI, corrigindo os erros comuns de quem preenche
 * formulário: sem DDI, com 0 ou código de operadora na frente, DDI repetido e,
 * principalmente, celular sem o 9 (55 + DDD + 8 dígitos começando com 6–9).
 */
export function normalizePhone(raw?: string | null): string {
  const str = String(raw ?? '').trim();
  let d = str.replace(/\D/g, '');
  if (!d) return '';
  // Número internacional explícito (+DDI que não é 55): mantém como veio.
  if (str.startsWith('+') && !d.startsWith('55')) return d.length >= 8 && d.length <= 15 ? d : '';
  d = d.replace(/^0+/, '');
  if (d.startsWith('5555') && (d.length === 14 || d.length === 15)) d = d.slice(2); // DDI digitado duas vezes
  // 0 + operadora + DDD + número (ex.: 0 15 11 98888-7777)
  if (!d.startsWith('55') && (d.length === 12 || d.length === 13) && CARRIERS.has(d.slice(0, 2)) && DDDS.has(d.slice(2, 4))) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    let rest = d.slice(4);
    if (!DDDS.has(ddd)) return d; // DDD inválido: mantém como veio
    // Celular sem o 9: 8 dígitos começando com 6, 7, 8 ou 9 → acrescenta o 9.
    if (rest.length === 8 && /^[6-9]/.test(rest)) rest = `9${rest}`;
    return `55${ddd}${rest}`;
  }
  return d.length >= 10 && d.length <= 15 ? d : '';
}

/** Variante do celular brasileiro com/sem o 9º dígito (o WhatsApp usa as duas). */
export function brVariant(digits: string): string | null {
  if (!digits.startsWith('55')) return null;
  const ddd = digits.slice(2, 4);
  const rest = digits.slice(4);
  if (rest.length === 9 && rest.startsWith('9')) return `55${ddd}${rest.slice(1)}`;
  if (rest.length === 8 && /^[6-9]/.test(rest)) return `55${ddd}9${rest}`;
  return null;
}

/**
 * JID que o contato já usa no LawHub: se existir um contato com a variante do
 * número (com/sem 9º dígito), reaproveita — assim o lead do formulário e a
 * conversa do WhatsApp caem no mesmo contato.
 */
export async function canonicalJid(ws: string, waJid: string): Promise<string> {
  if (!waJid.endsWith('@s.whatsapp.net')) return waJid;
  const exists = await prisma.contact.findUnique({ where: { workspaceId_waJid: { workspaceId: ws, waJid } }, select: { id: true } });
  if (exists) return waJid;
  const alt = brVariant(waJid.split('@')[0]);
  if (!alt) return waJid;
  const altJid = `${alt}@s.whatsapp.net`;
  const other = await prisma.contact.findUnique({ where: { workspaceId_waJid: { workspaceId: ws, waJid: altJid } }, select: { id: true } });
  return other ? altJid : waJid;
}

/* ------------------------------- Mapeamento ------------------------------ */

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

const NAME_KEYS = ['full_name', 'nome_completo', 'nome', 'name', 'seu_nome', 'nome_e_sobrenome'];
const FIRST_KEYS = ['first_name', 'primeiro_nome'];
const LAST_KEYS = ['last_name', 'sobrenome'];
const PHONE_KEYS = ['phone_number', 'phone', 'telefone', 'celular', 'whatsapp', 'telefone_whatsapp', 'numero_de_telefone', 'mobile', 'tel'];
const EMAIL_KEYS = ['email', 'e_mail', 'mail'];
const IGNORE_KEYS = new Set(['id', 'lead_id', 'leadgen_id', 'form', 'form_name', 'formulario', 'campaign', 'campaign_name', 'campanha', 'ad', 'ad_name', 'anuncio', 'created_time', 'platform', 'key']);

/** "qual_o_seu_problema?" → "Qual o seu problema?" */
export function prettyQuestion(key: string): string {
  const t = key.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : key;
}

/** Pares pergunta/resposta → nome, telefone, e-mail e as demais respostas. */
export function mapAnswers(pairs: { key: string; value: string }[]) {
  let name = '';
  let first = '';
  let last = '';
  let phone = '';
  let email = '';
  const answers: { q: string; a: string }[] = [];
  for (const { key, value } of pairs) {
    const v = String(value ?? '').trim();
    if (!v) continue;
    const k = norm(key);
    if (!name && NAME_KEYS.includes(k)) name = v;
    else if (!first && FIRST_KEYS.includes(k)) first = v;
    else if (!last && LAST_KEYS.includes(k)) last = v;
    else if (!phone && PHONE_KEYS.includes(k)) phone = v;
    else if (!email && EMAIL_KEYS.includes(k)) email = v;
    else if (!IGNORE_KEYS.has(k)) answers.push({ q: prettyQuestion(key), a: v });
  }
  // Campos com nomes livres ("Número do WhatsApp", "Seu celular", "E-mail para contato"…):
  // procura pelo nome do campo e, por último, pelo conteúdo da resposta.
  const take = (test: (q: string, a: string) => boolean) => {
    const i = answers.findIndex((x) => test(norm(x.q), x.a));
    return i >= 0 ? answers.splice(i, 1)[0].a : '';
  };
  const looksPhone = (a: string) => {
    const d = a.replace(/\D/g, '');
    return d.length >= 10 && d.length <= 13 && /^[\d\s()+.-]+$/.test(a.trim());
  };
  if (!phone) phone = take((q, a) => /(telefone|celular|whats|zap|fone|phone|contato|numero)/.test(q) && looksPhone(a));
  if (!phone) phone = take((_q, a) => looksPhone(a));
  if (!email) email = take((q, a) => /mail/.test(q) && /@/.test(a)) || take((_q, a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.trim()));
  if (!name && !first) name = take((q) => /(^|_)(nome|name)(_|$)/.test(q) && !/empresa|company|razao/.test(q));
  if (!name) name = [first, last].filter(Boolean).join(' ');
  return { name, phone, email, answers };
}

/** Lead da Graph API (field_data) → LeadIn. */
export function leadFromGraph(lead: any, formName = ''): LeadIn {
  const pairs = (lead?.field_data ?? []).map((f: any) => ({
    key: String(f?.name ?? ''),
    value: (Array.isArray(f?.values) ? f.values.join(', ') : String(f?.values ?? ''))
      // Opções de múltipla escolha vêm como "parcelas_atrasadas": deixa legível.
      .split(', ')
      .map((v: string) => (!/\s/.test(v) && v.includes('_') && !/@/.test(v) ? v.replace(/_/g, ' ') : v))
      .join(', '),
  }));
  const m = mapAnswers(pairs);
  return {
    externalId: String(lead.id),
    source: 'meta',
    ...m,
    formName,
    campaign: lead.campaign_name || '',
    ad: lead.ad_name || '',
    platform: lead.platform || '',
    createdAt: lead.created_time ? new Date(lead.created_time) : undefined,
  };
}

/** JSON livre (Zapier/Make/site) → LeadIn. */
export function leadFromPayload(body: any): LeadIn {
  if (Array.isArray(body?.field_data)) {
    const l = leadFromGraph({ ...body, id: body.id || body.leadgen_id || '' }, body.form_name || body.formulario || '');
    l.source = 'externo';
    if (!l.externalId) l.externalId = fallbackId(body);
    return l;
  }
  const flat: { key: string; value: string }[] = [];
  const walk = (obj: any, prefix = '') => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v == null) continue;
      if (typeof v === 'object' && !Array.isArray(v)) walk(v, prefix ? `${prefix}_${k}` : k);
      else flat.push({ key: prefix ? `${prefix}_${k}` : k, value: Array.isArray(v) ? v.join(', ') : String(v) });
    }
  };
  walk(body);
  const m = mapAnswers(flat);
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const hit = flat.find((f) => norm(f.key) === k);
      if (hit?.value) return hit.value;
    }
    return '';
  };
  return {
    externalId: pick('lead_id', 'leadgen_id', 'id') || fallbackId(body),
    source: 'externo',
    ...m,
    formName: pick('form_name', 'formulario', 'form'),
    campaign: pick('campaign_name', 'campanha', 'campaign'),
    ad: pick('ad_name', 'anuncio', 'ad'),
  };
}

// Sem id: mesmo conteúdo no mesmo minuto conta como o mesmo lead (reenvio).
const fallbackId = (body: unknown) =>
  'x_' + createHash('sha256').update(JSON.stringify(body ?? {}) + Math.floor(Date.now() / 60_000)).digest('hex').slice(0, 24);

/* ------------------------------- Ingestão -------------------------------- */

async function targetStage(ws: string, cfg: { funnelId: string; stageId: string } | null) {
  if (cfg?.stageId) {
    const st = await prisma.pipelineStage.findFirst({ where: { id: cfg.stageId, workspaceId: ws } });
    if (st) return { funnelId: st.funnelId, stageId: st.id };
  }
  const funnel =
    (cfg?.funnelId && (await prisma.funnel.findFirst({ where: { id: cfg.funnelId, workspaceId: ws } }))) ||
    (await prisma.funnel.findFirst({ where: { workspaceId: ws }, orderBy: { order: 'asc' } }));
  if (!funnel) return null;
  const st = await prisma.pipelineStage.findFirst({ where: { funnelId: funnel.id }, orderBy: { order: 'asc' } });
  return { funnelId: funnel.id, stageId: st?.id ?? null };
}

const addTags = (current: string, add: string[]) => {
  const list = current.split(',').map((t) => t.trim()).filter(Boolean);
  const seen = new Set(list.map((t) => t.toLowerCase()));
  for (const t of add) if (t && !seen.has(t.toLowerCase())) list.push(t), seen.add(t.toLowerCase());
  return list.join(', ');
};

const ingestLocks = new Set<string>();

/** Cria contato + negócio para o lead (idempotente pelo externalId). */
export async function ingestLead(ws: string, lead: LeadIn): Promise<{ created: boolean; entryId?: string }> {
  const lockKey = `${ws}:${lead.externalId}`;
  if (ingestLocks.has(lockKey)) return { created: false };
  ingestLocks.add(lockKey);
  try {
    const dup = await prisma.leadFormEntry.findUnique({ where: { workspaceId_externalId: { workspaceId: ws, externalId: lead.externalId } } });
    if (dup) return { created: false, entryId: dup.id };

    const cfg = await prisma.leadFormConfig.findUnique({ where: { id: ws } });
    const phone = normalizePhone(lead.phone);
    const sourceLabel = lead.source === 'meta' ? 'Formulário Meta' : 'Formulário';
    const tags = [sourceLabel];

    // Contato: pelo número (com/sem 9º dígito); sem telefone, um contato só do formulário.
    // Confere no WhatsApp o JID real (com ou sem o 9); sem conexão, usa o número corrigido.
    let waJid = `form:${lead.externalId}`;
    if (phone) {
      const { resolveWaJid } = await import('../whatsapp/session.js');
      const alt = brVariant(phone);
      const real = await resolveWaJid(ws, alt ? [phone, alt] : [phone]).catch(() => null);
      waJid = await canonicalJid(ws, real ?? `${phone}@s.whatsapp.net`);
    }
    const noteLines = [
      `📋 ${sourceLabel}${lead.formName ? ` — ${lead.formName}` : ''} (${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`,
      lead.campaign ? `Campanha: ${lead.campaign}${lead.ad ? ` · Anúncio: ${lead.ad}` : ''}` : '',
      lead.email ? `E-mail: ${lead.email}` : '',
      ...lead.answers.map((x) => `• ${x.q}: ${x.a}`),
    ].filter(Boolean);
    const note = noteLines.join('\n');

    const existing = await prisma.contact.findUnique({ where: { workspaceId_waJid: { workspaceId: ws, waJid } } });
    const contact = existing
      ? await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: existing.name || lead.name || undefined,
            tags: addTags(existing.tags ?? '', tags),
            notes: [existing.notes?.trim(), note].filter(Boolean).join('\n\n'),
          },
        })
      : await prisma.contact.create({
          data: { workspaceId: ws, waJid, phone, name: lead.name || null, tags: addTags('', tags), notes: note },
        });
    for (const t of tags) {
      const has = await prisma.tag.findFirst({ where: { workspaceId: ws, name: t } });
      if (!has) await prisma.tag.create({ data: { workspaceId: ws, name: t, color: '#1877f2' } }).catch(() => {});
    }

    // Negócio: um por contato no funil escolhido (se já tiver, só atualiza).
    let dealId: string | null = null;
    const target = await targetStage(ws, cfg);
    if (target) {
      const open = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId: contact.id, funnelId: target.funnelId } });
      if (open) {
        dealId = open.id;
        await prisma.deal.update({ where: { id: open.id }, data: { tags: addTags(open.tags ?? '', tags) } });
      } else {
        const deal = await prisma.deal.create({
          data: {
            workspaceId: ws,
            title: lead.name || (phone ? `+${phone}` : 'Lead de formulário'),
            contactId: contact.id,
            funnelId: target.funnelId,
            stageId: target.stageId,
            source: sourceLabel,
            tags: addTags('', [...tags, lead.campaign ?? ''].filter(Boolean)),
            stageSince: new Date(),
          },
        });
        dealId = deal.id;
        if (target.stageId) {
          await prisma.contact.update({ where: { id: contact.id }, data: { stageId: target.stageId } }).catch(() => {});
          const { syncStageTag } = await import('./inbound.js');
          await syncStageTag(ws, contact.id, target.stageId).catch(() => {});
        }
      }
    }

    const entry = await prisma.leadFormEntry.create({
      data: {
        workspaceId: ws,
        externalId: lead.externalId,
        source: lead.source,
        name: lead.name ?? '',
        phone,
        email: lead.email ?? '',
        formName: lead.formName ?? '',
        campaign: lead.campaign ?? '',
        answers: JSON.stringify(lead.answers),
        contactId: contact.id,
        dealId,
      },
    });
    emit(ws, { type: 'crm:update' });
    console.log(`[leadforms:${ws}] lead ${lead.externalId} → contato ${contact.id}${dealId ? ` / negócio ${dealId}` : ''}`);

    if (cfg?.notify ?? true) notifyFormLead(ws, lead, phone).catch((e) => console.warn(`[leadforms:${ws}] aviso falhou:`, e.message));
    // IA manda a 1ª mensagem — só para lead recente (a busca de 7 dias não dispara para leads antigos).
    const fresh = !lead.createdAt || Date.now() - lead.createdAt.getTime() < 60 * 60_000;
    if (cfg?.aiOutreach && phone && fresh) {
      const { startAiOutreach } = await import('./inbound.js');
      startAiOutreach(ws, contact.id, cfg.aiAgentId, outreachContext(lead), lead.formName ?? '').catch((e) =>
        console.warn(`[leadforms:${ws}] IA não iniciou a conversa:`, e.message),
      );
    }
    return { created: true, entryId: entry.id };
  } catch (err) {
    // Corrida com outro processo inserindo o mesmo lead: trata como duplicado.
    if ((err as { code?: string }).code === 'P2002') return { created: false };
    throw err;
  } finally {
    ingestLocks.delete(lockKey);
  }
}

/** Contexto que a IA recebe para escrever a 1ª mensagem ao lead do formulário. */
export function outreachContext(lead: LeadIn): string {
  return [
    '[CONTEXTO PARA A IA — não é uma mensagem do lead]',
    `Esta pessoa acabou de preencher um formulário${lead.formName ? ` ("${lead.formName}")` : ''} de anúncio${lead.campaign ? ` da campanha "${lead.campaign}"` : ''} e ainda não falou com o escritório no WhatsApp.`,
    lead.name ? `Nome: ${lead.name}` : '',
    ...(lead.answers.length ? ['Respostas do formulário:', ...lead.answers.map((x) => `- ${x.q}: ${x.a}`)] : []),
    '',
    'Escreva a PRIMEIRA mensagem do escritório para ela, seguindo o seu roteiro: cumprimente pelo primeiro nome, diga que recebeu o cadastro do formulário, use as respostas acima para não repetir perguntas já respondidas e faça a próxima pergunta do roteiro. Mensagem curta, de WhatsApp.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Aviso no WhatsApp do escritório (mesmo destino do "lead qualificado"). */
async function notifyFormLead(ws: string, lead: LeadIn, phone: string) {
  const { notifyTarget, formatPhone } = await import('./leadNotify.js');
  const ai = await prisma.aiConfig.findUnique({ where: { id: ws }, select: { notifyNumber: true } });
  const to = await notifyTarget(ws, ai?.notifyNumber ?? '');
  if (!to) return;
  const info = [
    `👤 *Nome:* ${lead.name || '—'}`,
    `📱 *Telefone:* ${phone ? formatPhone(phone) : '—'}`,
    lead.email ? `✉️ *E-mail:* ${lead.email}` : '',
    lead.formName ? `🗂️ *Formulário:* ${lead.formName}` : '',
    lead.campaign ? `📣 *Campanha:* ${lead.campaign}` : '',
  ].filter(Boolean);
  const answers = lead.answers.slice(0, 12).map((x) => `• ${x.q}: ${x.a}`);
  const text = ['📋 *Novo lead de formulário*', '', ...info, ...(answers.length ? ['', '📝 *Respostas*', ...answers] : [])].join('\n');
  const { sendText } = await import('../whatsapp/session.js');
  await sendText(ws, to, text);
}

/* ------------------------------- Graph API ------------------------------- */

async function graph(path: string, token: string, init?: RequestInit) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`, init);
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || d?.error) throw new Error(d?.error?.message || `Meta respondeu ${r.status}`);
  return d;
}

/** Permissões de formulário concedidas no login do Meta. */
export async function leadScopesOk(userToken: string): Promise<boolean> {
  try {
    const d = await graph('me/permissions', userToken);
    const granted = new Set((d?.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission));
    return ['leads_retrieval', 'pages_show_list', 'pages_manage_metadata'].every((p) => granted.has(p));
  } catch {
    return false;
  }
}

/** Se o token é de uma PÁGINA (e não de usuário), devolve a própria página. */
async function pageOfToken(token: string): Promise<{ id: string; name: string; token: string } | null> {
  try {
    const me = await graph('me?fields=id,name,category', token);
    return me?.category ? { id: String(me.id), name: String(me.name ?? me.id), token } : null;
  } catch {
    return null;
  }
}

/** Páginas acessíveis com o token (usuário/usuário do sistema → me/accounts; token de página → ela mesma). */
export async function listPages(userToken: string): Promise<{ id: string; name: string; token: string }[]> {
  try {
    const d = await graph('me/accounts?fields=id,name,access_token&limit=100', userToken);
    const pages = (d?.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id), token: String(p.access_token ?? '') }));
    if (pages.length) return pages;
  } catch (err) {
    const page = await pageOfToken(userToken);
    if (page) return [page];
    throw err;
  }
  const page = await pageOfToken(userToken);
  return page ? [page] : [];
}

/** Token pronto para formulários: com as permissões de leads ou de uma página. */
export async function tokenReadyForLeads(token: string): Promise<boolean> {
  if (await leadScopesOk(token)) return true;
  // Token de usuário do sistema nem sempre lista as permissões em /me/permissions:
  // se ele enxerga ao menos uma página, libera — e qualquer permissão faltando
  // aparece como erro do Meta na busca dos leads.
  try {
    return (await listPages(token)).length > 0;
  } catch {
    return false;
  }
}

/** Assina o webhook "leadgen" do app na página. */
export async function subscribePage(pageId: string, pageToken: string) {
  await graph(`${pageId}/subscribed_apps?subscribed_fields=leadgen`, pageToken, { method: 'POST' });
}

const formNames = new Map<string, string>();
async function formName(formId: string, token: string) {
  if (!formId) return '';
  if (formNames.has(formId)) return formNames.get(formId)!;
  try {
    const d = await graph(`${formId}?fields=name`, token);
    formNames.set(formId, d?.name ?? '');
    return d?.name ?? '';
  } catch {
    return '';
  }
}

/** Busca e importa os leads da página desde `since` (todas as páginas de resultado). */
export async function pullLeads(ws: string, since: Date): Promise<{ found: number; created: number }> {
  const cfg = await prisma.leadFormConfig.findUnique({ where: { id: ws } });
  if (!cfg?.pageId || !cfg.pageToken) throw new Error('Escolha a página do Facebook primeiro.');
  const token = dec(cfg.pageToken);
  const filter = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(since.getTime() / 1000) }]));
  let found = 0;
  let created = 0;
  try {
    const forms = await graph(`${cfg.pageId}/leadgen_forms?fields=id,name&limit=100`, token);
    for (const f of forms?.data ?? []) {
      formNames.set(String(f.id), f.name ?? '');
      let next: string | null = `${f.id}/leads?fields=${LEAD_FIELDS}&filtering=${filter}&limit=100`;
      for (let page = 0; next && page < 20; page++) {
        const d: any = await graph(next, token);
        for (const l of d?.data ?? []) {
          found++;
          const r = await ingestLead(ws, leadFromGraph(l, f.name ?? ''));
          if (r.created) created++;
        }
        const after = d?.paging?.cursors?.after;
        next = d?.paging?.next && after ? `${f.id}/leads?fields=${LEAD_FIELDS}&filtering=${filter}&limit=100&after=${encodeURIComponent(after)}` : null;
      }
    }
    await prisma.leadFormConfig.update({ where: { id: ws }, data: { lastPollAt: new Date(), lastError: '' } });
  } catch (err) {
    await prisma.leadFormConfig.update({ where: { id: ws }, data: { lastError: (err as Error).message.slice(0, 300) } }).catch(() => {});
    throw err;
  }
  return { found, created };
}

/** Evento do webhook: busca o lead pelo id e importa em todo cliente ligado àquela página. */
export async function handleLeadgenEvent(pageId: string, leadgenId: string, formId?: string) {
  const cfgs = await prisma.leadFormConfig.findMany({ where: { pageId, enabled: true } });
  for (const cfg of cfgs) {
    try {
      const token = dec(cfg.pageToken);
      const lead = await graph(`${leadgenId}?fields=${LEAD_FIELDS}`, token);
      await ingestLead(cfg.id, leadFromGraph(lead, await formName(formId || lead.form_id, token)));
    } catch (err) {
      console.error(`[leadforms:${cfg.id}] webhook falhou para o lead ${leadgenId}:`, (err as Error).message);
      await prisma.leadFormConfig.update({ where: { id: cfg.id }, data: { lastError: (err as Error).message.slice(0, 300) } }).catch(() => {});
    }
  }
}

/* ------------------------- Webhook: verificação ------------------------- */

/** Token de verificação do webhook (META_WEBHOOK_VERIFY_TOKEN ou derivado do segredo). */
export function webhookVerifyToken(): string {
  return (
    process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() ||
    'lawhub_' + createHmac('sha256', env.appSecret).update('leadgen-webhook').digest('hex').slice(0, 24)
  );
}

/** Confere o X-Hub-Signature-256 com o segredo do app do Meta. */
export function validSignature(raw: Buffer, header?: string): boolean {
  if (!env.fbAppSecret) return false;
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', env.fbAppSecret).update(raw).digest('hex');
  const got = header.slice(7);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/* ------------------------------ Configuração ----------------------------- */

export async function leadConfigOf(ws: string) {
  const cfg = await prisma.leadFormConfig.upsert({ where: { id: ws }, update: {}, create: { id: ws } });
  if (cfg.hookKey) return cfg;
  return prisma.leadFormConfig.update({ where: { id: ws }, data: { hookKey: randomBytes(18).toString('hex') } });
}

export const encPageToken = (t: string) => enc(t);

/* -------------------------- Busca periódica ----------------------------- */

let polling = false;
async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    const cfgs = await prisma.leadFormConfig.findMany({ where: { enabled: true, NOT: { pageToken: '' } } });
    for (const cfg of cfgs) {
      // Janela com folga de 1h (o dedupe evita repetir); no máximo 2 dias para trás.
      const base = cfg.lastPollAt ? cfg.lastPollAt.getTime() - 60 * 60_000 : Date.now() - 24 * 60 * 60_000;
      const since = new Date(Math.max(base, Date.now() - 2 * 24 * 60 * 60_000));
      await pullLeads(cfg.id, since).catch((e) => console.warn(`[leadforms:${cfg.id}] busca falhou:`, e.message));
    }
  } finally {
    polling = false;
  }
}

export function startLeadFormsLoop() {
  const t = setInterval(() => pollAll().catch(() => {}), 10 * 60_000);
  t.unref?.();
  const first = setTimeout(() => pollAll().catch(() => {}), 2 * 60_000);
  first.unref?.();
}
