const $ = id => document.getElementById(id);
let files = [], active = null, timer, downloadUrls = [], sending = false;
const MAX_BYTES = 20 * 1024 * 1024;
function status(message = '', error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); $('status').hidden = !message; }
function tab(mode) {
  const send = mode === 'send';
  $('sendPanel').hidden = !send; $('receivePanel').hidden = send;
  for (const [id, selected] of [['sendTab', send], ['receiveTab', !send]]) { $(id).setAttribute('aria-selected', String(selected)); $(id).tabIndex = selected ? 0 : -1; }
  status();
}
$('sendTab').onclick = () => tab('send'); $('receiveTab').onclick = () => { tab('receive'); $('code').focus(); };
for (const id of ['sendTab','receiveTab']) $(id).onkeydown = e => { if (['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'send' : e.key === 'End' ? 'receive' : id === 'sendTab' ? 'receive' : 'send'; tab(next); $(next + 'Tab').focus(); } };
$('text').oninput = () => $('count').textContent = `${$('text').value.length.toLocaleString()} / 100,000`;
function renderFiles() {
  $('fileList').replaceChildren();
  files.forEach((file, i) => { const li = document.createElement('li'), label = document.createElement('span'), remove = document.createElement('button'); label.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`; remove.textContent = '×'; remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.onclick = () => { if (sending) return; files.splice(i,1); renderFiles(); }; li.append(label,remove); $('fileList').append(li); });
}
function addFiles(selected) {
  if (sending) return;
  const next = [...files,...selected];
  if (next.length > 5) return status('Choose up to 5 files.',true);
  if (next.reduce((sum,f) => sum+f.size,0) + new TextEncoder().encode($('text').value).length > MAX_BYTES) return status('Text and files must total 20 MB or less.',true);
  files = next; renderFiles(); status();
}
$('files').onchange = e => { addFiles(Array.from(e.target.files)); e.target.value = ''; };
for (const type of ['dragenter','dragover']) $('dropzone').addEventListener(type,e => { e.preventDefault(); $('dropzone').classList.add('drag'); });
for (const type of ['dragleave','drop']) $('dropzone').addEventListener(type,e => { e.preventDefault(); $('dropzone').classList.remove('drag'); });
$('dropzone').addEventListener('drop',e => addFiles(Array.from(e.dataTransfer.files)));
function encode(file) { return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve({name:file.name,data:reader.result.split(',')[1]}); reader.onerror = () => reject(new Error('Could not read this file. Try choosing it again.')); reader.readAsDataURL(file); }); }
async function api(body) {
  const response = await fetch('/api/transfer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const data = await response.json().catch(() => ({error:'The service could not complete the request.'}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Please try again.'), {status:response.status});
  return data;
}
async function busy(id, task) { $(id).disabled = true; const old = $(id).textContent; $(id).textContent = 'One moment…'; status(); try { await task(); } catch(e) { status(e.name === 'TimeoutError' ? 'The request timed out. Please try again.' : e.message, true); } finally { $(id).disabled = false; $(id).textContent = old; } }
function tick() {
  if (!active) return;
  const seconds = Math.max(0,Math.ceil((active.expiresAt-Date.now())/1000));
  $('countdown').textContent = `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  if (!seconds) { clearInterval(timer); $('copyCode').disabled = true; $('copyLink').disabled = true; status('This code has expired. Create a new transfer.'); }
}
async function retry(body) {
  try { return await api(body); } catch (error) {
    if (error.status && error.status < 500) throw error;
    return api(body); // Upload, commit and chunk reads are safe to repeat.
  }
}
function progress(done,total) {
  $('transferProgress').hidden=false;
  $('progressBar').value=total ? Math.round(done/total*100) : 100;
  $('progressLabel').textContent=`Uploading… ${$('progressBar').value}%`;
}
$('sendForm').onsubmit = e => { e.preventDefault(); if (sending) return; busy('sendButton',async () => {
  const selected=[...files], text=$('text').value;
  if (!text.trim() && !selected.length) throw new Error('Add some text or a file first.');
  const total=selected.reduce((sum,f)=>sum+f.size,0);
  if (total+new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('Text and files must total 20 MB or less.');
  sending=true; $('text').disabled=true; $('files').disabled=true;
  let upload;
  try {
    upload=await api({action:'init',text,files:selected.map(f=>({name:f.name,size:f.size}))});
    let sent=0; progress(0,total);
    for (let fileIndex=0;fileIndex<selected.length;fileIndex++) {
      const file=selected[fileIndex];
      for (let offset=0,chunkIndex=0;offset<file.size;offset+=upload.chunkBytes,chunkIndex++) {
        const part=file.slice(offset,offset+upload.chunkBytes);
        const {data}=await encode(part);
        await retry({action:'upload',id:upload.id,deleteToken:upload.deleteToken,fileIndex,chunkIndex,data});
        sent+=part.size; progress(sent,total);
      }
    }
    $('progressLabel').textContent='Finishing transfer…';
    active=await retry({action:'commit',id:upload.id,deleteToken:upload.deleteToken});
    $('shareCode').textContent=active.code; $('sendForm').hidden=true; $('sendResult').hidden=false;
    $('copyCode').disabled=false; $('copyLink').disabled=false; clearInterval(timer); tick(); timer=setInterval(tick,1000);
  } catch(error) {
    if(upload) await api({action:'delete',id:upload.id,deleteToken:upload.deleteToken}).catch(()=>{});
    throw error;
  } finally { sending=false; $('text').disabled=false; $('files').disabled=false; $('transferProgress').hidden=true; }
}); };
async function copy(text) { try { await navigator.clipboard.writeText(text); status('Copied to clipboard.'); } catch { status('Clipboard access is unavailable. Select and copy the text manually.',true); } }
$('copyCode').onclick = () => copy(active.code);
$('copyLink').onclick = () => copy(`${location.origin}/#${active.code}`);
function resetSend() { clearInterval(timer); active = null; $('sendResult').hidden = true; $('sendForm').hidden = false; $('text').value = ''; $('text').oninput(); files = []; renderFiles(); status(); }
$('newShare').onclick = () => { resetSend(); $('text').focus(); };
$('deleteShare').onclick = () => busy('deleteShare',async () => { await api({action:'delete',id:active.id,deleteToken:active.deleteToken}); resetSend(); status('Transfer deleted.'); });
$('code').oninput = e => e.target.value = e.target.value.replace(/\D/g,'').slice(0,4);
function clearReceived() { for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls=[]; $('downloads').replaceChildren(); $('receivedText').value=''; }
$('receiveForm').onsubmit = e => { e.preventDefault(); busy('receiveButton',async () => {
  const result = await api({action:'receive',code:$('code').value}); clearReceived();
  $('receivedText').value = result.text; $('copyText').hidden = !result.text;
  result.files.forEach((file,fileIndex) => {
    const row=document.createElement('div'), name=document.createElement('span'), button=document.createElement('button');
    row.className='download-row'; name.textContent=`${file.name} · ${(file.size/1024/1024).toFixed(2)} MB`;
    button.type='button'; button.className='secondary'; button.textContent='Download ↓';
    button.onclick=async () => {
      // Keep the current view stable until this file has been assembled.
      $('receiveAgain').disabled=true; for (const b of $('downloads').querySelectorAll('button')) b.disabled=true; status();
      const parts=[];
      try {
        for(let chunkIndex=0;chunkIndex<file.chunks;chunkIndex++) {
          button.textContent=`${Math.round(chunkIndex/file.chunks*100)}%`;
          const {data}=await retry({action:'chunk',id:result.id,fileIndex,chunkIndex});
          parts.push(Uint8Array.from(atob(data),c=>c.charCodeAt(0)));
        }
        const blob=new Blob(parts,{type:'application/octet-stream'});
        if(blob.size!==file.size) throw new Error('File incomplete. Please retry the download.');
        const url=URL.createObjectURL(blob); downloadUrls.push(url);
        const link=document.createElement('a'); link.href=url; link.download=file.name; link.textContent='Save file ↓';
        row.replaceChild(link,button); link.click(); status('File ready. If the download did not start, tap Save file.');
      } catch(error) { button.disabled=false; button.textContent='Retry download'; status(error.message,true); }
      finally { $('receiveAgain').disabled=false; for (const b of $('downloads').querySelectorAll('button')) b.disabled=false; }
    };
    row.append(name,button); $('downloads').append(row);
  });
  $('receiveForm').hidden=true; $('received').hidden=false;
}); };
$('copyText').onclick = () => copy($('receivedText').value);
$('receiveAgain').onclick = () => { clearReceived(); $('received').hidden=true; $('receiveForm').hidden=false; $('code').value=''; $('code').focus(); status(); history.replaceState(null,'',location.pathname); };
if (/^#[1-9]\d{3}$/.test(location.hash)) { tab('receive'); $('code').value=location.hash.slice(1); }
