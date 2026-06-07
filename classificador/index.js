/**
 * ABP Solar — Classificador Automático de Cards
 * 
 * Fluxo:
 * 1. Card entra na fase "Pagar" no Pipefy
 * 2. Webhook chama este servidor
 * 3. Servidor busca os dados do card via GraphQL
 * 4. Manda para o Claude classificar conforme modelo ABP
 * 5. Claude retorna JSON com os campos preenchidos
 * 6. Servidor atualiza os campos no Pipefy via mutation
 * 7. Se Claude teve dúvida → aplica etiqueta "Revisar"
 */

import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// ── Variáveis de ambiente (configuradas no Railway) ──────────
const PIPEFY_TOKEN   = process.env.PIPEFY_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';   // opcional
const PORT           = process.env.PORT || 3000;
const PIPE_ID        = '1073359';

// ID da fase "Pagar" — dispara o classificador
const FASE_PAGAR_ID  = '7243035';

// ID da etiqueta "Revisar" no Pipefy
// Preencher após criar a etiqueta: Settings do pipe → Labels
const LABEL_REVISAR_ID = process.env.LABEL_REVISAR_ID || '';

// ── IDs dos campos do pipe (mapeados da aba CONFIG) ──────────
const FIELDS = {
  valor:           'valor',
  tipo_lanc:       'tipo_de_lan_amento',
  cat_principal:   'categoria_principal',
  sub_implantacao: 'categoria_opera_o',
  sub_aquisicao:   'categorias_comercial',
  sub_engenharia:  'categorias_engenharia',
  sub_posv:        'categorias_suporte_ao_cliente',
  sub_pessoas:     'categoria_pessoas',
  sub_estrutura:   'sele_o_de_nica_op_o_vertical',
  sub_tecnologia:  'tecnologia',
  sub_financeiro:  'financeiro_jur_dico_e_cont_bil',
  tipo_custo:      'tipo_de_despesa',
  centro_custo:    'centro_de_custo_1',
  tipo_aprop:      'tipo_de_apropria_o',
  contrato:        'contrato_destino',
  natureza:        'natureza_do_pagamento',
  descricao:       'descri_o',
};

// Mapa: categoria → field_id da subcategoria
const SUBCAT_FIELD = {
  'Implantação / Operação':        FIELDS.sub_implantacao,
  'Aquisição de Clientes':         FIELDS.sub_aquisicao,
  'Projeto e Engenharia':          FIELDS.sub_engenharia,
  'Pós-venda e Suporte':           FIELDS.sub_posv,
  'Pessoas':                       FIELDS.sub_pessoas,
  'Estrutura e Administração':     FIELDS.sub_estrutura,
  'Tecnologia':                    FIELDS.sub_tecnologia,
  'Financeiro, Jurídico e Contábil': FIELDS.sub_financeiro,
};

