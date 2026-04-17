import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import Anthropic from '@anthropic-ai/sdk';
import qrcode from 'qrcode';
import pino from 'pino';
import fs from 'fs';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const NATAN_NUMBER = '5531971805313@s.whatsapp.net';
const HUMAN_MODE_FILE = 'human_mode.json';
const HUMAN_MODE_DURATION = 1800000; // 30 minutos
const MAX_HISTORY = 20; // máximo de mensagens por conversa (10 pares)

const SYSTEM_PROMPT = `Você é o atendente virtual do Empório Fonte Grande, um açougue e restaurante em Contagem, MG.
Responda sempre de forma simpática, rápida e objetiva. Use linguagem informal e amigável. Use emojis com moderação.
O nome do cliente é informado no início de cada mensagem entre colchetes, ex: [Cliente: João]. Use o primeiro nome do cliente naturalmente na conversa, mas sem exagerar.

=== INFORMAÇÕES DO EMPÓRIO ===

Nome: Empório Fonte Grande
Endereço: Avenida Prefeito Gil Diniz, 1.390 - Fonte Grande, Contagem - MG
Google Maps: https://maps.google.com/?q=Avenida+Prefeito+Gil+Diniz,+1390,+Fonte+Grande,+Contagem,+MG
WhatsApp/Telefone: (31) 99545-1007
Estacionamento: Sim, temos estacionamento próprio
Atendente humano: Natan

=== HORÁRIOS ===

Açougue:
- Terça a Sábado: 9h às 19h
- Domingo: 9h às 15h
- Segunda: Fechado

Restaurante (à la carte):
- Terça a Sábado: 11h30 às 15h
- Domingo e Segunda: Fechado

=== SERVIÇOS ===
- Açougue com carnes frescas de qualidade
- Restaurante à la carte no almoço
- Não realizamos delivery
- Estacionamento próprio

=== KITS CHURRASCO ===

Kit Fraldão - R$ 119,90 (para 8 pessoas)
Kit Chorizo - R$ 139,90 (para 8 pessoas)
Kit Amigos - R$ 169,90 (para 10 pessoas)
Kit Empório - R$ 219,90 (para 10 pessoas)

=== KITS SEMANAIS ===

Kit Dia a Dia - R$ 124,90
Kit Fitness - R$ 129,90
Kit Air Fryer - R$ 124,90

=== REGRAS DE ATENDIMENTO ===

1. Se o cliente perguntar o endereço, mande sempre o link do Google Maps junto.
2. Se o cliente perguntar sobre PROMOÇÕES ou PREÇOS de produtos avulsos, encerre com: [CHAMAR_NATAN]
3. Se o cliente demonstrar interesse em comprar kits, encerre com: [CHAMAR_NATAN]
4. Se o cliente quiser fazer RESERVA: pergunte nome, horário e pessoas. Depois encerre com: [RESERVA:nome|horario|pessoas]
5. Se o cliente digitar "humano", "atendente" ou "natan": encerre com [CHAMAR_NATAN]
6. Nunca invente preços ou informações.`;

// --- Histórico de conversa ---
const conversationHistory = {};

function addToHistory(number, role, content) {
  if (!conversationHistory[number]) conversationHistory[number] = [];
  conversationHistory[number].push({ role, content });
  if (conversationHistory[number].length > MAX_HISTORY) {
    conversationHistory[number] = conversationHistory[number].slice(-MAX_HISTORY);
  }
}

function clearHistory(number) {
  delete conversationHistory[number];
}

// --- Human mode com persistência ---
function loadHumanMode() {
  try {
    if (fs.existsSync(HUMAN_MODE_FILE)) {
      const data = JSON.parse(fs.readFileSync(HUMAN_MODE_FILE, 'utf8'));
      const now = Date.now();
      for (const key of Object.keys(data)) {
        if (now - data[key] >= HUMAN_MODE_DURATION) delete data[key];
      }
      return data;
    }
  } catch (err) {
    console.error('Erro ao carregar human_mode.json:', err);
  }
  return {};
}

