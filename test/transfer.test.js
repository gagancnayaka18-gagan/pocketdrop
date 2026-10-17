import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler, validate, MAX_BYTES, CHUNK_BYTES } from '../api/transfer.js';
import { scripts } from '../lib/protocol.js';
// Contract-level Redis stand-in: production Lua scripts require a deployment smoke test.
function setup(pickCode) {
  const hashes=new Map(),codes=new Map(),rates=new Map();
  let now=Date.now(), largestCommand=0;
  function expire() { for(const [k,v] of hashes)if(v.until<=now)hashes.delete(k);for(const [k,v] of codes)if(v.until<=now)codes.delete(k); }
  const db=async command => {
    largestCommand=Math.max(largestCommand,Buffer.byteLength(JSON.stringify(command)));expire();
    const [op,...rest]=command;
    if(op==='HGET')return hashes.get(rest[0])?.fields.get(rest[1])??null;
    if(op==='GET')return codes.get(rest[0])?.value??null;
    assert.equal(op,'EVAL');const [script,n,...params]=rest,keys=params.slice(0,n),a=params.slice(n),h=hashes.get(keys[0]);
    if(script===scripts.rate){const value=(rates.get(keys[0])||0)+1;rates.set(keys[0],value);return value;}
    if(script===scripts.init){if(h)return 0;hashes.set(keys[0],{until:now+Number(a[2])*1000,fields:new Map([['meta',a[0]],['token',a[1]]])});return 1;}
    if(script===scripts.upload){if(!h)return -1;if(h.fields.get('token')!==a[0])return -2;if(h.fields.has('code'))return -3;h.fields.set(a[1],a[2]);return 1;}
    if(script===scripts.commit){if(!h)return '-1';if(h.fields.get('token')!==a[0])return '-2';if(h.fields.has('code'))return h.fields.get('code');if(a.slice(5).some(f=>!h.fields.has(f)))return '-3';if(codes.has(keys[1]))return '0';codes.set(keys[1],{value:a[1],until:now+Number(a[3])*1000});h.fields.set('code',a[2]);h.fields.set('expiresAt',a[4]);h.until=now+Number(a[3])*1000;return a[2];}
    if(script===scripts.delete){if(!h)return 0;if(h.fields.get('token')!==a[0])return -2;if(codes.get(keys[1])?.value===a[1])codes.delete(keys[1]);hashes.delete(keys[0]);return 1;}
    throw Error('Unknown Redis command');
  };
  const handler=createHandler(db,pickCode);
  const call=async(body,options={})=>{const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.data=data;return this;}};await handler({method:options.method||'POST',headers:{'content-type':'application/json',host:'test',...options.headers},body},res);return res;};
  return {call,hashes,codes,advance(ms){now+=ms;},get largestCommand(){return largestCommand;}};
}
async function start(s,files=[],text='') {const r=await s.call({action:'init',text,files});assert.equal(r.code,201,JSON.stringify(r.data));return r.data;}
const auth=(u,action,extra={})=>({action,id:u.id,deleteToken:u.deleteToken,...extra});
test('20 MiB binary file uploads and downloads losslessly in bounded requests',async()=>{
 const s=setup(()=> '1234'); const original=Buffer.alloc(MAX_BYTES);for(let i=0;i<original.length;i++)original[i]=(i*17+13)%256;
 const u=await start(s,[{name:'20mb.bin',size:original.length}]);
 for(let i=0;i<20;i++){const data=original.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES).toString('base64');assert.equal((await s.call(auth(u,'upload',{fileIndex:0,chunkIndex:i,data}))).code,200);}
 const commit=await s.call(auth(u,'commit'));assert.equal(commit.code,201);
 const got=await s.call({action:'receive',code:'1234'});assert.equal(got.data.files[0].size,MAX_BYTES);assert.equal(got.data.deleteToken,undefined);assert.equal(got.data.files[0].data,undefined);
 const parts=[];for(let i=0;i<20;i++){const r=await s.call({action:'chunk',id:u.id,fileIndex:0,chunkIndex:i});assert.equal(r.code,200);assert.ok(Buffer.byteLength(JSON.stringify(r.data))<1600000);parts.push(Buffer.from(r.data.data,'base64'));}
 const hash=b=>createHash('sha256').update(b).digest('hex');assert.equal(hash(Buffer.concat(parts)),hash(original));assert.ok(s.largestCommand<1600000);
});
test('20 MiB boundary, combined sizes and invalid metadata',()=>{
 assert.equal(validate({files:[{name:'x',size:MAX_BYTES}]}).files[0].chunks,20);
 assert.throws(()=>validate({files:[{name:'x',size:MAX_BYTES+1}]}));
 assert.throws(()=>validate({text:'x',files:[{name:'x',size:MAX_BYTES}]}),e=>e.status===413);
 assert.throws(()=>validate({files:[{name:'a',size:MAX_BYTES/2},{name:'b',size:MAX_BYTES/2+1}]}),e=>e.status===413);
 for(const size of [-1,NaN,1.5,'2'])assert.throws(()=>validate({files:[{name:'x',size}]}));
 assert.throws(()=>validate({files:Array(6).fill({name:'x',size:0})}));assert.throws(()=>validate({}));
});
test('incomplete upload cannot get a code or be downloaded',async()=>{
 const s=setup(),u=await start(s,[{name:'x',size:CHUNK_BYTES+1}]);
 assert.equal((await s.call(auth(u,'commit'))).code,409);
 assert.equal((await s.call({action:'chunk',id:u.id,fileIndex:0,chunkIndex:0})).code,404);
 assert.equal(s.codes.size,0);
});
test('chunk size, base64 and indexes validated server-side',async()=>{
 const s=setup(),u=await start(s,[{name:'x',size:2}]);
 for(const data of ['AAAA','@@@@','AA=='])assert.ok((await s.call(auth(u,'upload',{fileIndex:0,chunkIndex:0,data}))).code>=400);
 for(const extra of [{fileIndex:-1,chunkIndex:0},{fileIndex:0,chunkIndex:1},{fileIndex:'0',chunkIndex:0}])assert.equal((await s.call(auth(u,'upload',{...extra,data:'AAA='}))).code,400);
 assert.equal((await s.call(auth(u,'upload',{fileIndex:0,chunkIndex:0,data:'AAA='}))).code,200);
});
test('sender token required for uploading, committing and deleting',async()=>{
 const s=setup(),u=await start(s,[{name:'x',size:1}]);
 for(const action of ['upload','commit','delete'])assert.equal((await s.call(auth(u,action,{deleteToken:'a'.repeat(48),fileIndex:0,chunkIndex:0,data:'AA=='}))).code,403);
});
test('retry upload and commit are idempotent; finalized content immutable',async()=>{
 const s=setup(()=> '1234'),u=await start(s,[{name:'x',size:1}]);
 for(let i=0;i<2;i++)assert.equal((await s.call(auth(u,'upload',{fileIndex:0,chunkIndex:0,data:'AA=='}))).code,200);
 const a=await s.call(auth(u,'commit')),b=await s.call(auth(u,'commit'));assert.deepEqual(a.data,b.data);assert.equal(s.codes.size,1);
 assert.equal((await s.call(auth(u,'upload',{fileIndex:0,chunkIndex:0,data:'AQ=='}))).code,409);
});
test('collision retries and concurrent commits preserve unique active codes',async()=>{
 let n=0;const s=setup(()=>String(n++<2?1234:5678));const a=await start(s,[],'one'),b=await start(s,[],'two');
 const results=await Promise.all([s.call(auth(a,'commit')),s.call(auth(b,'commit'))]);assert.equal(new Set(results.map(r=>r.data.code)).size,2);
 const content=await Promise.all(results.map(r=>s.call({action:'receive',code:r.data.code})));assert.deepEqual(content.map(r=>r.data.text).sort(),['one','two']);
});
test('sender deletion removes all chunks and code mapping',async()=>{
 const s=setup(()=> '1234'),u=await start(s,[{name:'x',size:1}]);await s.call(auth(u,'upload',{fileIndex:0,chunkIndex:0,data:'AA=='}));await s.call(auth(u,'commit'));
 assert.equal((await s.call(auth(u,'delete'))).code,200);assert.equal(s.hashes.size,0);assert.equal(s.codes.size,0);assert.equal((await s.call({action:'receive',code:'1234'})).code,404);
});
test('pending uploads and completed transfers expire with all chunks',async()=>{
 const s=setup(),u=await start(s,[{name:'x',size:1}]);await s.call(auth(u,'upload',{fileIndex:0,chunkIndex:0,data:'AA=='}));s.advance(601000);assert.equal((await s.call(auth(u,'commit'))).code,404);assert.equal(s.hashes.size,0);
 const t=setup(()=> '1234'),v=await start(t,[],'text');await t.call(auth(v,'commit'));t.advance(601000);assert.equal((await t.call({action:'receive',code:'1234'})).code,404);assert.equal(t.hashes.size,0);
});
test('text-only and zero-byte files supported',async()=>{
 const s=setup(()=> '1234'),u=await start(s,[{name:'empty.txt',size:0}],'hello <script>');assert.equal((await s.call(auth(u,'commit'))).code,201);const r=await s.call({action:'receive',code:'1234'});assert.equal(r.data.text,'hello <script>');assert.equal(r.data.files[0].chunks,0);
});
test('lookup rate limit separate from chunk traffic',async()=>{
 const s=setup();for(let i=0;i<15;i++)assert.equal((await s.call({action:'receive',code:'1234'})).code,404);const r=await s.call({action:'receive',code:'1234'});assert.equal(r.code,429);assert.equal(r.headers['Retry-After'],'60');
});
test('old frontend gets refresh message; bad methods, origins and oversized requests fail',async()=>{
 const s=setup();assert.equal((await s.call({action:'create'})).code,409);assert.equal((await s.call({}, {method:'GET'})).code,405);assert.equal((await s.call({}, {headers:{origin:'https://evil.example'}})).code,403);assert.equal((await s.call({}, {headers:{'content-length':'2000000'}})).code,413);
});
test('storage failures do not report success',async()=>{
 const handler=createHandler(async()=>{throw Error('offline');});const res={setHeader(){},status(n){this.code=n;return this;},json(d){this.data=d;}};await handler({method:'POST',headers:{'content-type':'application/json'},body:{action:'init',text:'x'}},res);assert.equal(res.code,503);
});
