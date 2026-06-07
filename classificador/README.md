# ABP Solar · Classificador Automático de Cards

Classifica automaticamente os campos de despesas no Pipefy usando Claude.

**Fluxo:**
1. Card entra na fase **Pagar** → Pipefy dispara webhook
2. Servidor recebe o webhook e busca os dados do card
3. Claude classifica todos os campos (categoria, tipo custo, centro, etc.)
4. Campos são atualizados automaticamente no card
5. Se Claude tiver dúvida → aplica etiqueta **Revisar**

---

## Deploy no Railway (5 minutos)

### 1. Crie o repositório no GitHub

```bash
# Na pasta do projeto:
git init
git add .
git commit -m "feat: classificador ABP Solar"
git branch -M main
git remote add origin https://github.com/abreu-rafa/abp-classificador.git
git push -u origin main
```

### 2. Deploy no Railway

1. Acesse [railway.app](https://railway.app) → **New Project**
2. Selecione **Deploy from GitHub repo**
3. Escolha o repositório `abp-classificador`
4. Railway detecta o Node.js automaticamente e faz o deploy

### 3. Configure as variáveis de ambiente no Railway

No painel do Railway → seu projeto → **Variables**:

| Variável | Valor |
|---|---|
| `PIPEFY_TOKEN` | Seu token do Pipefy |
| `ANTHROPIC_KEY` | Sua chave da API do Claude (console.anthropic.com) |
| `LABEL_REVISAR_ID` | ID da etiqueta "Revisar" no pipe (ver abaixo) |
| `WEBHOOK_SECRET` | Qualquer string aleatória (opcional) |

### 4. Pegue a URL do serviço

No Railway → seu projeto → **Settings** → copie a URL pública.  
Exemplo: `https://abp-classificador-production.up.railway.app`

### 5. Configure o Webhook no Pipefy

1. Acesse o pipe → **Configurações** → **Automações** → **Webhooks**
2. Clique em **Novo webhook**
3. **URL:** `https://SUA-URL.railway.app/webhook`
4. **Eventos:** marque `card.move`
5. **Filtro de fase:** selecione a fase **Pagar**
6. Salve

### 6. Crie a etiqueta "Revisar" no Pipefy

1. Configurações do pipe → **Etiquetas** → **Nova etiqueta**
2. Nome: `Revisar` | Cor: laranja
3. Copie o ID que aparece na URL ou via API
4. Cole em `LABEL_REVISAR_ID` nas variáveis do Railway

---

## Testando manualmente

Após o deploy, você pode testar um card específico:

```bash
curl -X POST https://SUA-URL.railway.app/classificar/ID_DO_CARD
```

Substitua `ID_DO_CARD` pelo ID real de um card do Pipefy.

---

## Como obter o LABEL_REVISAR_ID

```bash
curl -X POST https://api.pipefy.com/graphql \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ pipe(id: 1073359) { labels { id name } } }"}'
```

---

## Logs

No Railway → seu projeto → **Deployments** → clique no deploy ativo → **View Logs**

Você verá em tempo real:
```
── Webhook recebido ──
Evento: card.move
  Título: Pagamento fornecedor XYZ
  Fase: Pagar
  → Enviando para Claude...
  Resultado: { categoria_principal: "Implantação / Operação", ... }
  → 6 campos atualizados no Pipefy
  → Confiança alta: sem etiqueta
```
