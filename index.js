const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ═══════════════════════════════════════
// PROMPT YASMIN — SYSTEM PROMPT
// ═══════════════════════════════════════

const YASMIN_SYSTEM = `Você é a Yasmin, assistente oficial da VitrineIA. Você cuida do cliente depois que ele fecha o plano.

PERSONALIDADE:
- Simpática, profissional e eficiente — NUNCA robótica
- Emojis com moderação (1-2 por mensagem)
- Mensagens CURTAS — máximo 3-4 linhas por balão
- Trata o cliente pelo nome sempre
- NUNCA menciona que é IA, robô ou assistente virtual
- Se não souber algo, diz que vai verificar com a equipe

PLANO VITRINE (R$47/mês):
- Landing page profissional gerada por IA
- Chatbot na página
- Formulário de agendamento
- Cupom de primeira visita
- SEO local
- Subdomínio: negocio.vitrineia.com.br
- Relatório mensal via WhatsApp
- Sem fidelidade

ADD-ONS DISPONÍVEIS:
🌐 Domínio próprio — R$9,90/mês
📅 Agendamento Online Avançado — R$29/mês
⭐ Avaliações Google Automáticas — R$19/mês
📸 Instagram Posts (12/mês) — R$39/mês
💬 Instagram DM Automático — R$19/mês
📱 Instagram Completo (Posts + DM) — R$49/mês

Responda SEMPRE como a Yasmin. Mensagens curtas e naturais.`;

// ═══════════════════════════════════════
// FUNÇÕES AUXILIARES
// ═══════════════════════════════════════

async function enviarWhatsApp(telefone, mensagem) {
  try {
    const url = `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`;
    await axios.post(url, { phone: telefone, message: mensagem }, {
      headers: { 'Client-Token': process.env.ZAPI_CLIENT_TOKEN }
    });
  } catch (e) {
    console.error('❌ Erro ao enviar WhatsApp:', e.message);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function enviarComDelay(telefone, mensagens) {
  for (let i = 0; i < mensagens.length; i++) {
    await enviarWhatsApp(telefone, mensagens[i]);
    if (i < mensagens.length - 1) await delay(1500);
  }
}

async function chamarClaude(system, mensagem, maxTokens = 1000) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: [{
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' }
    }],
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

async function chamarClaudeComHistorico(system, historico, maxTokens = 1000) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    system: [{
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' }
    }],
    messages: historico
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  });
  return res.data.content[0].text;
}

// ═══════════════════════════════════════
// ESTADO E DADOS DO ONBOARDING
// ═══════════════════════════════════════

async function getEstado(telefone, clienteId) {
  const { data } = await supabase
    .from('conversas_admin')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();

  if (data) return data;

  // Verificar se cliente já tem página (cliente antigo vs novo)
  const { data: pagina } = await supabase
    .from('paginas')
    .select('id')
    .eq('cliente_id', clienteId)
    .limit(1)
    .maybeSingle();

  const estadoInicial = pagina ? 'aguardando_instrucao' : 'onboarding_inicio';

  const { data: novo } = await supabase
    .from('conversas_admin')
    .insert({
      telefone,
      cliente_id: clienteId,
      estado: estadoInicial,
      acao_pendente: null,
      historico: []
    })
    .select()
    .maybeSingle();

  return novo;
}

async function setEstado(telefone, estado, acaoPendente = undefined) {
  const update = { estado, ultima_msg_em: new Date() };
  if (acaoPendente !== undefined) update.acao_pendente = acaoPendente;
  await supabase
    .from('conversas_admin')
    .update(update)
    .eq('telefone', telefone);
}

async function salvarHistorico(telefone, role, content) {
  const { data } = await supabase
    .from('conversas_admin')
    .select('historico')
    .eq('telefone', telefone)
    .maybeSingle();

  let historico = data?.historico || [];
  historico.push({ role, content });

  // Manter apenas últimas 20 mensagens pra não estourar contexto
  if (historico.length > 20) historico = historico.slice(-20);

  await supabase
    .from('conversas_admin')
    .update({ historico })
    .eq('telefone', telefone);
}

async function getHistorico(telefone) {
  const { data } = await supabase
    .from('conversas_admin')
    .select('historico')
    .eq('telefone', telefone)
    .maybeSingle();
  return data?.historico || [];
}

async function getDadosOnboarding(telefone) {
  const { data } = await supabase
    .from('conversas_admin')
    .select('acao_pendente')
    .eq('telefone', telefone)
    .maybeSingle();
  return data?.acao_pendente || {};
}

