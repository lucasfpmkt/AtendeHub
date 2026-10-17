# AtendeHub

Hub de atendimento **próprio** com **IA + CRM + WhatsApp (QR code)**.
Produto construído do zero — não é cópia de nenhum serviço existente.

- **Atendimentos**: inbox em tempo real, envio/recebimento pelo WhatsApp.
- **IA**: rascunho de resposta sob demanda e auto-resposta por conversa.
- **CRM**: contatos criados automaticamente, tags, anotações.
- **Funil**: kanban de oportunidades com arrastar-e-soltar.

## Vários clientes (multi-workspace)

- Cada escritório é um **cliente** com login próprio (e-mail e senha), o
  próprio **WhatsApp**, agentes, CRM, tarefas e agenda. Um cliente nunca vê os
  dados de outro.
- **Administrador**: vê todos os clientes, troca entre eles ("Selecionar
  workspace"), cria logins, define plano/vencimento, desativa acesso e
  redefine senhas (menu **Clientes**).
- **Usuário**: vê só o escritório dele. Pode **criar conta** na tela de login
  (começa com 7 dias de teste) e trocar a própria senha em Configurações.
- Conta desativada ou com plano vencido não consegue entrar.

## Agentes IA — como o fluxo funciona

- **Porta de entrada:** a triagem só assume conversas novas cuja mensagem contém
  um gatilho dela ou de um agente de tema. Triagem **sem** gatilhos atende todas
  as conversas novas.
- **Delay:** o agente espera o lead parar de digitar antes de responder.
- **Ações no roteiro** (formato Guimoo), executadas pelo servidor:
  - `⚡ Ação: Transferir para agente: Nome` → a conversa passa para esse agente,
    que responde em seguida.
  - `⚡ Ação: Desativar: agente` → a IA para e a conversa fica com a equipe.
  - Triagem sem essas ações continua usando o roteamento automático
    (gatilhos dos agentes de tema → IA pela descrição do tema).
- **Equipe assumiu:** quando alguém responde manualmente, a IA pausa naquela
  conversa ("Devolver para IA" reativa).
- **Erros da IA** aparecem como nota na conversa, para a equipe ver.
- **Editor:** Roteiro, Regras, FAQ, gatilhos, delay, assinatura, Histórico,
  **Testar** (simula com transferências, sem usar o WhatsApp) e **Copiloto**.
- Gatilhos são separados por vírgula: evite vírgulas dentro de um gatilho.

Outras telas: Início, Dashboard, Conversas (abas, não lidas, `/atalhos`),
Tarefas, Agenda e Automações (mensagens rápidas e respostas por palavra-chave).

---

## ⚠️ Aviso importante sobre o WhatsApp via QR

A conexão por QR code usa a biblioteca **Baileys**, que fala o protocolo do
**WhatsApp Web**. Isso **não é oficial** e **contraria os Termos de Serviço do
WhatsApp**. Riscos reais: **bloqueio/banimento do número**, sem aviso.

Use um número de testes, nunca o principal. Para produção séria, migre para a
**WhatsApp Business Cloud API** (oficial). O código já isola o WhatsApp num
único módulo (`server/src/whatsapp/session.ts`) justamente para facilitar essa
troca — veja "Migrar para a API oficial" no fim.

---

## Stack

| Camada    | Tecnologia                                   |
| --------- | -------------------------------------------- |
| Backend   | Node.js + TypeScript (Express, tsx)          |
| Tempo real| socket.io                                    |
| Banco     | Prisma + SQLite (troca p/ Postgres 1 linha)  |
| WhatsApp  | @whiskeysockets/baileys (QR / WhatsApp Web)  |
| IA        | @anthropic-ai/sdk (plugável)                 |
| Frontend  | React + Vite + TypeScript                    |

---

## Pré-requisitos

- **Node.js 20+** e npm
- (Opcional) uma **ANTHROPIC_API_KEY** para IA real

## Como rodar

```bash
# 1. instalar dependências (raiz + server + client via workspaces)
npm install

# 2. configurar variáveis de ambiente do servidor
cp .env.example server/.env
#   edite server/.env se quiser (chave de IA, porta, etc.)

# 3. criar o banco (gera client Prisma + migração inicial)
npm run --workspace server db:setup

# 4. subir backend + frontend juntos
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001

Depois, na aba **Conexão**, clique em *Gerar QR code* e escaneie com o
WhatsApp do celular (Aparelhos conectados → Conectar um aparelho).

> A sessão fica salva em `server/auth_info/`. Para desvincular e gerar novo QR,
> use *Desconectar número* na UI (apaga essa pasta).

---

## Estrutura

```
atendehub/
├─ server/                 # API + WhatsApp + IA
│  ├─ prisma/schema.prisma  # modelo de dados
│  └─ src/
│     ├─ index.ts           # Express + socket.io
│     ├─ whatsapp/session.ts# conexão Baileys (QR, enviar/receber)
│     ├─ services/
│     │  ├─ ai.ts           # geração de resposta (Anthropic)
│     │  └─ inbound.ts      # mensagem recebida → contato/conversa/IA
│     └─ routes/            # whatsapp, crm, ai
└─ client/                 # React (Vite)
   └─ src/pages/            # Connect, Inbox, Contacts, Pipeline, Settings
```

## Como funciona (fluxo)

1. Mensagem chega no WhatsApp → `session.ts` captura em `messages.upsert`.
2. `inbound.ts` cria/acha o **contato** e a **conversa**, grava a mensagem e
   emite via socket.io para o frontend atualizar na hora.
3. Se a conversa estiver com **auto-resposta IA** ligada, `ai.ts` gera a
   resposta e `session.ts` envia de volta pelo WhatsApp.
4. O agente também pode pedir um **rascunho** (botão 🤖) e editar antes de
   enviar.

---

## Migrar para a WhatsApp Business Cloud API (oficial)

Toda a dependência do WhatsApp está em `server/src/whatsapp/session.ts`, que
expõe `startWhatsApp`, `sendText`, `sendFromConversation`, `getStatus`,
`logoutWhatsApp`. Para migrar:

1. Crie um app na Meta e um número na Cloud API; configure um **webhook**.
2. Substitua a implementação de `session.ts` por chamadas à Cloud API
   (`POST /{phone-id}/messages`) e trate o webhook de entrada chamando o mesmo
   `handleInboundMessage` que já existe.
3. Remova o QR da aba Conexão (passa a ser configuração de token/numero).

O resto do sistema (CRM, IA, inbox, funil) não muda.

---

## Próximos passos sugeridos

- Autenticação de usuários/equipe (hoje é single-tenant local).
- Múltiplos números/canais.
- Envio de mídia (imagens, áudio) — Baileys já suporta.
- Métricas e relatórios no funil.
- Fila/atribuição de atendimentos entre agentes.

## Licença

Código seu, para o seu produto. Dependências de terceiros mantêm suas próprias
licenças.
