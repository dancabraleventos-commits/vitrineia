// index.js
// --- 1. Importações e Configuração Inicial ---
// Importa as bibliotecas necessárias.
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo.env (para desenvolvimento local)
// Cria a instância do aplicativo Express.
const app = express();
app.use(bodyParser.json());
// --- 2. Validação de Variáveis de Ambiente ---
// Verifica se todas as variáveis críticas estão definidas na inicialização.
// Isso evita erros difíceis de depurar em produção.
const requiredEnvVars = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_REDIRECT_URI',
  'META_VERIFY_TOKEN',
  'N8N_WEBHOOK_URL',
  'PORT'
];
let missingVar = false;
requiredEnvVars.forEach(varName => {
  if (!process.env[varName]) {
    console.error(`[ERRO CRÍTICO] Variável de ambiente obrigatória não definida: ${varName}`);
    missingVar = true;
  }
});
if (missingVar) {
  console.error("Aplicação será encerrada. Por favor, defina todas as variáveis de ambiente necessárias.");
  process.exit(1); // Encerra o processo se alguma variável estiver faltando.
}
const PORT = process.env.PORT || 8080;
const VERSION = 'v19.0'; // É uma boa prática definir a versão da API como uma constante.
// --- 3. Rotas da Aplicação ---
// Rota principal (Health Check) - para verificar se o serviço está online.
app.get('/', (req, res) => {
  res.send('Serviço VitrineIA está rodando!');
});
// Rota para verificação do Webhook do WhatsApp/Instagram.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});
// Rota principal para receber eventos do Webhook.
app.post('/webhook', async (req, res) => {
  const data = req.body;
  // Garante que é um evento da API de WhatsApp Business.
  if (data.object === 'whatsapp_business_account') {
    if (data.entry && data.entry[0].changes && data.entry[0].changes[0].value) {
      const value = data.entry[0].changes[0].value;
      const field = data.entry[0].changes[0].field;
      // Log para depuração
      console.log(`[Webhook] Recebido evento do tipo: ${field}`);
      console.log('[Webhook] Payload:', JSON.stringify(value, null, 2));
      try {
        // Envia os dados para o seu workflow no n8n.
        await axios.post(process.env.N8N_WEBHOOK_URL, value);
        console.log('[Webhook] Evento encaminhado com sucesso para o n8n.');
      } catch (error) {
        console.error('[ERRO] Falha ao encaminhar evento para o n8n:', error.message);
        // Responda com 500 para indicar que houve um erro no seu lado.
        return res.sendStatus(500);
      }
    }
  }
  // Responda com 200 OK para a Meta, confirmando o recebimento.
  res.sendStatus(200);
});
// =================================================================
// --- NOVA ROTA: Callback de Autorização OAuth do Instagram ---
// =================================================================
app.get('/oauth/instagram/callback', async (req, res) => {
  // Extrai o código de autorização temporário da URL.
  const { code } = req.query;
  // 1. Verifica se o código foi recebido.
  if (!code) {
    console.error('[OAuth Error] Código de autorização não encontrado na URL.');
    return res.status(400).send('<h1>❌ Erro na autorização</h1><p>O código de autorização não foi fornecido. Tente novamente.</p>');
  }
  console.log(`[OAuth Callback] Código de autorização recebido: ${code.substring(0, 20)}...`);
  // 2. Troca o código por um Access Token.
  try {
    console.log('[OAuth Callback] Tentando trocar o código por um Access Token...');
    const tokenResponse = await axios.post(
      `https://graph.facebook.com/${VERSION}/oauth/access_token`,
      null, // O corpo é vazio, os parâmetros vão na URL
      {
        params: {
          client_id: process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          redirect_uri: process.env.META_REDIRECT_URI,
          code: code,
        }
      }
    );
    
    const { access_token, user_id } = tokenResponse.data;
    console.log('[OAuth Success] Access Token recebido com sucesso!');
    // =========================================================================
    // AÇÃO NECESSÁRIA: Salvar o `access_token` no seu banco de dados (Supabase)
    // Associe este token ao usuário ou à conta da empresa correspondente.
    //
    // Exemplo (você precisará do seu client do Supabase aqui):
    /*
    const { data, error } = await supabase
     .from('contas_instagram')
     .update({ instagram_access_token: access_token, instagram_user_id: user_id })
     .eq('id', 'ID_DO_USUARIO_LOGADO'); // Use o ID do usuário que iniciou o fluxo
    if (error) {
      throw new Error(`Falha ao salvar token no Supabase: ${error.message}`);
    }
    */
    // =========================================================================
    // 3. Redireciona o usuário para uma página de sucesso.
    res.send('<h1>✅ Autorização Concluída!</h1><p>A integração com o Instagram foi concluída com sucesso. Você pode fechar esta janela.</p>');
  } catch (error) {
    // 4. Tratamento de Erro Detalhado.
    console.error('[ERRO CRÍTICO NO OAUTH CALLBACK]');
    if (error.response) {
      // O erro veio da API da Meta, logue a resposta exata.
      console.error('Resposta da API da Meta:', JSON.stringify(error.response.data, null, 2));
      const errorMsg = error.response.data.error.message || 'Erro desconhecido da API.';
      res.status(500).send(`<h1>❌ Erro na autorização</h1><p>Ocorreu um problema ao comunicar com a Meta: ${errorMsg}</p><p>Verifique os logs do servidor para mais detalhes.</p>`);
    } else {
      // Ocorreu um erro na nossa aplicação (ex: rede, Supabase, etc).
      console.error('Erro de execução:', error.message);
      res.status(500).send('<h1>❌ Erro Interno</h1><p>Ocorreu um erro inesperado no nosso servidor. A equipe de desenvolvimento foi notificada.</p>');
    }
  }
});
// --- 4. Inicialização do Servidor ---
app.listen(PORT, () => {
  console.log(`Yasmin rodando na porta ${PORT}`);
  console.log('Serviço iniciado e aguardando eventos...');
});
