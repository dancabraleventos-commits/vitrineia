const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ── Clientes das APIs ─────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── Enviar mensagem via Z-API ─────────────────────────
async function enviarWhatsApp(telefone, mensagem) {
  const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`;
  await axios.post(url, { phone: telefone, message: mensagem }, {
    headers: { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }
  });
}

// ── Chamar Claude API ─────────────────────────────────
async function chamarClaude(system, mensagem, maxTokens = 1000) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: mensagem }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });
  return res.data.content[0].text;
}

// ── Buscar ou criar estado da conversa ────────────────
async function getEstado(telefone, clienteId) {
  const { data } = await supabase
    .from('conversas_admin')
    .select('*')
    .eq('telefone', telefone)
    .single();

  if (data) return data;

  const { data: novo } = await supabase
    .from('conversas_admin')
    .insert({ telefone, cliente_id: clienteId, estado: 'aguardando_instrucao' })
    .select()
    .single();

  return novo;
}

async function setEstado(telefone, estado, acaoPendente = null) {
  await supabase
    .from('conversas_admin')
    .update({ estado, acao_pendente: acaoPendente, ultima_msg_em: new Date() })
    .eq('telefone', telefone);
}

// ── Buscar HTML atual da página do cliente ────────────
async function getHtmlAtual(clienteId) {
  const { data } = await supabase
    .from('paginas')
    .select('html_completo, slug, url_publica')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data;
}

// ── Publicar no Vercel ────────────────────────────────
async function publicarVercel(slug, htmlContent) {
  const res = await axios.post(
    'https://api.vercel.com/v13/deployments',
    {
      name: process.env.VERCEL_PROJECT_NAME || 'vitrineia',
      files: [{
        file: 'index.html',
        data: htmlContent
      }],
      projectSettings: { framework: null },
      target: 'production',
      aliases: [`${slug}.vitrineia.com.br`]
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return `https://${slug}.vitrineia.com.br`;
}