// ── Pipefy GraphQL ───────────────────────────────────────────
async function pipefy(query, variables = {}) {
  const r = await fetch('https://api.pipefy.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${PIPEFY_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json();
  if (d.errors) throw new Error(d.errors.map(e => e.message).join('; '));
  return d.data;
}

// Busca dados completos de um card
async function getCard(cardId) {
  const q = `
    query($id: ID!) {
      card(id: $id) {
        id title
        current_phase { id name }
        fields { field { id label } value array_value }
      }
    }
  `;
  const d = await pipefy(q, { id: cardId });
  return d.card;
}

// Extrai valor de um campo
function fv(card, fieldId) {
  const f = (card.fields || []).find(f => f.field.id === fieldId);
  if (!f) return null;
  return f.value || (f.array_value && f.array_value[0]) || null;
}

// Atualiza um campo do card
async function updateField(cardId, fieldId, value) {
  if (!value || value === 'null' || value === '') return;
  const q = `
    mutation($input: UpdateCardFieldInput!) {
      updateCardField(input: $input) { success }
    }
  `;
  await pipefy(q, { input: { card_id: cardId, field_id: fieldId, new_value: value } });
}

// Aplica etiqueta no card
async function applyLabel(cardId, labelId) {
  if (!labelId) {
    console.warn('LABEL_REVISAR_ID não configurado — pulando etiqueta');
    return;
  }
  const q = `
    mutation($cardId: ID!, $labelId: ID!) {
      updateCard(input: { id: $cardId, label_ids: [$labelId] }) {
        card { id }
      }
    }
  `;
  await pipefy(q, { cardId, labelId });
}

// ── Claude API ───────────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o classificador financeiro oficial da ABP Solar.
Sua missão é analisar os dados de um lançamento financeiro e preencher TODOS os campos de classificação.

## Campos que você deve retornar (sempre em JSON):
{
  "natureza_pagamento": "",     // Salário / Folha | Encargos / Benefícios | Nota de Serviço | Compra de Produto | Imposto / Taxa
  "categoria_principal": "",    // ver lista abaixo
  "subcategoria": "",           // ver lista por categoria
  "tipo_apropriacao": "",       // Despesa do Mês | Estoque | Despesa Antecipada / Crédito | Ativo / Investimento
  "tipo_custo": "",             // Direto | Indireto Compartilhado | Estrutural
  "centro_custo": "",           // Administrativo | Comercial | Engenharia | Operação | Frota
  "contrato_destino": "",       // Contrato | Estoque | "" (vazio se não for Implantação/Operação)
  "confianca": "alta",          // alta | media | baixa
  "motivo_duvida": ""           // preenchido só quando confianca != alta
}

## Categorias e subcategorias válidas:
- Aquisição de Clientes: Brindes e Ações Promocionais, Comissões de Venda, Eventos e Feiras, Marketing de Conteúdo, Parcerias Comerciais, Plataformas Comerciais / CRM, Produção de Material Comercial, Programa de Indicação (ABPontos), Tráfego Pago
- Estrutura e Administração: ATIVO – Móveis e Utensílios, ATIVO – Veículos, Aluguel e Condomínio, Benfeitorias / Reformas (Ativo), Custos de Utilidades (Água, Energia, Internet e Telefonia), Frota / Combustível, Insumos Administrativos, Limpeza e Conservação, Manutenção Predial, Material de Escritório, Seguros e Segurança Patrimonial
- Financeiro, Jurídico e Contábil: Contabilidade, Consultorias Especializadas, Honorários Jurídicos, Juros e Encargos Financeiros, Multas e Penalidades, Taxas Bancárias
- Implantação / Operação: ATIVOS – Ferramentas e Equipamentos Operacionais, Equipamentos, Equipamentos de Segurança (EPIs), Estruturas e Fixações, Hospedagem e Alimentação de Equipe, Locação de Equipamentos de Obra, Logística e Frete, Materiais Elétricos, Mão de Obra de Instalação (Terceirizada), Operação de Eletropostos
- Pessoas: Bônus e Premiações, Encargos Trabalhistas, Outros Benefícios, Plano de Saúde / Odontológico, Pró-labore, Recrutamento e Seleção, Salários, Treinamentos e Capacitações, Uniformes, Vale Refeição / Alimentação, Vale Transporte
- Pós-venda e Suporte: Garantias e Assistência Técnica, Plataformas e Softwares
- Projeto e Engenharia: ART / CREA, Mão de Obra de Engenharia (Terceirizada / PJ), Softwares de Projeto
- Tecnologia: ATIVO – Equipamentos de TI, Plataformas e Softwares, Serviços de TI (Terceirizados)
- Reserva: (sem subcategoria — não preencher tipo_custo, centro_custo, tipo_apropriacao, contrato_destino)

## Regras críticas:
1. Categorias SEMPRE Estrutural: Aquisição de Clientes, Estrutura e Administração, Financeiro/Jurídico/Contábil, Pessoas, Pós-venda, Projeto e Engenharia, Tecnologia
2. Implantação/Operação: Direto (rastreável a contrato específico), Indireto Compartilhado (várias obras), Estrutural (custo da empresa)
3. Compra de material → Estoque (não Despesa do Mês)
4. Ferramentas, veículos, equipamentos de TI → Ativo / Investimento
5. Juros NUNCA junto ao principal — categoria: Financeiro → Juros e Encargos Financeiros
6. Implantação/Operação é o ÚNICO grupo que usa contrato_destino
7. Centro de custo: Comercial=Aquisição, Administrativo=Estrutura/Financeiro/Pessoas/Tecnologia, Engenharia=Projeto, Operação=Implantação/Pós-venda, Frota=veículos

## Quando colocar confianca = "baixa":
- Descrição ambígua que serve para mais de uma categoria
- Não sabe se é Direto ou Indireto (sem info de contrato)
- Não sabe se é compra de produto ou serviço
- Valor muito alto sem contexto suficiente

Responda APENAS com o JSON. Sem texto adicional, sem markdown, sem explicação.`;

async function classificar(titulo, descricao, valor, camposJaPreenchidos) {
  const userMsg = `
Classifique este lançamento financeiro:

Título: ${titulo}
Descrição: ${descricao || '(não preenchida)'}
Valor: R$ ${valor || '?'}

Campos já preenchidos pelo usuário (respeitar se corretos, corrigir se errados):
${JSON.stringify(camposJaPreenchidos, null, 2)}

Retorne o JSON completo com todos os campos classificados.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  const d = await r.json();
  const raw = d.content[0].text.trim();

  // Parse seguro do JSON
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Lógica principal ─────────────────────────────────────────
async function processarCard(cardId) {
  console.log(`\n[${new Date().toISOString()}] Processando card ${cardId}`);

  // 1. Busca dados do card
  const card = await getCard(cardId);
  console.log(`  Título: ${card.title}`);
  console.log(`  Fase: ${card.current_phase?.name}`);

  // Só processa se estiver na fase Pagar
  if (card.current_phase?.id !== FASE_PAGAR_ID) {
    console.log(`  → Fase ignorada (${card.current_phase?.name}), pulando.`);
    return { status: 'ignored', reason: 'fase_incorreta' };
  }

  // 2. Monta contexto dos campos já preenchidos
  const camposJaPreenchidos = {
    categoria_principal:    fv(card, FIELDS.cat_principal)  || null,
    tipo_custo:             fv(card, FIELDS.tipo_custo)     || null,
    centro_custo:           fv(card, FIELDS.centro_custo)   || null,
    tipo_apropriacao:       fv(card, FIELDS.tipo_aprop)     || null,
    contrato_destino:       fv(card, FIELDS.contrato)       || null,
    natureza_pagamento:     fv(card, FIELDS.natureza)       || null,
  };

  const titulo    = card.title || '';
  const descricao = fv(card, FIELDS.descricao) || '';
  const valor     = fv(card, FIELDS.valor) || '';

  // 3. Manda para o Claude classificar
  console.log(`  → Enviando para Claude...`);
  const resultado = await classificar(titulo, descricao, valor, camposJaPreenchidos);
  console.log(`  Resultado:`, JSON.stringify(resultado, null, 2));

  // 4. Atualiza os campos no Pipefy
  const updates = [];

  if (resultado.natureza_pagamento)
    updates.push(updateField(cardId, FIELDS.natureza,      resultado.natureza_pagamento));

  if (resultado.categoria_principal)
    updates.push(updateField(cardId, FIELDS.cat_principal, resultado.categoria_principal));

  // Subcategoria — usa o field correto para a categoria
  if (resultado.subcategoria && resultado.categoria_principal) {
    const subcatField = SUBCAT_FIELD[resultado.categoria_principal];
    if (subcatField)
      updates.push(updateField(cardId, subcatField, resultado.subcategoria));
  }

  if (resultado.tipo_apropriacao)
    updates.push(updateField(cardId, FIELDS.tipo_aprop,    resultado.tipo_apropriacao));

  if (resultado.tipo_custo)
    updates.push(updateField(cardId, FIELDS.tipo_custo,    resultado.tipo_custo));

  if (resultado.centro_custo)
    updates.push(updateField(cardId, FIELDS.centro_custo,  resultado.centro_custo));

  if (resultado.contrato_destino)
    updates.push(updateField(cardId, FIELDS.contrato,      resultado.contrato_destino));

  await Promise.all(updates);
  console.log(`  → ${updates.length} campos atualizados no Pipefy`);

  // 5. Aplica etiqueta "Revisar" se confiança baixa ou média
  if (['baixa', 'media'].includes(resultado.confianca)) {
    console.log(`  → Confiança ${resultado.confianca}: aplicando etiqueta Revisar`);
    console.log(`  → Motivo: ${resultado.motivo_duvida}`);
    await applyLabel(cardId, LABEL_REVISAR_ID);
  } else {
    console.log(`  → Confiança alta: sem etiqueta`);
  }

  return {
    status: 'ok',
    cardId,
    confianca: resultado.confianca,
    motivo_duvida: resultado.motivo_duvida || null,
    campos_atualizados: updates.length,
  };
}

// ── Rotas Express ────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'ABP Solar · Classificador de Cards',
    status: 'online',
    timestamp: new Date().toISOString(),
  });
});

