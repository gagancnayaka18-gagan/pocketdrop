import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, validate, MAX_BYTES } from '../api/transfer.js';
function setup(pick) {
  const records=new Map(); let requests=0;
  const db=async c => {
    if(c[0]==='SET'){if(records.has(c[1]))return null;records.set(c[1],c[2]);return 'OK';}
    if(c[0]==='GET')return records.get(c[1])||null;
    if(c[1].includes('INCR'))return ++requests;
    const record=records.get(c[3]);if(!record)return 0;
    if(JSON.parse(record).deleteToken!==c[4])return -1;
    records.delete(c[3]);return 1;
  };
  const handler=createHandler(db,pick);
  const call=async body => { const res={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.data=data;return this;}}; await handler({method:'POST',headers:{'content-type':'application/json',host:'test'},body},res);return res; };
  return {call,records};
}
test('text and binary file round trip, token stays private, sender deletion',async()=>{
 const {call}=setup(()=> '1234'); const data=Buffer.from([0,255,10,99]).toString('base64');
 const made=await call({action:'create',text:'hello <script>',files:[{name:'a.bin',data}]});assert.equal(made.code,201);
 const got=await call({action:'receive',code:'1234'});assert.equal(got.data.text,'hello <script>');assert.equal(got.data.files[0].data,data);assert.equal(got.data.deleteToken,undefined);
 assert.equal((await call({action:'delete',code:'1234',deleteToken:'a'.repeat(48)})).code,403);
 assert.equal((await call({action:'delete',code:'1234',deleteToken:made.data.deleteToken})).code,200);
 assert.equal((await call({action:'receive',code:'1234'})).code,404);
});
test('active code collisions never overwrite previous transfer',async()=>{let n=0;const {call}=setup(()=>++n<3?'1234':'5678');await call({action:'create',text:'first'});const second=await call({action:'create',text:'second'});assert.equal(second.data.code,'5678');assert.equal((await call({action:'receive',code:'1234'})).data.text,'first');});
test('expiry enforced even if storage returns expired data',async()=>{const {call,records}=setup();records.set('pd:share:1234',JSON.stringify({expiresAt:Date.now()-1}));assert.equal((await call({action:'receive',code:'1234'})).code,404);});
test('empty, malformed, too many files, and oversized data rejected',()=>{
 assert.throws(()=>validate({text:''}));assert.throws(()=>validate({files:[{name:'x',data:'@@'}]}));assert.throws(()=>validate({files:Array(6).fill({name:'x',data:''})}));
 assert.throws(()=>validate({text:'a',files:[{name:'x',data:Buffer.alloc(MAX_BYTES).toString('base64')}]}),e=>e.status===413);
 assert.equal(validate({files:[{name:'x',data:Buffer.alloc(MAX_BYTES).toString('base64')}]}).files[0].size,MAX_BYTES);
});
test('rate limit and input validation',async()=>{const {call}=setup();for(let i=0;i<15;i++)assert.equal((await call({action:'receive',code:'1234'})).code,404);assert.equal((await call({action:'receive',code:'1234'})).code,429);const b=setup();assert.equal((await b.call({action:'receive',code:'abcd'})).code,400);});
test('missing storage fails clearly without fake successful transfer',async()=>{const handler=createHandler(async()=>{throw new Error('offline');});const res={setHeader(){},status(n){this.code=n;return this;},json(d){this.data=d;}};await handler({method:'POST',headers:{'content-type':'application/json'},body:{action:'create',text:'hi'}},res);assert.equal(res.code,503);});