// ════════════════════════════════════════════════════════
// WEBHOOK PRINCIPAL
// ════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.status(200).send('ok'); // Responde Z-API imediatamente

  try {
    const body = req.body;
    const telefone = body.phone || body.from || '';
    const mensagem = body.text?.message || body.message || '';

    // Ignora mensagens próprias e status
    if (!mensagem || body.fromMe === true || body.isStatusReply === true) return;
    // Ignora grupos
    if (telefone.includes('@g.us') || telefone.includes('-')) return;

    console.log(`📩 Mensagem de ${telefone}: ${mensagem}`);

    // ── Busca cliente pelo telefone ───────────────────
    const telefoneLimpo = telefone.replace(/\D/g, '');
    const { data: clientes } = await supabase
      .from('clientes')
      .select('*')
      .or(`telefone.eq.${telefoneLimpo},telefone.eq.+${telefoneLimpo},telefone.eq.55${telefoneLimpo}`)
      .limit(1);

    const cliente = clientes?.[0];

    if (!cliente) {
      await enviarWhatsApp(telefone, 'Número não identificado como cliente ativo. Dúvidas? vitrineia.com.br 😊');
      return;
    }

    console.log(`✅ Cliente identificado: ${cliente.nome_negocio || cliente.nome}`);

    // ── Busca estado da conversa ──────────────────────
    const conversa = await getEstado(telefone, cliente.id);
    const estado = conversa?.estado || 'aguardando_instrucao';

    console.log(`📌 Estado atual: ${estado}`);

    // ════════════════════════════════════════════════
    // ESTADO: aguardando_aprovacao_pagina
    // ════════════════════════════════════════════════
    if (estado === 'aguardando_aprovacao_pagina') {
      const msg = mensagem.toLowerCase().trim();
      const acaoPendente = conversa.acao_pendente;

      // PUBLICAR
      if (msg.includes('publicar') || msg === 'ok' || msg === 'sim' || msg === '1') {
        await enviarWhatsApp(telefone, '⏳ Publicando sua página, aguarde alguns segundos...');

        try {
          const url = await publicarVercel(acaoPendente.slug, acaoPendente.html_novo);

          // Atualiza HTML no Supabase
          await supabase
            .from('paginas')
            .update({ html_completo: acaoPendente.html_novo, url_publica: url })
            .eq('cliente_id', cliente.id);

          await setEstado(telefone, 'aguardando_instrucao', null);

          await enviarWhatsApp(telefone,
            `✅ Página publicada com sucesso!\n\n👉 ${url}\n\nEm até 2 minutos já aparece atualizada 😊`
          );
        } catch (e) {
          console.error('Erro ao publicar:', e.message);
          await enviarWhatsApp(telefone, '❌ Erro ao publicar. Tente novamente ou entre em contato com o suporte.');
          await setEstado(telefone, 'aguardando_instrucao', null);
        }
        return;
      }

      // CANCELAR
      if (msg.includes('cancelar') || msg === 'não' || msg === 'nao' || msg === '3') {
        await setEstado(telefone, 'aguardando_instrucao', null);
        await enviarWhatsApp(telefone, 'Ok, descartei as alterações 👍\nSua página atual continua no ar.');
        return;
      }

      // AJUSTAR
      if (msg.includes('ajusta') || msg.includes('muda') || msg.includes('corrige') || msg === '2') {
        await enviarWhatsApp(telefone, '⏳ Aplicando o ajuste...');

        const instrucaoAjuste = mensagem.replace(/^(ajusta|muda|corrige)\s*/i, '').trim() || mensagem;

        const htmlAjustado = await chamarClaude(
          `Você é especialista em HTML para landing pages.
INSTRUÇÃO: "${instrucaoAjuste}"
HTML ATUAL:
${acaoPendente.html_novo}
Aplique SOMENTE a alteração pedida. Mantenha todo estilo e estrutura.
Retorne APENAS o HTML completo modificado. Zero explicações.`,
          instrucaoAjuste,
          4000
        );

        await setEstado(telefone, 'aguardando_aprovacao_pagina', {
          ...acaoPendente,
          html_novo: htmlAjustado
        });

        await enviarWhatsApp(telefone,
          `✏️ Ajuste aplicado!\n\nPrevisualize: ${acaoPendente.url_atual}\n\nResponda:\n✅ *publicar* — colocar no ar\n✏️ *ajusta [mais alguma coisa]* — novo ajuste\n❌ *cancelar* — descartar`
        );
        return;
      }

      // Resposta não reconhecida
      await enviarWhatsApp(telefone,
        `Não entendi 😊 Responda:\n\n✅ *publicar* — colocar no ar\n✏️ *ajusta [o que mudar]* — novo ajuste\n❌ *cancelar* — descartar`
      );
      return;
    }

    // ════════════════════════════════════════════════
    // ESTADO: aguardando_instrucao
    // ════════════════════════════════════════════════
    const nomeNegocio = cliente.nome_negocio || cliente.nome || 'seu negócio';
    const categoria = cliente.categoria || '';
    const cidade = cliente.cidade || '';

    const intencaoRaw = await chamarClaude(
      `Você é o assistente técnico da VitrineIA.
Um cliente ativo mandou uma mensagem no suporte.

DADOS DO CLIENTE:
Nome do negócio: ${nomeNegocio}
Categoria: ${categoria}
Cidade: ${cidade}

Identifique a intenção e retorne SOMENTE JSON válido sem markdown:
{
  "intencao": "editar_pagina" | "regerar_pagina" | "duvida" | "outro",
  "instrucao_clara": "o que exatamente precisa ser feito",
  "resposta_direta": "resposta se for duvida ou outro"
}

Exemplos:
"muda meu horário para 9h às 19h" → editar_pagina
"adiciona o serviço delivery" → editar_pagina
"refaz minha página" → regerar_pagina
"como cancelo?" → duvida`,
      mensagem,
      500
    );

    let intencao = 'duvida';
    let instrucao = '';
    let respostaDireta = 'Pode me dizer o que você precisa? 😊';

    try {
      const parsed = JSON.parse(intencaoRaw.replace(/```json|```/g, '').trim());
      intencao = parsed.intencao || 'duvida';
      instrucao = parsed.instrucao_clara || '';
      respostaDireta = parsed.resposta_direta || respostaDireta;
    } catch (e) {
      respostaDireta = intencaoRaw;
    }

    console.log(`🎯 Intenção detectada: ${intencao} — ${instrucao}`);

    // ── Dúvida ou outro ───────────────────────────────
    if (intencao === 'duvida' || intencao === 'outro') {
      await enviarWhatsApp(telefone, respostaDireta);
      return;
    }

    // ── Editar ou regerar página ──────────────────────
    if (intencao === 'editar_pagina' || intencao === 'regerar_pagina') {
      await enviarWhatsApp(telefone, `⚙️ Entendido! Estou gerando a nova versão da sua página...\n\nIsso leva cerca de 30 segundos 😊`);

      const paginaAtual = await getHtmlAtual(cliente.id);

      if (!paginaAtual?.html_completo) {
        await enviarWhatsApp(telefone, '❌ Não encontrei a página cadastrada. Entre em contato com o suporte.');
        return;
      }

      let htmlNovo;

      if (intencao === 'regerar_pagina') {
        htmlNovo = await chamarClaude(
          `Você é especialista em landing pages para comércios locais brasileiros.
Crie uma landing page profissional completa em HTML para:
Nome: ${nomeNegocio}
Categoria: ${categoria}
Cidade: ${cidade}
Use como referência o estilo e informações da página atual abaixo.
Retorne APENAS o HTML completo. Zero explicações.

PÁGINA ATUAL PARA REFERÊNCIA:
${paginaAtual.html_completo.substring(0, 3000)}`,
          instrucao,
          8000
        );
      } else {
        htmlNovo = await chamarClaude(
          `Você é especialista em HTML para landing pages.
NEGÓCIO: ${nomeNegocio} — ${categoria} — ${cidade}
INSTRUÇÃO: "${instrucao}"

HTML ATUAL:
${paginaAtual.html_completo}

Aplique SOMENTE a alteração pedida. Não mude nada além do que foi solicitado.
Mantenha todo estilo, cores e estrutura.
Retorne APENAS o HTML completo modificado. Zero explicações.`,
          instrucao,
          8000
        );
      }

      // Salva em acao_pendente
      await setEstado(telefone, 'aguardando_aprovacao_pagina', {
        html_novo: htmlNovo,
        html_original: paginaAtual.html_completo,
        slug: paginaAtual.slug,
        url_atual: paginaAtual.url_publica
      });

      await enviarWhatsApp(telefone,
        `✅ Pronto! Gerei a nova versão da sua página.\n\n📄 Prévia da página atual: ${paginaAtual.url_publica}\n_(a nova versão só vai no ar quando você aprovar)_\n\nResponda:\n✅ *publicar* — colocar no ar agora\n✏️ *ajusta [o que mudar]* — fazer mais algum ajuste\n❌ *cancelar* — descartar`
      );
    }

  } catch (err) {
    console.error('❌ Erro no webhook:', err.message);
  }
});

// Health check
app.get('/', (req, res) => res.send('VitrineIA Admin ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Admin rodando na porta ${PORT}`));
