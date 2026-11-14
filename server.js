'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const ROOMS = Object.freeze([
  { id: 'lobby', name: '大厅', description: '随便聊聊，认识一下', icon: '☕' },
  { id: 'tech', name: '技术角', description: '代码、产品与灵感', icon: '⌨️' },
  { id: 'offtopic', name: '摸鱼区', description: '认真生活，偶尔摸鱼', icon: '🐟' },
  { id: 'music', name: '音乐台', description: '分享正在循环的歌', icon: '🎧' }
]);

const ROOM_IDS = new Set(ROOMS.map((room) => room.id));
const NAME_LIMIT = 16;
const MESSAGE_LIMIT = 500;
const HISTORY_LIMIT = 100;
const MAX_BODY_BYTES = 16 * 1024;
const RATE_WINDOW_MS = 5_000;
const RATE_MAX_MESSAGES = 8;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const histories = new Map(ROOMS.map((room) => [room.id, []]));
const subscribers = new Map(ROOMS.map((room) => [room.id, new Set()]));
const rateBuckets = new Map();

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  setSecurityHeaders(res);
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function getRequestUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

function getRoomId(value) {
  return typeof value === 'string' && ROOM_IDS.has(value) ? value : null;
}

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(
    value
      .normalize('NFKC')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
    .slice(0, NAME_LIMIT)
    .join('');
}

function normalizeClientId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(value) ? value : '';
}

function cleanMessage(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!text) return null;
  if (Array.from(text).length > MESSAGE_LIMIT) return null;
  return text;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('请求内容过大');
        error.statusCode = 413;
        reject(error);
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        const error = new Error('请求格式不是有效的 JSON');
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

function getPresence(roomId) {
  const clients = subscribers.get(roomId);
  const uniqueUsers = new Map();
  for (const client of clients) {
    if (!uniqueUsers.has(client.clientId)) {
      uniqueUsers.set(client.clientId, client.name);
    }
  }
  return {
    online: uniqueUsers.size,
    names: Array.from(uniqueUsers.values()).slice(0, 12)
  };
}

function writeEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(roomId, event, data) {
  const clients = subscribers.get(roomId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (!client.res.writableEnded) {
      client.res.write(payload);
    }
  }
}

function broadcastPresence(roomId) {
  broadcast(roomId, 'presence', getPresence(roomId));
}

function handleEvents(req, res, url) {
  const roomId = getRoomId(url.searchParams.get('room'));
  if (!roomId) {
    sendError(res, 400, '频道不存在');
    return;
  }

  const name = normalizeName(url.searchParams.get('name')) || '游客';
  const clientId = normalizeClientId(url.searchParams.get('cid')) || crypto.randomUUID();

  setSecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  const client = {
    connectionId: crypto.randomUUID(),
    clientId,
    name,
    res
  };
  subscribers.get(roomId).add(client);

  writeEvent(res, 'ready', {
    room: roomId,
    ...getPresence(roomId)
  });
  broadcastPresence(roomId);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    subscribers.get(roomId)?.delete(client);
    broadcastPresence(roomId);
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function isRateLimited(clientId) {
  const now = Date.now();
  const recent = (rateBuckets.get(clientId) || []).filter(
    (timestamp) => now - timestamp < RATE_WINDOW_MS
  );

  if (recent.length >= RATE_MAX_MESSAGES) {
    rateBuckets.set(clientId, recent);
    return true;
  }

  recent.push(now);
  rateBuckets.set(clientId, recent);

  if (rateBuckets.size > 1_000) {
    for (const [key, timestamps] of rateBuckets) {
      if (timestamps.every((timestamp) => now - timestamp >= RATE_WINDOW_MS)) {
        rateBuckets.delete(key);
      }
    }
  }

  return false;
}

async function handlePostMessage(req, res) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    sendError(res, 415, '请使用 application/json 提交消息');
    return;
  }

  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (origin.host !== req.headers.host) {
        sendError(res, 403, '拒绝跨站提交消息');
        return;
      }
    } catch {
      sendError(res, 403, '请求来源无效');
      return;
    }
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendError(res, error.statusCode || 400, error.message || '无法读取请求内容');
    return;
  }

  const roomId = getRoomId(body.room);
  const name = normalizeName(body.name);
  const text = cleanMessage(body.text);
  const clientId = normalizeClientId(body.clientId);

  if (!roomId) {
    sendError(res, 400, '请选择有效的频道');
    return;
  }
  if (!name) {
    sendError(res, 400, '请先填写昵称');
    return;
  }
  if (!text) {
    sendError(res, 400, `消息不能为空，且不能超过 ${MESSAGE_LIMIT} 个字符`);
    return;
  }
  if (!clientId) {
    sendError(res, 400, '客户端标识无效，请刷新页面重试');
    return;
  }
  if (isRateLimited(clientId)) {
    sendError(res, 429, '发送得有点快，请稍等几秒再试');
    return;
  }

  const message = {
    id: crypto.randomUUID(),
    room: roomId,
    name,
    clientId,
    text,
    createdAt: new Date().toISOString()
  };

  const history = histories.get(roomId);
  history.push(message);
  if (history.length > HISTORY_LIMIT) {
    history.splice(0, history.length - HISTORY_LIMIT);
  }

  broadcast(roomId, 'message', message);
  sendJson(res, 201, { message });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, '不支持该请求方法');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendError(res, 400, '网址格式不正确');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\0')) {
    sendError(res, 400, '网址格式不正确');
    return;
  }

  const relativePath = pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendError(res, 403, '禁止访问');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendError(res, 404, '页面不存在');
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=300'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
  });
}

async function handleRequest(req, res) {
  let url;
  try {
    url = getRequestUrl(req);
  } catch {
    sendError(res, 400, '网址格式不正确');
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, {
      rooms: ROOMS,
      limits: {
        name: NAME_LIMIT,
        message: MESSAGE_LIMIT,
        history: HISTORY_LIMIT
      }
    });
    return;
  }

  if (url.pathname === '/api/history' && req.method === 'GET') {
    const roomId = getRoomId(url.searchParams.get('room'));
    if (!roomId) {
      sendError(res, 400, '频道不存在');
      return;
    }
    sendJson(res, 200, {
      room: roomId,
      messages: histories.get(roomId)
    });
    return;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    handleEvents(req, res, url);
    return;
  }

  if (url.pathname === '/api/messages' && req.method === 'POST') {
    await handlePostMessage(req, res);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendError(res, 404, '接口不存在');
    return;
  }

  serveStatic(req, res, url);
}

function createChatServer() {
  const server = http.createServer((req, res) => {
    Promise.resolve(handleRequest(req, res)).catch((error) => {
      console.error('Request failed:', error);
      if (!res.headersSent) {
        sendError(res, 500, '服务器开小差了，请稍后再试');
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const clients of subscribers.values()) {
      for (const client of clients) {
        if (!client.res.writableEnded) {
          client.res.write(`: heartbeat ${Date.now()}\n\n`);
        }
      }
    }
  }, 20_000);
  heartbeat.unref?.();

  server.on('close', () => {
    clearInterval(heartbeat);
  });

  return server;
}

if (require.main === module) {
  const server = createChatServer();
  server.listen(PORT, HOST, () => {
    console.log(`回声聊天室已启动：http://localhost:${PORT}`);
  });

  const shutdown = () => {
    for (const clients of subscribers.values()) {
      for (const client of clients) {
        client.res.end();
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  createChatServer,
  ROOMS,
  NAME_LIMIT,
  MESSAGE_LIMIT
};