async function setDadosOnboarding(telefone, dados) {
  await supabase
    .from('conversas_admin')
    .update({ acao_pendente: dados })
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

// ═══════════════════════════════════════
// ONBOARDING — COLETA DE DADOS
// ═══════════════════════════════════════

async function handleOnboarding(telefone, mensagem, cliente, estado, conversa) {
  const dados = await getDadosOnboarding(telefone);
  const nomeCliente = cliente.nome_contato || cliente.nome || 'amigo';

  switch (estado) {

    case 'onboarding_inicio': {
      await enviarComDelay(telefone, [
        `Oi ${nomeCliente}! 😊 Seja muito bem-vindo à VitrineIA!`,
        `Sou a Yasmin, vou cuidar de tudo pra colocar sua página no ar.`,
        `Vou te fazer algumas perguntas rápidas pra montar sua página profissional. Pode ser?`
      ]);
      await setEstado(telefone, 'onboarding_aguardando_ok');
      return true;
    }

    case 'onboarding_aguardando_ok': {
      const msg = mensagem.toLowerCase().trim();
      if (msg.includes('sim') || msg.includes('pode') || msg.includes('bora') || msg.includes('ok') || msg.includes('claro') || msg.includes('vamos')) {
        await enviarWhatsApp(telefone, `Ótimo! 😊 Qual o *nome completo do seu negócio*? (como quer que apareça na página)`);
        await setEstado(telefone, 'coletando_nome');
      } else {
        await enviarWhatsApp(telefone, `Sem pressa! Quando estiver pronto, é só me chamar aqui que a gente começa 😊`);
      }
      return true;
    }

    case 'coletando_nome': {
      dados.nome_negocio = mensagem.trim();
      await setDadosOnboarding(telefone, dados);
      await enviarWhatsApp(telefone, `Lindo! E qual a *categoria* do negócio? Ex: restaurante, salão de beleza, clínica, academia, pet shop...`);
      await setEstado(telefone, 'coletando_categoria');
      return true;
    }

    case 'coletando_categoria': {
      dados.categoria = mensagem.trim();
      await setDadosOnboarding(telefone, dados);
      await enviarWhatsApp(telefone, `Qual o *endereço completo*? (rua, número, bairro e cidade)`);
      await setEstado(telefone, 'coletando_endereco');
      return true;
    }

    case 'coletando_endereco': {
      dados.endereco = mensagem.trim();
      await setDadosOnboarding(telefone, dados);
      await enviarWhatsApp(telefone, `Qual o *WhatsApp de atendimento* do negócio? Pode ser diferente do seu pessoal 😊`);
      await setEstado(telefone, 'coletando_whatsapp');
      return true;
    }

    case 'coletando_whatsapp': {
      const msg = mensagem.toLowerCase().trim();
      if (msg.includes('esse') || msg.includes('este') || msg.includes('mesmo') || msg.includes('igual')) {
        dados.whatsapp_negocio = telefone.replace(/\D/g, '');
      } else {
        dados.whatsapp_negocio = mensagem.replace(/\D/g, '');
      }
      await setDadosOnboarding(telefone, dados);
      await enviarWhatsApp(telefone, `Perfeito! E os *horários de funcionamento*? (ex: Seg a Sex 9h às 18h, Sáb 9h às 13h)`);
      await setEstado(telefone, 'coletando_horarios');
      return true;
    }

    case 'coletando_horarios': {
      dados.horarios = mensagem.trim();
      await setDadosOnboarding(telefone, dados);
      await enviarComDelay(telefone, [
        `Agora me conta os *principais serviços* que você oferece e os *preços* de cada um 😊`,
        `Pode mandar uns 4 a 6 serviços — quanto mais completo, melhor fica a página!`
      ]);
      await setEstado(telefone, 'coletando_servicos');
      return true;
    }

    case 'coletando_servicos': {
      const msg = mensagem.toLowerCase().trim();

      // Se disse "pronto", "só esses", "é isso" — avançar
      if (msg === 'pronto' || msg === 'só esses' || msg === 'so esses' || msg === 'é isso' || msg === 'e isso' || msg === 'isso' || msg === 'só' || msg === 'so') {
        if (!dados.servicos || dados.servicos.trim().length < 10) {
          await enviarWhatsApp(telefone, `Preciso de pelo menos uns 3-4 serviços com preços pra página ficar completa 😊 Pode mandar?`);
          return true;
        }
        await setDadosOnboarding(telefone, dados);
        await enviarWhatsApp(telefone, `Ótimo! Tem algo que *diferencia* seu negócio dos outros? Algo que seus clientes sempre elogiam? 😊`);
        await setEstado(telefone, 'coletando_diferencial');
        return true;
      }

      // Acumular serviços
      if (!dados.servicos) dados.servicos = '';
      dados.servicos += (dados.servicos ? '\n' : '') + mensagem.trim();
      await setDadosOnboarding(telefone, dados);

      // Contar linhas com conteúdo real
      const linhas = dados.servicos.split('\n').filter(l => l.trim().length > 3);

      if (linhas.length >= 6) {
        // Já tem bastante — avançar automaticamente
        await enviarWhatsApp(telefone, `Ótimo, anotei tudo! Tem algo que *diferencia* seu negócio dos outros? Algo que seus clientes sempre elogiam? 😊`);
        await setEstado(telefone, 'coletando_diferencial');
      } else {
        await enviarWhatsApp(telefone, `Anotado! Pode mandar mais serviços ou digitar *pronto* quando terminar 😊`);
      }
      return true;
    }

    case 'coletando_diferencial': {
      const msg = mensagem.toLowerCase().trim();
      if (msg.includes('não') || msg.includes('nao') || msg.includes('sei') || msg.includes('nada')) {
        dados.diferencial = '';
        await setDadosOnboarding(telefone, dados);
        await enviarWhatsApp(telefone, `Sem problema! A gente destaca o melhor da sua categoria 😊`);
      } else {
        dados.diferencial = mensagem.trim();
        await setDadosOnboarding(telefone, dados);
        await enviarWhatsApp(telefone, `Adorei! Vou destacar isso na página 😊`);
      }
      await delay(1000);
      await enviarWhatsApp(telefone, `Última coisa: você tem um *logo* do negócio? Se tiver, me manda aqui! Se não, a gente coloca o nome estilizado e fica bonito também 😊`);
      await setEstado(telefone, 'coletando_logo');
      return true;
    }

    case 'coletando_logo': {
      const msg = mensagem.toLowerCase().trim();
      if (msg.includes('não') || msg.includes('nao') || msg.includes('tenho não') || msg.includes('sem logo') || msg.includes('nao tenho')) {
        dados.tem_logo = false;
        dados.logo_url = null;
      } else {
        // Cliente disse que tem ou mandou algo — marcar como pendente
        // A imagem real será tratada via Z-API imageUrl no body do webhook
        dados.tem_logo = true;
        dados.logo_url = null; // Atualizar quando receber a imagem
      }
      await setDadosOnboarding(telefone, dados);

      // Montar confirmação
      const whatsFormatado = dados.whatsapp_negocio ?
        dados.whatsapp_negocio.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3') :
        'mesmo deste chat';

      await enviarComDelay(telefone, [
        `Perfeito ${nomeCliente}! Deixa eu confirmar os dados:`,
        `📌 *${dados.nome_negocio}*\n📍 ${dados.endereco}\n📱 WhatsApp: ${whatsFormatado}\n🕐 ${dados.horarios}\n🔧 Serviços: ${dados.servicos?.split('\n').slice(0, 4).join(', ')}${dados.diferencial ? '\n✨ Diferencial: ' + dados.diferencial : ''}`,
        `Tá tudo certo? Posso montar sua página? 😊`
      ]);
      await setEstado(telefone, 'confirmando_dados');
      return true;
    }

    case 'confirmando_dados': {
      const msg = mensagem.toLowerCase().trim();

      if (msg.includes('sim') || msg.includes('isso') || msg.includes('certo') || msg.includes('ok') || msg.includes('pode') || msg.includes('tá') || msg.includes('correto')) {
        await setEstado(telefone, 'oferecendo_dominio');
        // Ir direto pro fluxo de add-ons
        await enviarWhatsApp(telefone, `Enquanto monto sua página, uma pergunta: você já tem um *domínio próprio*? Tipo ${dados.nome_negocio?.toLowerCase().replace(/\s+/g, '')}.com.br?`);
        return true;
      }

      if (msg.includes('não') || msg.includes('nao') || msg.includes('errado') || msg.includes('mudar') || msg.includes('corrig')) {
        await enviarWhatsApp(telefone, `Sem problema! Me fala o que precisa corrigir que eu ajusto 😊`);
        await setEstado(telefone, 'corrigindo_dados');
        return true;
      }

      await enviarWhatsApp(telefone, `Me confirma se os dados estão certos pra eu montar a página 😊 Responde *sim* ou me fala o que precisa ajustar.`);
      return true;
    }

    case 'corrigindo_dados': {
      // Usar Claude pra entender o que corrigir
      const correcao = await chamarClaude(
        `O cliente quer corrigir dados do onboarding. Dados atuais: ${JSON.stringify(dados)}
Mensagem do cliente: "${mensagem}"
Retorne SOMENTE JSON com os campos corrigidos. Ex: {"nome_negocio":"Novo Nome"} ou {"horarios":"Seg a Sex 8h-20h"}
Se não conseguir identificar o campo, retorne: {"campo":"desconhecido","mensagem":"o que o cliente disse"}
Zero explicações, só JSON.`,
        mensagem, 300
      );

      try {
        const parsed = JSON.parse(correcao.replace(/```json|```/g, '').trim());
        if (parsed.campo === 'desconhecido') {
          await enviarWhatsApp(telefone, `Me fala especificamente o que quer mudar: nome, endereço, horários, serviços ou WhatsApp? 😊`);
          return true;
        }
        Object.assign(dados, parsed);
        await setDadosOnboarding(telefone, dados);
        await enviarWhatsApp(telefone, `Pronto, atualizei! 😊 Agora sim, posso montar sua página?`);
        await setEstado(telefone, 'confirmando_dados');
      } catch (e) {
        await enviarWhatsApp(telefone, `Me fala especificamente o que quer mudar que eu ajusto 😊`);
      }
      return true;
    }

    // ═══════════════════════════════════════
    // ADD-ONS — OFERTAS DURANTE ONBOARDING
    // ═══════════════════════════════════════

    case 'oferecendo_dominio': {
      const msg = mensagem.toLowerCase().trim();

      if (msg.includes('sim') || msg.includes('tenho')) {
        await enviarWhatsApp(telefone, `Ótimo! Me manda o domínio que a gente aponta pra sua página sem custo nenhum 😊`);
        await setEstado(telefone, 'coletando_dominio_proprio');
        return true;
      }

      if (msg.includes('não') || msg.includes('nao')) {
        await enviarWhatsApp(telefone, `Posso registrar um domínio exclusivo pra você por *R$9,90/mês*. Fica muito mais profissional! Quer? 😊`);
        await setEstado(telefone, 'decidindo_dominio');
        return true;
      }

      await enviarWhatsApp(telefone, `Você tem um domínio próprio (tipo seusite.com.br) ou quer que eu registre um? 😊`);
      return true;
    }

    case 'coletando_dominio_proprio': {
      dados.dominio_proprio = mensagem.trim();
      dados.addon_dominio = false;
      await setDadosOnboarding(telefone, dados);
      await enviarWhatsApp(telefone, `Anotado! Vou apontar ${dados.dominio_proprio} pra sua página 😊`);
      await delay(1000);
      // Ir para add-ons principais
      await oferecerAddons(telefone, dados);
      return true;
    }

    case 'decidindo_dominio': {
      const msg = mensagem.toLowerCase().trim();
      if (msg.includes('sim') || msg.includes('quero') || msg.includes('pode') || msg.includes('bora')) {
        dados.addon_dominio = true;
        await setDadosOnboarding(telefone, dados);
        await enviarWhatsApp(telefone, `Perfeito! Vou ativar o domínio exclusivo pra você 😊`);
      } else {
        dados.addon_dominio = false;
        await setDadosOnboarding(telefone, dados);
        await enviarWhatsApp(telefone, `Sem problema! Sua página fica em ${dados.nome_negocio?.toLowerCase().replace(/\s+/g, '-')}.vitrineia.com.br 😊`);
      }
      await delay(1000);
      await oferecerAddons(telefone, dados);
      return true;
    }

    case 'oferecendo_addons': {
      const msg = mensagem.toLowerCase().trim();

      if (!dados.addons_oferecidos) dados.addons_oferecidos = true;

      // Usar Claude pra interpretar resposta sobre add-ons
      const interpretacao = await chamarClaude(
        `O cliente respondeu sobre add-ons. Mensagem: "${mensagem}"
Add-ons disponíveis:
- agendamento (R$29/mês)
- avaliacoes (R$19/mês)
- instagram_posts (R$39/mês)
- instagram_dm (R$19/mês)
- instagram_completo (R$49/mês)

Retorne SOMENTE JSON:
{"addons_escolhidos":["agendamento","avaliacoes"],"quer_mais":true,"nenhum":false}
Se disse não pra tudo: {"addons_escolhidos":[],"quer_mais":false,"nenhum":true}
Se mostrou interesse parcial: marcar os que escolheu e quer_mais:false
Zero explicações, só JSON.`,
        mensagem, 300
      );

      try {
        const parsed = JSON.parse(interpretacao.replace(/```json|```/g, '').trim());

        if (parsed.nenhum) {
          dados.addons = [];
          await setDadosOnboarding(telefone, dados);
          await enviarWhatsApp(telefone, `Sem problemas! Sua página já vai ficar incrível 😊\n\nQualquer hora que quiser ativar, é só me chamar aqui!`);
          await delay(1000);
          await iniciarGeracaoPagina(telefone, dados, cliente);
          return true;
        }

        dados.addons = parsed.addons_escolhidos || [];
        await setDadosOnboarding(telefone, dados);

        // Calcular valor total
        const precos = {
          agendamento: 29, avaliacoes: 19,
          instagram_posts: 39, instagram_dm: 19, instagram_completo: 49
        };
        const valorAddons = dados.addons.reduce((sum, a) => sum + (precos[a] || 0), 0);
        const valorDominio = dados.addon_dominio ? 9.90 : 0;
        const valorTotal = 47 + valorAddons + valorDominio;

        const addonsNomes = {
          agendamento: '📅 Agendamento Online',
          avaliacoes: '⭐ Avaliações Google',
          instagram_posts: '📸 Instagram Posts',
          instagram_dm: '💬 Instagram DM',
          instagram_completo: '📱 Instagram Completo'
        };

        const listaAddons = dados.addons.map(a => addonsNomes[a] || a).join('\n');

        await enviarComDelay(telefone, [
          `Perfeito! Vou ativar pra você:${dados.addon_dominio ? '\n🌐 Domínio próprio' : ''}\n${listaAddons}`,
          `Valor total: *R$${valorTotal.toFixed(2)}/mês* 😊`,
        ]);
        await delay(1000);
        await iniciarGeracaoPagina(telefone, dados, cliente);
      } catch (e) {
        // Se não conseguiu interpretar, perguntar de novo
        await enviarWhatsApp(telefone, `Me fala quais te interessaram ou se prefere seguir sem add-ons por enquanto 😊`);
      }
      return true;
    }

    case 'gerando_pagina': {
      // Cliente mandou mensagem enquanto página está sendo gerada
      await enviarWhatsApp(telefone, `Ainda estou montando sua página, ${nomeCliente}! Mais alguns segundinhos 😊`);
      return true;
    }

    default:
      return false; // Estado não reconhecido no onboarding
  }
}

// ═══════════════════════════════════════
// OFERECER ADD-ONS POR CATEGORIA
// ═══════════════════════════════════════

async function oferecerAddons(telefone, dados) {
  const cat = (dados.categoria || '').toLowerCase();
  let msgAddons = '';

  if (cat.includes('salão') || cat.includes('salao') || cat.includes('barbearia') || cat.includes('estética') || cat.includes('estetica') || cat.includes('beleza')) {
    msgAddons = `Já que você é do ramo de beleza, dois add-ons que fazem muita diferença:\n\n📅 *Agendamento Online* — R$29/mês\nSuas clientes agendam direto pela página e você recebe no WhatsApp com lembrete automático.\n\n⭐ *Avaliações Google* — R$19/mês\nPede avaliação pra cada cliente após o atendimento. Mais avaliações = mais gente te achando.`;
  } else if (cat.includes('restaurante') || cat.includes('lanchonete') || cat.includes('padaria') || cat.includes('café') || cat.includes('pizza')) {
    msgAddons = `Pra restaurante, dois add-ons que fazem muita diferença:\n\n📅 *Agendamento de Reservas* — R$29/mês\nCliente reserva mesa direto pela página.\n\n⭐ *Avaliações Google* — R$19/mês\nMais avaliações = aparece mais no Google Maps da região.`;
  } else if (cat.includes('clínica') || cat.includes('clinica') || cat.includes('médico') || cat.includes('medico') || cat.includes('dentista') || cat.includes('nutrici')) {
    msgAddons = `Pra área da saúde, dois add-ons que fazem muita diferença:\n\n📅 *Agendamento Online* — R$29/mês\nPacientes agendam direto pela página e você recebe no WhatsApp.\n\n⭐ *Avaliações Google* — R$19/mês\nPede avaliação automática após cada consulta.`;
  } else if (cat.includes('academia') || cat.includes('pilates') || cat.includes('yoga') || cat.includes('crossfit')) {
    msgAddons = `Pra academia, dois add-ons que fazem muita diferença:\n\n📅 *Agendamento de Aula Experimental* — R$29/mês\nAlunos agendam direto pela página.\n\n⭐ *Avaliações Google* — R$19/mês\nMais avaliações = mais gente achando sua academia.`;
  } else if (cat.includes('pet') || cat.includes('veterinár') || cat.includes('veterinar')) {
    msgAddons = `Pra pet shop, dois add-ons que fazem muita diferença:\n\n📅 *Agendamento Online* — R$29/mês\nTutores agendam banho e consulta direto pela página.\n\n⭐ *Avaliações Google* — R$19/mês\nMais avaliações = mais clientes orgânicos.`;
  } else {
    msgAddons = `Temos dois add-ons que fazem muita diferença:\n\n📅 *Agendamento Online* — R$29/mês\nClientes agendam direto pela página e você recebe no WhatsApp.\n\n⭐ *Avaliações Google* — R$19/mês\nPede avaliação automática após cada atendimento.`;
  }

  await enviarWhatsApp(telefone, msgAddons);
  await delay(2000);
  await enviarWhatsApp(telefone, `Também temos gestão de Instagram automática:\n\n📸 *Instagram Posts* — R$39/mês (12 posts/mês)\n💬 *Instagram DM* — R$19/mês (respostas automáticas)\n📱 *Instagram Completo* — R$49/mês (Posts + DM com desconto)\n\nAlgum te interessou? 😊`);
  await setEstado(telefone, 'oferecendo_addons');
}

// ═══════════════════════════════════════
// GERAR PÁGINA
// ═══════════════════════════════════════

async function iniciarGeracaoPagina(telefone, dados, cliente) {
  await setEstado(telefone, 'gerando_pagina');
  await enviarWhatsApp(telefone, `Estou gerando sua página agora! Em poucos minutos te mando o link pra você aprovar 😊`);

  try {
    // Atualizar dados do cliente no Supabase
    await supabase.from('clientes').update({
      nome: dados.nome_negocio,
      segmento: dados.categoria,
      cidade: dados.endereco?.split(',').pop()?.trim() || '',
      endereco: dados.endereco,
      whatsapp_negocio: dados.whatsapp_negocio,
      horarios: dados.horarios,
      servicos: dados.servicos,
      diferencial: dados.diferencial,
      addons: dados.addons || [],
      addon_dominio: dados.addon_dominio || false
    }).eq('id', cliente.id);

    // Gerar HTML via Claude
    const whatsappLimpo = (dados.whatsapp_negocio || telefone).replace(/\D/g, '');
    const htmlCompleto = await chamarClaude(
      PROMPT_GERAR_PAGINA,
      `Crie a landing page para este negócio:\n\nNome: ${dados.nome_negocio}\nCategoria: ${dados.categoria}\nCidade: ${dados.endereco}\nWhatsApp: ${whatsappLimpo}\nHorário: ${dados.horarios}\nServiços: ${dados.servicos}\nDiferencial: ${dados.diferencial || 'Qualidade e bom atendimento'}`,
      16000
    );

    // Criar slug
    const slug = (dados.nome_negocio || 'negocio')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);

    // Publicar no Vercel
    const url = await publicarVercel(slug, htmlCompleto);

    // Salvar no Supabase
    await supabase.from('paginas').insert({
      cliente_id: cliente.id,
      slug,
      html_completo: htmlCompleto,
      url_publica: url,
      titulo: dados.nome_negocio,
      publicada: true
    });

    // Mandar pro cliente aprovar
    await setEstado(telefone, 'aguardando_aprovacao_onboarding', {
      html_novo: htmlCompleto,
      html_original: htmlCompleto,
      slug,
      url_atual: url
    });

    await enviarComDelay(telefone, [
      `${cliente.nome_contato || 'Ei'}, sua página ficou pronta! 🎉`,
      `Dá uma olhada: ${url}`,
      `Vê se tá tudo certinho — nome, serviços, preços, horários.\n\nSe quiser mudar qualquer coisa, é só me falar aqui! 😊`
    ]);

  } catch (e) {
    console.error('❌ Erro ao gerar página:', e.message);
    await enviarWhatsApp(telefone, `Ops, tive um probleminha técnico 😅 Estou tentando novamente. Se demorar, manda um "oi" aqui que eu resolvo!`);
    await setEstado(telefone, 'confirmando_dados');
  }
}

