const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function enviarWhatsApp(telefone, mensagem) {
  const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`;
  await axios.post(url, { phone: telefone, message: mensagem }, {
    headers: { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }
  });
}

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

async function getEstado(telefone, clienteId) {
  const { data } = await supabase
    .from('conversas_admin')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();

  if (data) return data;

  const { data: novo } = await supabase
    .from('conversas_admin')
    .insert({ telefone, cliente_id: clienteId, estado: 'aguardando_instrucao' })
    .select()
    .maybeSingle();

  return novo;
}

async function setEstado(telefone, estado, acaoPendente = null) {
  await supabase
    .from('conversas_admin')
    .update({ estado, acao_pendente: acaoPendente, ultima_msg_em: new Date() })
    .eq('telefone', telefone);
}

async function getHtmlAtual(clienteId) {
  const { data } = await supabase
    .from('paginas')
    .select('html_completo, slug, url_publica')
    .eq('cliente_id', clienteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

async function publicarVercel(slug, htmlContent) {
  const res = await axios.post(
    'https://api.vercel.com/v13/deployments',
    {
      name: process.env.VERCEL_PROJECT_NAME || 'vitrineia',
      files: [{ file: 'index.html', data: htmlContent }],
      projectSettings: { framework: null },
      target: 'production'
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data.url ? `https://${res.data.url}` : `https://${slug}.vitrineia.com.br`;
}

app.post('/webhook', async (req, res) => {
  res.status(200).send('ok');

  try {
    const body = req.body;
    const telefone = body.phone || body.from || '';
    const mensagem = body.text?.message || body.message || '';

    if (!mensagem || body.fromMe === true || body.isStatusReply === true) return;
    if (telefone.includes('@g.us') || telefone.includes('-')) return;

    console.log(`📩 Mensagem de ${telefone}: ${mensagem}`);

    const telefoneLimpo = telefone.replace(/\D/g, '');
    console.log(`🔍 Buscando cliente pelo telefone: ${telefoneLimpo}`);

    const { data: clientes, error: erroCliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefone', telefoneLimpo)
      .limit(1);

    console.log(`📋 Clientes: ${JSON.stringify(clientes)} | Erro: ${erroCliente?.message}`);

    const cliente = clientes?.[0];

    if (!cliente) {
      await enviarWhatsApp(telefone, 'Número não identificado como cliente ativo. Dúvidas? vitrineia.com.br 😊');
      return;
    }

    console.log(`✅ Cliente: ${cliente.nome}`);

    const conversa = await getEstado(telefone, cliente.id);
    const estado = conversa?.estado || 'aguardando_instrucao';
    console.log(`📌 Estado: ${estado}`);

    if (estado === 'aguardando_aprovacao_pagina') {
      const msg = mensagem.toLowerCase().trim();
      const acaoPendente = conversa.acao_pendente;

      if (msg.includes('publicar') || msg === 'ok' || msg === 'sim' || msg === '1') {
        await enviarWhatsApp(telefone, '⏳ Publicando sua página, aguarde alguns segundos...');
        try {
          const url = await publicarVercel(acaoPendente.slug, acaoPendente.html_novo);
          await supabase.from('paginas')
            .update({ html_completo: acaoPendente.html_novo, url_publica: url })
            .eq('cliente_id', cliente.id);
          await setEstado(telefone, 'aguardando_instrucao', null);
          await enviarWhatsApp(telefone, `✅ Página publicada!\n\n👉 ${url}\n\nEm até 2 minutos já aparece atualizada 😊`);
        } catch (e) {
          console.error('Erro ao publicar:', e.message, JSON.stringify(e.response?.data));
          await enviarWhatsApp(telefone, '❌ Erro ao publicar. Tente novamente ou entre em contato com o suporte.');
          await setEstado(telefone, 'aguardando_instrucao', null);
        }
        return;
      }

      if (msg.includes('cancelar') || msg === 'não' || msg === 'nao' || msg === '3') {
        await setEstado(telefone, 'aguardando_instrucao', null);
        await enviarWhatsApp(telefone, 'Ok, descartei as alterações 👍\nSua página atual continua no ar.');
        return;
      }

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
          instrucaoAjuste, 4000
        );
        await setEstado(telefone, 'aguardando_aprovacao_pagina', { ...acaoPendente, html_novo: htmlAjustado });
        await enviarWhatsApp(telefone,
          `✏️ Ajuste aplicado!\n\nResponda:\n✅ *publicar* — colocar no ar\n✏️ *ajusta [mais alguma coisa]* — novo ajuste\n❌ *cancelar* — descartar`
        );
        return;
      }

      await enviarWhatsApp(telefone,
        `Não entendi 😊 Responda:\n\n✅ *publicar* — colocar no ar\n✏️ *ajusta [o que mudar]* — novo ajuste\n❌ *cancelar* — descartar`
      );
      return;
    }

    const nomeNegocio = cliente.nome || 'seu negócio';
    const categoria = cliente.segmento || '';
    const cidade = cliente.cidade || '';

    const intencaoRaw = await chamarClaude(
      `Você é o assistente técnico da VitrineIA.
DADOS DO CLIENTE: Nome: ${nomeNegocio}, Categoria: ${categoria}, Cidade: ${cidade}
Identifique a intenção e retorne SOMENTE JSON válido sem markdown:
{"intencao":"editar_pagina"|"regerar_pagina"|"duvida"|"outro","instrucao_clara":"o que fazer","resposta_direta":"resposta se duvida"}`,
      mensagem, 500
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

    console.log(`🎯 Intenção: ${intencao} — ${instrucao}`);

    if (intencao === 'duvida' || intencao === 'outro') {
      await enviarWhatsApp(telefone, respostaDireta);
      return;
    }

    if (intencao === 'editar_pagina' || intencao === 'regerar_pagina') {
      await enviarWhatsApp(telefone, `⚙️ Entendido! Estou gerando a nova versão da sua página...\n\nIsso leva cerca de 30 segundos 😊`);

      const paginaAtual = await getHtmlAtual(cliente.id);

      if (!paginaAtual?.html_completo) {
        await enviarWhatsApp(telefone, '❌ Não encontrei a página cadastrada. Entre em contato com o suporte.');
        return;
      }

      const htmlNovo = await chamarClaude(
        `Você é especialista em HTML para landing pages.
NEGÓCIO: ${nomeNegocio} — ${categoria} — ${cidade}
INSTRUÇÃO: "${instrucao}"
HTML ATUAL:
${paginaAtual.html_completo}
Aplique SOMENTE a alteração pedida. Mantenha todo estilo, cores e estrutura.
Retorne APENAS o HTML completo modificado. Zero explicações.`,
        instrucao, 8000
      );

      await setEstado(telefone, 'aguardando_aprovacao_pagina', {
        html_novo: htmlNovo,
        html_original: paginaAtual.html_completo,
        slug: paginaAtual.slug,
        url_atual: paginaAtual.url_publica
      });

      await enviarWhatsApp(telefone,
        `✅ Pronto! Gerei a nova versão da sua página.\n\n📄 Prévia atual: ${paginaAtual.url_publica}\n_(a nova versão só vai no ar quando você aprovar)_\n\nResponda:\n✅ *publicar* — colocar no ar agora\n✏️ *ajusta [o que mudar]* — fazer mais algum ajuste\n❌ *cancelar* — descartar`
      );
    }

  } catch (err) {
    console.error('❌ Erro no webhook:', err.message);
  }
});

app.get('/', (req, res) => res.send('VitrineIA Admin ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Admin rodando na porta ${PORT}`));
