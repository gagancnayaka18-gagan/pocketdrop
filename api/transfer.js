import { randomInt, randomBytes, createHash } from 'node:crypto';
import { redis } from '../lib/store.js';
import { MAX_BYTES, CHUNK_BYTES, TTL, scripts } from '../lib/protocol.js';
export { MAX_BYTES, CHUNK_BYTES };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const dataKey = id => `pd:v2:data:${id}`;
const codeKey = code => `pd:v2:code:${code}`;
const field = (file, chunk) => `f:${file}:${chunk}`;
const limits = { init: 8, upload: 240, commit: 20, receive: 15, chunk: 240, delete: 20 };
export function validate(body) {
  const text = body?.text ?? '', files = body?.files ?? [];
  if (typeof text !== 'string' || text.length > 100000) throw fail('Text must be under 100,000 characters.');
  if (!Array.isArray(files) || files.length > 5) throw fail('Choose up to 5 files.');
  let total = Buffer.byteLength(text);
  const clean = files.map(file => {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 200 || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES) throw fail('Invalid file name or size.');
    total += file.size;
    return { name: file.name.replace(/[\x00-\x1f/\\]/g, '_'), size: file.size, chunks: Math.ceil(file.size / CHUNK_BYTES) };
  });
  if (total > MAX_BYTES) throw fail('Text and files must total 20 MB or less.', 413);
  if (!text.trim() && !clean.length) throw fail('Add some text or a file first.');
  return { text, files: clean };
}
function coordinates(meta, body) {
  const {fileIndex, chunkIndex} = body;
  if (!Number.isInteger(fileIndex) || !Number.isInteger(chunkIndex) || fileIndex < 0 || chunkIndex < 0 || !meta.files[fileIndex] || chunkIndex >= meta.files[fileIndex].chunks) throw fail('Invalid file chunk.');
  return Math.min(CHUNK_BYTES, meta.files[fileIndex].size - chunkIndex * CHUNK_BYTES);
}
function checkId(id) { if (typeof id !== 'string' || !/^[a-f0-9]{48}$/.test(id)) throw fail('Invalid transfer identifier.'); }
function checkToken(token) { if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) throw fail('Invalid sender token.',403); }
export function createHandler(db = redis, pickCode = () => String(randomInt(1000, 10000))) {
  const metadata = async id => { const raw = await db(['HGET', dataKey(id), 'meta']); if (!raw) throw fail('Transfer not found or expired.',404); return JSON.parse(raw); };
  return async (req, res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    try {
      if (req.method !== 'POST') { res.setHeader('Allow','POST'); throw fail('Method not allowed.',405); }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('JSON required.',415);
      if (req.headers.origin && ![`https://${req.headers.host}`,`http://${req.headers.host}`].includes(req.headers.origin)) throw fail('Origin not allowed.',403);
      if (Number(req.headers['content-length'] || 0) > 1600000) throw fail('Request too large. Refresh the page to use chunked uploads.',413);
      let body; try { body=typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw fail('Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Invalid request.');
      const action = body.action;
      if (action === 'create') throw fail('This page is outdated. Refresh it to use 20 MB transfers.',409);
      if (!Object.hasOwn(limits,action)) throw fail('Unknown action.');
      const ip=String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      const identity=createHash('sha256').update(ip).digest('hex').slice(0,24);
      const count=await db(['EVAL',scripts.rate,1,`pd:v2:rate:${action}:${identity}`]);
      if (count > limits[action]) { res.setHeader('Retry-After','60'); throw fail('Too many requests. Please wait one minute.',429); }
      if (action === 'init') {
        const meta=validate(body), id=randomBytes(24).toString('hex'), deleteToken=randomBytes(24).toString('hex');
        const result=await db(['EVAL',scripts.init,1,dataKey(id),JSON.stringify(meta),deleteToken,TTL]);
        if (!result) throw fail('Could not start transfer. Please try again.',503);
        return res.status(201).json({id,deleteToken,chunkBytes:CHUNK_BYTES});
      }
      if (action === 'receive') {
        if (typeof body.code !== 'string' || !/^[1-9]\d{3}$/.test(body.code)) throw fail('Enter a valid four-digit code.');
        const id=await db(['GET',codeKey(body.code)]);
        if (!id) throw fail('Code not found or expired. Check with the sender.',404);
        const meta=await metadata(id), expiresAt=Number(await db(['HGET',dataKey(id),'expiresAt']));
        if (expiresAt <= Date.now()) throw fail('This transfer has expired.',404);
        return res.status(200).json({...meta,id,expiresAt,chunkBytes:CHUNK_BYTES});
      }
      checkId(body.id); const key=dataKey(body.id);
      if (['upload','commit','delete'].includes(action)) checkToken(body.deleteToken);
      if (action === 'delete') {
        const code=await db(['HGET',key,'code']);
        const result=await db(['EVAL',scripts.delete,2,key,codeKey(code || 'pending'),body.deleteToken,body.id]);
        if (result === -2) throw fail('Only the sender can delete this transfer.',403);
        return res.status(200).json({deleted:true});
      }
      const meta=await metadata(body.id);
      if (action === 'upload') {
        const expected=coordinates(meta,body);
        if (typeof body.data !== 'string' || body.data.length !== 4*Math.ceil(expected/3)) throw fail('Chunk size does not match the declared file size.',413);
        const bytes=Buffer.from(body.data,'base64');
        if (bytes.length !== expected || bytes.toString('base64') !== body.data) throw fail('Invalid file chunk.');
        const result=await db(['EVAL',scripts.upload,1,key,body.deleteToken,field(body.fileIndex,body.chunkIndex),body.data]);
        if (result === -1) throw fail('Upload expired. Start again.',404);
        if (result === -2) throw fail('Invalid sender token.',403);
        if (result === -3) throw fail('Completed transfers cannot be changed.',409);
        return res.status(200).json({uploaded:true});
      }
      if (action === 'commit') {
        const fields=meta.files.flatMap((f,i)=>Array.from({length:f.chunks},(_,j)=>field(i,j)));
        for (let attempt=0;attempt<40;attempt++) {
          const candidate=pickCode();
          const result=String(await db(['EVAL',scripts.commit,2,key,codeKey(candidate),body.deleteToken,body.id,candidate,TTL,Date.now()+TTL*1000,...fields]));
          if (result === '-1') throw fail('Upload expired. Start again.',404);
          if (result === '-2') throw fail('Invalid sender token.',403);
          if (result === '-3') throw fail('Some file chunks are missing. Please send the transfer again.',409);
          if (result !== '0') {
            const expiresAt=Number(await db(['HGET',key,'expiresAt']));
            if (!expiresAt) throw fail('Transfer expired or was deleted.',404);
            return res.status(201).json({id:body.id,code:result,expiresAt,deleteToken:body.deleteToken});
          }
        }
        throw fail('Sharing codes are busy. Try again shortly.',503);
      }
      coordinates(meta,body);
      const expiresAt=Number(await db(['HGET',key,'expiresAt']));
      if (expiresAt <= Date.now()) throw fail('Transfer not ready, deleted, or expired.',404);
      const data=await db(['HGET',key,field(body.fileIndex,body.chunkIndex)]);
      if (data === null) throw fail('File is no longer available. Ask the sender to resend it.',404);
      return res.status(200).json({data});
    } catch(error) { return res.status(error.status || 503).json({error:error.status ? error.message : 'Transfer service unavailable. Please try again.'}); }
  };
}
export default createHandler();