// ═══════════════════════════════════════
// PROMPT PARA GERAR LANDING PAGE (com cache)
// ═══════════════════════════════════════

const PROMPT_GERAR_PAGINA = `Você é um designer e desenvolvedor web premium especializado em landing pages de alta conversão para comércios locais brasileiros.

REGRAS TÉCNICAS ABSOLUTAS:
- Retornar SOMENTE HTML completo. Zero explicações, zero markdown, zero texto fora do HTML.
- Todo CSS dentro de <style> no <head> (não inline por atributo)
- Responsivo mobile-first — perfeito no celular
- Sem imagens externas — usar SVGs elaborados, ilustrações vetoriais e gradientes
- Google Fonts permitido: importar via <link> no head (escolher fontes premium, NUNCA usar Inter, Roboto ou Arial)
- Usar variáveis CSS para cores e espaçamentos
- HTML semântico com IDs em cada seção para navegação

TIPOGRAFIA:
- Fonte display para títulos: escolher fonte marcante do Google Fonts por categoria
- Fonte body: sans-serif limpa (DM Sans, Plus Jakarta Sans, Outfit)
- Títulos GRANDES com destaque visual

CORES POR CATEGORIA (paleta completa):
- restaurante/lanchonete/padaria = #FF6B35 laranja
- salão/barbearia/estética = #E91E8C rosa
- clínica/dentista/médico/nutricionista = #0288D1 azul
- academia/pilates/yoga = #27AE60 verde
- pet shop/veterinário = #F39C12 amarelo
- outros = #5C6BC0 roxo

SEÇÕES OBRIGATÓRIAS:
1. Header fixo com blur + nome em <span id="logo-nome" class="logo-nome"> + botão WhatsApp
2. Hero com slogan criativo + ilustração SVG elaborada + 2 botões CTA
3. Barra de confiança
4. Sobre nós (3 parágrafos específicos)
5. Serviços (6 cards com ícones SVG + preços)
6. Por que nos escolher (4 diferenciais)
7. Cupom primeira visita (10% desconto)
8. Agendamento online (formulário que abre WhatsApp formatado)
9. Depoimentos (3 realistas)
10. Lista VIP
11. Localização + horários
12. Footer com "Powered by VitrineIA"

ELEMENTOS FIXOS:
- Botão WhatsApp flutuante verde #25D366 canto inferior direito com pulse
- Chatbot mini canto inferior esquerdo com perguntas rápidas e animação de digitação

Inclua: animações CSS fade-in, hover nos cards, Intersection Observer, máscara de telefone, menu hamburger mobile.

Meta tags SEO + Open Graph + favicon inline SVG.

Retorne APENAS o código HTML completo.`;

