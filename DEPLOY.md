# Deploy do AtendeHub na sua VPS

## Atualizando para a versão multi-cliente (leia antes)

1. **Faça backup do banco** antes do deploy. O arquivo fica no volume `/data`
   (`/data/atendehub.db`). Ex.: `cp /data/atendehub.db /data/atendehub-backup.db`.
2. Confira que o painel (Easypanel/Coolify) faz o build da branch **main** e
   **reconstrói a imagem** (Rebuild/Redeploy). Se a tela continuar igual à
   antiga, o deploy não pegou o último commit.
3. Na primeira subida, o servidor:
   - cria o cliente **Law Mídias** (#1001) e move para ele todos os dados que já
     existem (contatos, conversas, agentes, funis…);
   - mantém a sessão do WhatsApp atual (não precisa ler QR de novo);
   - cria o **administrador**: login `admin` e a senha de `ADMIN_PASSWORD`
     (ou, se vazia, a mesma `APP_PASSWORD` de antes).
4. Entre como admin → escolha o cliente → em **Clientes** crie os logins dos
   outros escritórios. Cada um conecta o próprio WhatsApp em **Conexão**.

Variáveis novas (opcionais): `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`DEFAULT_WORKSPACE_NAME`, `ALLOW_SIGNUP` (`0` esconde o "Criar conta").

Dois caminhos. Como sua VPS já roda **Coolify**, use o **Caminho A**.

Antes de tudo, gere os segredos (rode no seu PC ou na VPS):

```bash
openssl rand -hex 32   # use o resultado em APP_SECRET
```

---

## Caminho A — Coolify (recomendado para você)

O Coolify já cuida de proxy reverso, HTTPS e domínio, então aqui **não** se usa
o Caddy nem o docker-compose deste projeto — só o `Dockerfile`.

### 1. Suba o código para um repositório Git
Crie um repositório (GitHub/GitLab) e envie a pasta `atendehub`:

```bash
cd atendehub
git init && git add . && git commit -m "AtendeHub"
git remote add origin <url-do-seu-repo>
git push -u origin main
```

### 2. Crie a aplicação no Coolify
- **+ New Resource → Application → Public/Private Repository**.
- Selecione o repositório.
- **Build Pack: Dockerfile** (o Coolify detecta o `Dockerfile` da raiz).
- **Port / Ports Exposes: `3001`**.

### 3. Variáveis de ambiente (aba *Environment*)
```
SERVE_CLIENT=1
APP_PASSWORD=<sua-senha-forte>
ADMIN_EMAIL=admin
ADMIN_PASSWORD=<senha-do-admin>
ALLOW_SIGNUP=1
APP_SECRET=<hex-gerado-com-openssl>
DATABASE_URL=file:/data/atendehub.db
WA_AUTH_DIR=/data/auth_info
ANTHROPIC_API_KEY=<opcional>
AI_MODEL=claude-sonnet-4-5
```

### 4. Armazenamento persistente (CRÍTICO)
Na aba **Storages**, adicione um volume:
- **Mount Path: `/data`**

Sem isso, a sessão do WhatsApp e o banco se perdem a cada deploy (você teria
que reescanear o QR toda hora).

### 5. Domínio e deploy
- Em **Domains**, aponte um subdomínio (ex.: `atende.seudominio.com.br`). O
  Coolify emite o HTTPS sozinho.
- Clique em **Deploy**.

Pronto: acesse o domínio, faça login com `APP_PASSWORD`, vá em **Conexão** e
escaneie o QR.

> Dica: o WebSocket (tempo real) já funciona através do proxy do Coolify, sem
> configuração extra.

---

## Caminho B — VPS sem Coolify (Docker + Caddy)

Use o `docker-compose.yml` que acompanha o projeto.

```bash
# na VPS, dentro da pasta do projeto
cp .env.production.example .env
nano .env            # defina APP_PASSWORD, APP_SECRET, DOMAIN, etc.

docker compose up -d --build
docker compose logs -f app
```

- Com **DOMAIN=um-dominio-real** (DNS apontando para o IP), o Caddy emite HTTPS
  automático nas portas 80/443.
- Sem domínio, deixe `DOMAIN=:80` e acesse por `http://SEU_IP`.

Os dados persistem no volume `atendehub-data`. Para atualizar:

```bash
git pull
docker compose up -d --build
```

Para desconectar o número e zerar a sessão: use **Desconectar** na UI, ou
remova a pasta de auth dentro do volume.

---

## Observações de produção

- **Troque `APP_PASSWORD` e `APP_SECRET`.** O login é de operador único.
- O banco padrão é SQLite em arquivo (no volume). Para múltiplos usuários/alto
  volume, migre para Postgres (mude `provider` no `schema.prisma` e a
  `DATABASE_URL`).
- Lembrete: conexão WhatsApp por QR (Baileys) contraria os termos do WhatsApp;
  risco de banir o número. Veja o README para migrar à API oficial.
