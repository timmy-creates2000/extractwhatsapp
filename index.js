// index.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const qrcode = require('qrcode');
const bodyParser = require('body-parser');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// last extraction (in-memory)
let lastExtraction = { groupId: null, groupName: null, participants: [] };

// Initialize WhatsApp client using LocalAuth for session persistence
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "local-client" }),
  puppeteer: {
    headless: true, // change to false to see the browser window (useful for debugging)
    args: ['--no-sandbox','--disable-setuid-sandbox']
  }
});

client.initialize();

client.on('qr', async (qr) => {
  try {
    const dataUrl = await qrcode.toDataURL(qr);
    io.emit('qr', dataUrl);
    console.log('QR emitted to frontend.');
  } catch (err) {
    console.error('QR -> DataURL error:', err);
  }
});

client.on('ready', () => {
  console.log('WhatsApp client ready.');
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('Authenticated & session saved.');
  io.emit('authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure:', msg);
  io.emit('auth_failure', msg);
});

client.on('disconnected', (reason) => {
  console.log('Client disconnected:', reason);
  io.emit('disconnected', reason);
});

// helper: extract phone number from an id like "234801234567@c.us"
function idToPhone(serializedId) {
  if (!serializedId) return '';
  const parts = serializedId.split('@');
  return parts[0] || '';
}

// Endpoint: accept invite and extract participants
// POST { link: "https://chat.whatsapp.com/INVITE_CODE" }
app.post('/api/extract-from-invite', async (req, res) => {
  const { link } = req.body;
  if (!link) return res.status(400).json({ error: 'invite link required' });

  // parse invite code
  const m = link.match(/(https?:\/\/)?chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  if (!m) return res.status(400).json({ error: 'invalid invite link format' });
  const inviteCode = m[2];

  try {
    let groupId = null;
    let inviteInfo = null;

    // try to get info about invite (may fail)
    try {
      inviteInfo = await client.getInviteInfo(inviteCode);
    } catch (e) {
      // ignore errors here - inviteInfo not critical
      console.warn('getInviteInfo failed:', e.message || e);
    }

    // Try acceptInvite (if not already part of group)
    try {
      groupId = await client.acceptInvite(inviteCode);
      console.log('Accepted invite, groupId:', groupId);
    } catch (errAccept) {
      console.warn('acceptInvite failed (maybe already a member):', errAccept.message || errAccept);
      // if inviteInfo provides id, use that
      if (inviteInfo && inviteInfo.id) {
        groupId = (inviteInfo.id._serialized || inviteInfo.id);
      } else {
        // fallback: search existing chats for group matching invite (best-effort)
        const chats = await client.getChats();
        const found = chats.find(c => c.isGroup && (c.name && c.name.includes(inviteCode)));
        if (found) groupId = found.id._serialized || found.id;
      }
    }

    if (!groupId) {
      return res.status(500).json({ error: 'Could not join or locate group' });
    }

    // get metadata & participants
    const metadata = await client.getGroupMetadata(groupId);
    const participantsRaw = metadata.participants || [];

    // map participants
    const participants = participantsRaw.map(p => {
      // p.id._serialized like "234801234567@c.us"
      const serialized = (p.id && (p.id._serialized || p.id)) || p;
      const phone = idToPhone(serialized._serialized || serialized);
      const name = p.formattedName || p.pushname || (p.id && p.id.user) || p.name || '';
      return { name: name || '', phone: phone || '' };
    });

    // dedupe by phone then name
    const map = new Map();
    participants.forEach(pt => {
      const key = (pt.phone && pt.phone.toString()) || ('name:' + (pt.name || '').toLowerCase());
      if (!map.has(key)) map.set(key, pt);
      else {
        // prefer entry that has phone
        const existing = map.get(key);
        if (!existing.phone && pt.phone) map.set(key, pt);
      }
    });
    const unique = Array.from(map.values());

    lastExtraction = {
      groupId,
      groupName: metadata.subject || metadata.name || 'Unnamed Group',
      participants: unique
    };

    return res.json({ ok: true, groupId, groupName: lastExtraction.groupName, count: unique.length, participants: unique });

  } catch (err) {
    console.error('Extraction error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// CSV download
app.get('/api/download/csv', (req, res) => {
  const participants = lastExtraction.participants || [];
  const rows = ['name,phone'];
  participants.forEach(p => {
    const safeName = (p.name || '').replace(/"/g, '""');
    rows.push(`"${safeName}","${p.phone || ''}"`);
  });
  const csv = rows.join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=whatsapp-group-contacts.csv');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send(csv);
});

// VCF download
app.get('/api/download/vcf', (req, res) => {
  const participants = lastExtraction.participants || [];
  const vcardLines = [];
  participants.forEach(p => {
    const safeName = (p.name || '').replace(/\n/g, ' ').trim() || 'Unknown';
    vcardLines.push('BEGIN:VCARD');
    vcardLines.push('VERSION:3.0');
    vcardLines.push(`FN:${safeName}`);
    if (p.phone) vcardLines.push(`TEL;TYPE=CELL:${p.phone}`);
    vcardLines.push('END:VCARD');
  });
  const vcf = vcardLines.join('\n');
  res.setHeader('Content-disposition', 'attachment; filename=whatsapp-group-contacts.vcf');
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.send(vcf);
});

// serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

io.on('connection', (socket) => {
  console.log('Frontend connected (socket).');
  // nothing extra for now
});