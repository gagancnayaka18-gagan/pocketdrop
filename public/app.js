const $ = id => document.getElementById(id);
let files = [], active = null, timer, downloadUrls = [];
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
  files.forEach((file, i) => { const li = document.createElement('li'), label = document.createElement('span'), remove = document.createElement('button'); label.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`; remove.textContent = '×'; remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.onclick = () => { files.splice(i,1); renderFiles(); }; li.append(label,remove); $('fileList').append(li); });
}
function addFiles(selected) {
  const next = [...files,...selected];
  if (next.length > 5) return status('Choose up to 5 files.',true);
  if (next.reduce((sum,f) => sum+f.size,0) + new TextEncoder().encode($('text').value).length > 2*1024*1024) return status('Text and files must total 2 MB or less.',true);
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
  if (!response.ok) throw new Error(data.error || 'Please try again.');
  return data;
}
async function busy(id, task) { $(id).disabled = true; const old = $(id).textContent; $(id).textContent = 'One moment…'; status(); try { await task(); } catch(e) { status(e.name === 'TimeoutError' ? 'The request timed out. Please try again.' : e.message, true); } finally { $(id).disabled = false; $(id).textContent = old; } }
function tick() {
  if (!active) return;
  const seconds = Math.max(0,Math.ceil((active.expiresAt-Date.now())/1000));
  $('countdown').textContent = `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  if (!seconds) { clearInterval(timer); $('copyCode').disabled = true; $('copyLink').disabled = true; status('This code has expired. Create a new transfer.'); }
}
$('sendForm').onsubmit = e => { e.preventDefault(); busy('sendButton',async () => {
  if (!$('text').value.trim() && !files.length) throw new Error('Add some text or a file first.');
  if (files.reduce((sum,f)=>sum+f.size,0)+new TextEncoder().encode($('text').value).length > 2*1024*1024) throw new Error('Text and files must total 2 MB or less.');
  active = await api({action:'create',text:$('text').value,files:await Promise.all(files.map(encode))});
  $('shareCode').textContent = active.code; $('sendForm').hidden = true; $('sendResult').hidden = false;
  $('copyCode').disabled = false; $('copyLink').disabled = false; clearInterval(timer); tick(); timer = setInterval(tick,1000);
}); };
async function copy(text) { try { await navigator.clipboard.writeText(text); status('Copied to clipboard.'); } catch { status('Clipboard access is unavailable. Select and copy the text manually.',true); } }
$('copyCode').onclick = () => copy(active.code);
$('copyLink').onclick = () => copy(`${location.origin}/#${active.code}`);
function resetSend() { clearInterval(timer); active = null; $('sendResult').hidden = true; $('sendForm').hidden = false; $('text').value = ''; $('text').oninput(); files = []; renderFiles(); status(); }
$('newShare').onclick = () => { resetSend(); $('text').focus(); };
$('deleteShare').onclick = () => busy('deleteShare',async () => { await api({action:'delete',code:active.code,deleteToken:active.deleteToken}); resetSend(); status('Transfer deleted.'); });
$('code').oninput = e => e.target.value = e.target.value.replace(/\D/g,'').slice(0,4);
function clearReceived() { for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls=[]; $('downloads').replaceChildren(); $('receivedText').value=''; }
$('receiveForm').onsubmit = e => { e.preventDefault(); busy('receiveButton',async () => {
  const result = await api({action:'receive',code:$('code').value}); clearReceived();
  $('receivedText').value = result.text; $('copyText').hidden = !result.text;
  for (const file of result.files) {
    const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})); downloadUrls.push(url);
    const link = document.createElement('a'), name = document.createElement('span'), size = document.createElement('small');
    link.href=url; link.download=file.name; name.textContent=file.name; size.textContent=`${(file.size/1024).toFixed(1)} KB ↓`; link.append(name,size); $('downloads').append(link);
  }
  $('receiveForm').hidden=true; $('received').hidden=false;
}); };
$('copyText').onclick = () => copy($('receivedText').value);
$('receiveAgain').onclick = () => { clearReceived(); $('received').hidden=true; $('receiveForm').hidden=false; $('code').value=''; $('code').focus(); status(); history.replaceState(null,'',location.pathname); };
if (/^#[1-9]\d{3}$/.test(location.hash)) { tab('receive'); $('code').value=location.hash.slice(1); }