// Webhook do Pipefy
app.post('/webhook', async (req, res) => {
  try {
    // Validação opcional do secret
    if (WEBHOOK_SECRET) {
      const secret = req.headers['x-pipefy-webhook-secret'];
      if (secret !== WEBHOOK_SECRET) {
        console.warn('Webhook com secret inválido rejeitado');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const payload = req.body;
    console.log('\n── Webhook recebido ──');
    console.log('Evento:', payload?.data?.action);

    // Pipefy envia diferentes formatos dependendo do evento
    // Evento: card.move → quando card muda de fase
    const cardId = payload?.data?.card?.id
                || payload?.data?.id
                || payload?.card_id;

    if (!cardId) {
      console.warn('Card ID não encontrado no payload:', JSON.stringify(payload));
      return res.status(200).json({ status: 'ignored', reason: 'no_card_id' });
    }

    // Responde imediatamente ao Pipefy (evita timeout do webhook)
    res.status(200).json({ status: 'processing', cardId });

    // Processa em background
    processarCard(String(cardId))
      .then(r => console.log(`  Resultado final:`, r))
      .catch(e => console.error(`  Erro ao processar ${cardId}:`, e.message));

  } catch (e) {
    console.error('Erro no webhook:', e);
    res.status(500).json({ error: e.message });
  }
});

// Endpoint manual — útil para testar um card específico
app.post('/classificar/:cardId', async (req, res) => {
  try {
    const resultado = await processarCard(req.params.cardId);
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`\n🌞 ABP Solar Classificador rodando na porta ${PORT}`);
  console.log(`   PIPEFY_TOKEN:    ${PIPEFY_TOKEN ? '✓ configurado' : '✗ FALTANDO'}`);
  console.log(`   ANTHROPIC_KEY:   ${ANTHROPIC_KEY ? '✓ configurado' : '✗ FALTANDO'}`);
  console.log(`   LABEL_REVISAR_ID:${LABEL_REVISAR_ID ? ' ✓ ' + LABEL_REVISAR_ID : ' ⚠ não configurado'}`);
  console.log(`   Pipe ID:         ${PIPE_ID}`);
  console.log(`   Fase Pagar ID:   ${FASE_PAGAR_ID}\n`);
});
