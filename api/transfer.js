import { randomInt, randomBytes, createHash } from 'node:crypto';
import { redis } from '../lib/store.js';
export const MAX_BYTES = 2 * 1024 * 1024;
const TTL = 600;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function validate(body) {
  if (!body || typeof body !== 'object') throw fail('Invalid transfer.');
  const text = body.text ?? '';
  const files = body.files ?? [];
  if (typeof text !== 'string' || text.length > 100000) throw fail('Text must be under 100,000 characters.');
  if (!Array.isArray(files) || files.length > 5) throw fail('Choose up to 5 files.');
  let total = Buffer.byteLength(text);
  const clean = files.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 200 || typeof file.data !== 'string' || file.data.length > 2800000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw fail('Invalid file.');
    const size = Buffer.from(file.data, 'base64').length;
    total += size;
    return { name: file.name.replace(/[\x00-\x1f/\\]/g, '_'), data: file.data, size };
  });
  if (total > MAX_BYTES) throw fail('Text and files must total 2 MB or less.', 413);
  if (!text.trim() && !clean.length) throw fail('Add some text or a file first.');
  return { text, files: clean };
}
export function createHandler(db = redis, pickCode = () => String(randomInt(1000, 10000))) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fail('Method not allowed.', 405); }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('JSON required.', 415);
      if (req.headers.origin && req.headers.origin !== `https://${req.headers.host}` && req.headers.origin !== `http://${req.headers.host}`) throw fail('Origin not allowed.', 403);
      if (Number(req.headers['content-length'] || 0) > 3000000) throw fail('Transfer too large.', 413);
      let body;
      try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw fail('Invalid JSON.'); }
      const action = body?.action;
      if (!['create', 'receive', 'delete'].includes(action)) throw fail('Unknown action.');
      // Vercel overwrites x-forwarded-for with the trusted client IP.
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const identity = createHash('sha256').update(ip).digest('hex').slice(0, 24);
      const count = await db(['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, `pd:rate:${action}:${identity}`]);
      if (count > (action === 'create' ? 8 : 15)) { res.setHeader('Retry-After', '60'); throw fail('Too many requests. Please wait one minute.', 429); }
      if (action === 'create') {
        const payload = validate(body);
        const deleteToken = randomBytes(24).toString('hex');
        const expiresAt = Date.now() + TTL * 1000;
        const record = JSON.stringify({ ...payload, expiresAt, deleteToken });
        for (let attempt = 0; attempt < 40; attempt++) {
          const code = pickCode();
          if (await db(['SET', `pd:share:${code}`, record, 'EX', TTL, 'NX'])) return res.status(201).json({ code, expiresAt, deleteToken });
        }
        throw fail('All available codes are busy. Please try again shortly.', 503);
      }
      if (typeof body.code !== 'string' || !/^[1-9]\d{3}$/.test(body.code)) throw fail('Enter a valid four-digit code.');
      const key = `pd:share:${body.code}`;
      if (action === 'delete') {
        if (typeof body.deleteToken !== 'string' || !/^[a-f0-9]{48}$/.test(body.deleteToken)) throw fail('Invalid deletion token.', 403);
        const removed = await db(['EVAL', "local v=redis.call('GET',KEYS[1]); if not v then return 0 end; if cjson.decode(v).deleteToken~=ARGV[1] then return -1 end; return redis.call('DEL',KEYS[1])", 1, key, body.deleteToken]);
        if (removed === -1) throw fail('Only the sender can delete this transfer.', 403);
        return res.status(200).json({ deleted: true });
      }
      const raw = await db(['GET', key]);
      if (!raw) throw fail('Code not found or expired. Check with the sender.', 404);
      const record = JSON.parse(raw);
      if (record.expiresAt <= Date.now()) throw fail('This transfer has expired.', 404);
      const { deleteToken, ...payload } = record;
      return res.status(200).json(payload);
    } catch (error) {
      return res.status(error.status || 503).json({ error: error.status ? error.message : 'Transfer service unavailable. Please try again.' });
    }
  };
}
export default createHandler();