function saveHumanMode() {
  try {
    fs.writeFileSync(HUMAN_MODE_FILE, JSON.stringify(humanMode));
  } catch (err) {
    console.error('Erro ao salvar human_mode.json:', err);
  }
}

const humanMode = loadHumanMode();

function isHumanTrigger(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return ['humano', 'atendente', 'natan'].some(t => normalized.includes(t));
}

function isInHumanMode(number) {
  if (humanMode[number]) {
    if (Date.now() - humanMode[number] < HUMAN_MODE_DURATION) return true;
    delete humanMode[number];
    saveHumanMode();
  }
  return false;
}

function activateHumanMode(number) {
  humanMode[number] = Date.now();
  saveHumanMode();
  clearHistory(number);
}

// --- IA com histórico ---
async function getAIResponse(number, message) {
  addToHistory(number, 'user', message);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: conversationHistory[number]
  });

  const aiText = response.content[0].text;
  addToHistory(number, 'assistant', aiText);
  return aiText;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('QR recebido, salvando qrcode.png...');
      qrcode.toFile('qrcode.png', qr, err => {
        if (err) console.error('Erro ao salvar qrcode.png:', err);
        else console.log('📱 QR Code salvo em qrcode.png — abra o arquivo e escaneie com o WhatsApp.');
      });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('Conexão fechada. Código:', statusCode, '| Erro:', lastDisconnect?.error?.message);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('🔄 Reconectando em 3 segundos...');
        setTimeout(() => startBot(), 3000);
      } else {
        console.log('❌ Sessão encerrada. Escaneie o QR Code novamente.');
      }
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp conectado!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    if (!from.endsWith('@s.whatsapp.net')) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text) return;

    const pushName = msg.pushName || '';
    const firstName = pushName.split(' ')[0];
    const phoneNumber = from.replace('@s.whatsapp.net', '');

    try {
      if (isHumanTrigger(text)) {
        activateHumanMode(from);
        await sock.sendMessage(from, { text: 'Claro! Vou chamar o Natan pra te atender agora 😊 Um momento!' });
        await sock.sendMessage(NATAN_NUMBER, {
          text: `🔔 *Cliente solicitou atendimento humano!*\n\nCliente: ${pushName || phoneNumber}\nNúmero: ${phoneNumber}`
        });
        return;
      }

      if (isInHumanMode(from)) return;

      const messageWithName = firstName ? `[Cliente: ${firstName}]\n${text}` : text;
      const aiResponse = await getAIResponse(from, messageWithName);

      if (aiResponse.includes('[CHAMAR_NATAN]')) {
        const clean = aiResponse.replace('[CHAMAR_NATAN]', '').trim();
        if (clean) await sock.sendMessage(from, { text: clean });
        activateHumanMode(from);
        await sock.sendMessage(NATAN_NUMBER, {
          text: `🔔 *Atendimento necessário!*\n\nCliente: ${pushName || phoneNumber}\nNúmero: ${phoneNumber}\nÚltima mensagem: ${text}`
        });
      } else if (aiResponse.includes('[RESERVA:')) {
        const match = aiResponse.match(/\[RESERVA:([^|]+)\|([^|]+)\|([^\]]+)\]/);
        if (match) {
          const [, nome, horario, pessoas] = match;
          const clean = aiResponse.slice(0, aiResponse.indexOf('[RESERVA:')).trim();
          if (clean) await sock.sendMessage(from, { text: clean });
          await sock.sendMessage(NATAN_NUMBER, {
            text: `🍽️ *Nova reserva!*\n\nNome: ${nome.trim()}\nHorário: ${horario.trim()}\nPessoas: ${pessoas.trim()}\nContato: ${phoneNumber}`
          });
        }
      } else {
        await sock.sendMessage(from, { text: aiResponse });
      }
    } catch (err) {
      console.error(`Erro ao processar mensagem de ${phoneNumber}:`, err);
      await sock.sendMessage(from, {
        text: 'Desculpe, tive um problema técnico. Tente novamente em instantes!'
      }).catch(() => {});
    }
  });
}

startBot();