// ═══════════════════════════════════════
// SUPORTE — CLIENTE ATIVO (PÓS-ONBOARDING)
// ═══════════════════════════════════════

async function handleSuporte(telefone, mensagem, cliente) {
  const nomeNegocio = cliente.nome || 'seu negócio';
  const categoria = cliente.segmento || '';
  const cidade = cliente.cidade || '';
  const nomeContato = cliente.nome_contato || cliente.nome || '';

  // Salvar mensagem no histórico
  await salvarHistorico(telefone, 'user', mensagem);

  // Buscar histórico recente
  const historico = await getHistorico(telefone);

  // Montar contexto completo pra Yasmin
  const systemSuporte = `${YASMIN_SYSTEM}

DADOS DO CLIENTE:
Nome do contato: ${nomeContato}
Negócio: ${nomeNegocio}
Categoria: ${categoria}
Cidade: ${cidade}
Add-ons ativos: ${JSON.stringify(cliente.addons || [])}

INSTRUÇÕES:
1. Se o cliente quer EDITAR a página (mudar preço, horário, serviço, texto, etc) → responda EXATAMENTE com JSON: {"acao":"editar","instrucao":"o que editar"}
2. Se o cliente quer CANCELAR → seja gentil, tente entender o motivo, mas NUNCA dificulte. Se insistir: {"acao":"cancelar"}
3. Se o cliente pergunta sobre ADD-ON que não tem → apresente naturalmente com preço
4. Se é DÚVIDA ou CONVERSA → responda como Yasmin, curta e simpática
5. Para qualquer resposta conversacional, responda diretamente como Yasmin (sem JSON)

IMPORTANTE: Mensagens CURTAS (máximo 3-4 linhas). Nunca mande textão.`;

  const resposta = await chamarClaudeComHistorico(systemSuporte, historico, 500);

  // Verificar se é uma ação (edição/cancelamento)
  try {
    const parsed = JSON.parse(resposta.replace(/```json|```/g, '').trim());

    if (parsed.acao === 'editar') {
      // Fluxo de edição (mantido do código original)
      await enviarWhatsApp(telefone, `⚙️ Entendido! Estou gerando a nova versão...\n\nIsso leva cerca de 30 segundos 😊`);

      const paginaAtual = await getHtmlAtual(cliente.id);
      if (!paginaAtual?.html_completo) {
        await enviarWhatsApp(telefone, '❌ Não encontrei a página cadastrada. Vou verificar com a equipe!');
        return;
      }

      const htmlNovo = await chamarClaude(
        `Você é especialista em HTML para landing pages.
NEGÓCIO: ${nomeNegocio} — ${categoria} — ${cidade}
INSTRUÇÃO: "${parsed.instrucao}"
HTML ATUAL:
${paginaAtual.html_completo}
Aplique SOMENTE a alteração pedida. Mantenha todo estilo, cores e estrutura.
Retorne APENAS o HTML completo modificado. Zero explicações.`,
        parsed.instrucao, 16000
      );

      await setEstado(telefone, 'aguardando_aprovacao_pagina', {
        html_novo: htmlNovo,
        html_original: paginaAtual.html_completo,
        slug: paginaAtual.slug,
        url_atual: paginaAtual.url_publica
      });

      await salvarHistorico(telefone, 'assistant', 'Gerei a nova versão da sua página.');

      await enviarComDelay(telefone, [
        `Pronto! Gerei a nova versão 😊`,
        `Página atual: ${paginaAtual.url_publica}\n\nResponda:\n✅ *publicar* — colocar no ar\n✏️ *ajusta [o que mudar]* — mais ajustes\n❌ *cancelar* — descartar`
      ]);
      return;
    }

    if (parsed.acao === 'cancelar') {
      await salvarHistorico(telefone, 'assistant', 'Cliente solicitou cancelamento.');
      await enviarWhatsApp(telefone, `Cancelamento processado, ${nomeContato}. Sua página fica no ar até o fim do período pago. Se quiser voltar, é só me chamar! 😊`);
      await supabase.from('clientes').update({ ativo: false }).eq('id', cliente.id);
      return;
    }
  } catch (e) {
    // Não é JSON — é resposta conversacional normal
  }

  // Resposta conversacional da Yasmin
  await salvarHistorico(telefone, 'assistant', resposta);
  await enviarWhatsApp(telefone, resposta);
}

// ═══════════════════════════════════════
// WEBHOOK PRINCIPAL
// ═══════════════════════════════════════

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

    // Buscar cliente
    const { data: clientes, error: erroCliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefone', telefoneLimpo)
      .limit(1);

    const cliente = clientes?.[0];

    if (!cliente) {
      await enviarWhatsApp(telefone, 'Oi! Ainda não encontrei seu cadastro aqui 😊\n\nSe você já contratou a VitrineIA, me manda o comprovante que eu verifico!\n\nSe ainda não conhece: vitrineia.com.br');
      return;
    }

    console.log(`✅ Cliente: ${cliente.nome} | Estado atual...`);

    const conversa = await getEstado(telefone, cliente.id);
    const estado = conversa?.estado || 'onboarding_inicio';
    console.log(`📌 Estado: ${estado}`);

    // ═══════════════════════════════════════
    // ESTADOS DE ONBOARDING
    // ═══════════════════════════════════════

    const estadosOnboarding = [
      'onboarding_inicio', 'onboarding_aguardando_ok',
      'coletando_nome', 'coletando_categoria', 'coletando_endereco',
      'coletando_whatsapp', 'coletando_horarios', 'coletando_servicos',
      'coletando_diferencial', 'coletando_logo',
      'confirmando_dados', 'corrigindo_dados',
      'oferecendo_dominio', 'coletando_dominio_proprio', 'decidindo_dominio',
      'oferecendo_addons', 'gerando_pagina'
    ];

    if (estadosOnboarding.includes(estado)) {
      await handleOnboarding(telefone, mensagem, cliente, estado, conversa);
      return;
    }

    // ═══════════════════════════════════════
    // APROVAÇÃO DE PÁGINA (onboarding e edição)
    // ═══════════════════════════════════════

    if (estado === 'aguardando_aprovacao_pagina' || estado === 'aguardando_aprovacao_onboarding') {
      const msg = mensagem.toLowerCase().trim();
      const acaoPendente = conversa.acao_pendente;

      // Aprovação
      if (msg.includes('publicar') || msg.includes('aprovado') || msg.includes('perfeito') || msg.includes('ficou') || msg.includes('amei') || msg.includes('adorei') || msg.includes('gostei') || msg.includes('lindo') || msg.includes('linda') || msg.includes('ótimo') || msg.includes('otimo') || msg.includes('aprovad') || msg === 'ok' || msg === 'sim') {

        if (estado === 'aguardando_aprovacao_onboarding') {
          // No onboarding a página já foi publicada
          await setEstado(telefone, 'aguardando_instrucao', null);
          const nomeContato = cliente.nome_contato || cliente.nome || '';
          await enviarComDelay(telefone, [
            `Que bom que gostou, ${nomeContato}! 🎉`,
            `Sua página já está no ar e vai começar a aparecer no Google!`,
            `Qualquer alteração futura, é só me chamar aqui. Sou sua Yasmin! 😊`
          ]);
          return;
        }

        // Edição — publicar nova versão
        await enviarWhatsApp(telefone, '⏳ Publicando sua página...');
        try {
          const url = await publicarVercel(acaoPendente.slug, acaoPendente.html_novo);
          await supabase.from('paginas')
            .update({ html_completo: acaoPendente.html_novo, url_publica: url })
            .eq('cliente_id', cliente.id);
          await setEstado(telefone, 'aguardando_instrucao', null);
          await enviarWhatsApp(telefone, `✅ Atualizada!\n\n👉 ${url}\n\nEm até 2 minutos já aparece 😊`);
        } catch (e) {
          console.error('Erro ao publicar:', e.message);
          await enviarWhatsApp(telefone, '❌ Erro ao publicar. Tenta de novo ou me chama que resolvo!');
          await setEstado(telefone, 'aguardando_instrucao', null);
        }
        return;
      }

      // Cancelar
      if (msg.includes('cancelar') || msg === 'não' || msg === 'nao') {
        await setEstado(telefone, 'aguardando_instrucao', null);
        await enviarWhatsApp(telefone, 'Ok, descartei as alterações 👍\nSua página atual continua no ar.');
        return;
      }

      // Ajuste
      if (msg.includes('ajust') || msg.includes('mud') || msg.includes('corrig') || msg.includes('troc') || msg.includes('alter')) {
        await enviarWhatsApp(telefone, '⏳ Aplicando o ajuste...');
        const instrucaoAjuste = mensagem.trim();
        try {
          const htmlAjustado = await chamarClaude(
            `Você é especialista em HTML para landing pages.
INSTRUÇÃO: "${instrucaoAjuste}"
HTML ATUAL:
${acaoPendente.html_novo}
Aplique SOMENTE a alteração pedida. Mantenha todo estilo e estrutura.
Retorne APENAS o HTML completo modificado. Zero explicações.`,
            instrucaoAjuste, 16000
          );
          await setEstado(telefone, estado, { ...acaoPendente, html_novo: htmlAjustado });
          await enviarWhatsApp(telefone, `✏️ Ajuste feito!\n\nResponda:\n✅ *publicar* — colocar no ar\n✏️ Me fala mais algum ajuste\n❌ *cancelar* — descartar`);
        } catch (e) {
          console.error('Erro no ajuste:', e.message);
          await enviarWhatsApp(telefone, 'Ops, erro no ajuste 😅 Tenta me falar de outro jeito o que quer mudar?');
        }
        return;
      }

      // Não entendeu — usar Yasmin pra interpretar
      const interpretacao = await chamarClaude(
        `O cliente está vendo a prévia da página e mandou: "${mensagem}"
É um elogio/aprovação? → responda "aprovar"
É um pedido de ajuste? → responda "ajuste: [o que ajustar]"
É cancelamento? → responda "cancelar"
É outra coisa? → responda "outro: [resposta curta da Yasmin]"
Responda SOMENTE uma dessas opções.`,
        mensagem, 200
      );

      const inter = interpretacao.toLowerCase().trim();
      if (inter.startsWith('aprovar') || inter.includes('aprovação') || inter.includes('elogio')) {
        // Reaproveitar lógica de aprovação simulando a mensagem
        await enviarWhatsApp(telefone, `Que bom que gostou! 🎉 Quer que eu publique? Responde *publicar* pra colocar no ar!`);
      } else if (inter.startsWith('ajuste:')) {
        await enviarWhatsApp(telefone, '⏳ Aplicando o ajuste...');
        const instrucao = inter.replace('ajuste:', '').trim();
        try {
          const htmlAjustado = await chamarClaude(
            `Você é especialista em HTML para landing pages.
INSTRUÇÃO: "${instrucao}"
HTML ATUAL:
${acaoPendente.html_novo}
Aplique SOMENTE a alteração pedida. Mantenha todo estilo e estrutura.
Retorne APENAS o HTML completo modificado. Zero explicações.`,
            instrucao, 16000
          );
          await setEstado(telefone, estado, { ...acaoPendente, html_novo: htmlAjustado });
          await enviarWhatsApp(telefone, `✏️ Ajuste feito!\n\nResponda:\n✅ *publicar* — colocar no ar\n✏️ Me fala mais algum ajuste\n❌ *cancelar* — descartar`);
        } catch (e) {
          await enviarWhatsApp(telefone, 'Não consegui aplicar o ajuste 😅 Tenta descrever de outro jeito?');
        }
      } else {
        await enviarWhatsApp(telefone, `${interpretacao.replace(/^outro:\s*/i, '')}\n\nSe quiser publicar a página, responde *publicar* 😊`);
      }
      return;
    }

    // ═══════════════════════════════════════
    // CLIENTE ATIVO — SUPORTE CONTÍNUO
    // ═══════════════════════════════════════

    if (estado === 'aguardando_instrucao') {
      await handleSuporte(telefone, mensagem, cliente);
      return;
    }

    // Estado desconhecido — resetar
    console.log(`⚠️ Estado desconhecido: ${estado}. Resetando.`);
    await setEstado(telefone, 'aguardando_instrucao', null);
    await enviarWhatsApp(telefone, `Oi! Sou a Yasmin da VitrineIA 😊 Como posso te ajudar?`);

  } catch (err) {
    console.error('❌ Erro no webhook:', err.message, err.stack);
  }
});

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════

app.get('/', (req, res) => res.send('VitrineIA Admin — Yasmin ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Yasmin rodando na porta ${PORT}`));
