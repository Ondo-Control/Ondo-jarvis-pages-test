'use strict';

const VERSION='1.0.0';
const REGION='eu-west-1';
const BUCKET='5bd2503a-290c-4e80-adc8-b639b915c673-eu-west-1';
const KEY='Private/jarvis-public-pilot-config.json';
const FILE_NAME='jarvis-public-pilot-config.json';
const CONSOLE_HOST=`${REGION}.console.aws.amazon.com`;
const OBJECT_URL=`https://${CONSOLE_HOST}/s3/object/${BUCKET}?region=${REGION}&prefix=${encodeURIComponent(KEY)}`;
const PRIVATE_URL=`https://${CONSOLE_HOST}/s3/buckets/${BUCKET}?region=${REGION}&prefix=Private%2F&tab=objects`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function safeError(e){return String(e?.message||e||'unknown_error').replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').slice(0,180);}
function allowedConsoleUrl(v){try{const u=new URL(v);return u.protocol==='https:'&&u.hostname===CONSOLE_HOST;}catch{return false;}}
async function waitTabComplete(tabId,timeoutMs=20000){const end=Date.now()+timeoutMs;while(Date.now()<end){const t=await chrome.tabs.get(tabId);if(t.status==='complete')return t;await sleep(200);}throw new Error('tab_load_timeout');}
async function navigate(tabId,url){await chrome.tabs.update(tabId,{url,active:true});return waitTabComplete(tabId);}
async function attach(tabId){try{await chrome.debugger.attach({tabId},'1.3');}catch(e){if(!String(e?.message||e).toLowerCase().includes('already attached'))throw e;}try{await chrome.debugger.sendCommand({tabId},'Runtime.enable');}catch{}}
async function detach(tabId){try{await chrome.debugger.detach({tabId});}catch{}}
async function evaluate(tabId,expression,{userGesture=false}={}){const out=await chrome.debugger.sendCommand({tabId},'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture});if(out?.exceptionDetails)throw new Error('runtime_evaluate_failed');return out?.result?.value;}

function clickButtonExpression(labels){return `(() => {
 const norm=s=>String(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
 const labels=${JSON.stringify(labels.map(x=>x.toLowerCase()))};
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 const buttons=[...document.querySelectorAll('button,[role="button"]')].filter(visible).filter(el=>!el.disabled);
 const hit=buttons.find(el=>labels.some(l=>norm(el.innerText||el.textContent)===l||norm(el.innerText||el.textContent).startsWith(l+' ')));
 if(!hit)return {ok:false};
 hit.scrollIntoView({block:'center',inline:'center'});hit.click();return {ok:true};
})()`;}
async function clickButton(tabId,labels){const r=await evaluate(tabId,clickButtonExpression(labels),{userGesture:true});if(!r?.ok)throw new Error('button_not_found:'+labels[0]);}

function isPresignedConfigTab(t){try{const u=new URL(t.url||'');const hostOk=u.hostname===`${BUCKET}.s3.${REGION}.amazonaws.com`||u.hostname===`${BUCKET}.s3.amazonaws.com`||(u.hostname===`s3.${REGION}.amazonaws.com`&&u.pathname.startsWith(`/${BUCKET}/`));const keyOk=decodeURIComponent(u.pathname).includes(KEY);return hostOk&&keyOk&&(u.searchParams.has('X-Amz-Signature')||u.searchParams.has('x-amz-signature'));}catch{return false;}}
async function waitForNewConfigTab(beforeIds,timeoutMs=12000){const end=Date.now()+timeoutMs;while(Date.now()<end){const tabs=await chrome.tabs.query({});const hit=tabs.find(t=>!beforeIds.has(t.id)&&isPresignedConfigTab(t));if(hit){await waitTabComplete(hit.id,10000);return hit;}await sleep(200);}throw new Error('presigned_config_tab_not_found');}

async function readConfigViaConsole(sourceTabId){
 await detach(sourceTabId);await navigate(sourceTabId,OBJECT_URL);await attach(sourceTabId);
 const before=new Set((await chrome.tabs.query({})).map(t=>t.id));
 await clickButton(sourceTabId,['Öffnen','Open']);
 const dataTab=await waitForNewConfigTab(before);
 try{
  await attach(dataTab.id);
  const raw=await evaluate(dataTab.id,`(() => {const pre=document.querySelector('pre');return String(pre?pre.innerText:document.body?.innerText||'').trim();})()`);
  if(typeof raw!=='string'||raw.length<20||raw.length>4096)throw new Error('invalid_config_size');
  let parsed;try{parsed=JSON.parse(raw);}catch{throw new Error('invalid_config_json');}
  if(!parsed||parsed.version!==1)throw new Error('invalid_config_version');
  if(typeof parsed.worker_url!=='string'||typeof parsed.bridge_token!=='string'||typeof parsed.skill_id!=='string')throw new Error('invalid_config_contract');
  return parsed;
 }finally{await detach(dataTab.id);try{await chrome.tabs.remove(dataTab.id);}catch{}}
}

async function waitForFileInput(tabId,timeoutMs=10000){const end=Date.now()+timeoutMs;while(Date.now()<end){const n=await evaluate(tabId,`document.querySelectorAll('input[type="file"]').length`);if(Number(n)>0)return;await sleep(200);}throw new Error('file_input_not_found');}
async function setFile(tabId,text){
 const payload=JSON.stringify(text),name=JSON.stringify(FILE_NAME);
 const ok=await evaluate(tabId,`(() => {const input=document.querySelector('input[type="file"]');if(!input)return false;const file=new File([${payload}],${name},{type:'application/json'});const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return input.files&&input.files.length===1&&input.files[0].name===${name};})()`);
 if(ok!==true)throw new Error('file_injection_failed');
}
async function uploadConfig(sourceTabId,config){
 await detach(sourceTabId);await navigate(sourceTabId,PRIVATE_URL);await attach(sourceTabId);
 await clickButton(sourceTabId,['Hochladen','Upload']);await sleep(500);await waitForFileInput(sourceTabId);
 await setFile(sourceTabId,JSON.stringify(config,null,2)+'\n');await sleep(500);
 const clicked=await evaluate(sourceTabId,`(() => {const norm=s=>String(s||'').replace(/\\s+/g,' ').trim().toLowerCase();const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};const labels=['hochladen','upload'];const all=[...document.querySelectorAll('button,[role="button"]')].filter(visible).filter(el=>!el.disabled).filter(el=>labels.includes(norm(el.innerText||el.textContent)));if(!all.length)return {ok:false};const hit=all[all.length-1];hit.scrollIntoView({block:'center'});hit.click();return {ok:true};})()`,{userGesture:true});
 if(!clicked?.ok)throw new Error('upload_submit_not_found');
 const end=Date.now()+20000;
 while(Date.now()<end){const s=await evaluate(sourceTabId,`(() => {const t=String(document.body?.innerText||'').toLowerCase();return {success:t.includes('upload erfolgreich')||t.includes('upload succeeded')||t.includes('upload complete'),failed:t.includes('upload fehlgeschlagen')||t.includes('upload failed')};})()`);if(s?.failed)throw new Error('upload_failed');if(s?.success)return;await sleep(300);}
 throw new Error('upload_confirmation_timeout');
}
async function setProbe(sourceTabId,enabled){
 const source=await chrome.tabs.get(sourceTabId);if(!allowedConsoleUrl(source.url))throw new Error('source_not_aws_console');
 const config=await readConfigViaConsole(sourceTabId);config.onedrive_probe_enabled=Boolean(enabled);
 await uploadConfig(sourceTabId,config);
 const verify=await readConfigViaConsole(sourceTabId);
 if(verify.onedrive_probe_enabled!==Boolean(enabled))throw new Error('post_upload_verification_failed');
 await detach(sourceTabId);return {ok:true,enabled:Boolean(enabled),version:VERSION};
}

chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
 if(!message||message.schema!=='ondo.jarvis.aws.command.v1'||message.op!=='set_probe')return false;
 const sourceTabId=sender?.tab?.id;
 if(!Number.isInteger(sourceTabId)){sendResponse({ok:false,stage:'source_tab_missing'});return false;}
 (async()=>{try{sendResponse(await setProbe(sourceTabId,message.enabled===true));}catch(e){try{await detach(sourceTabId);}catch{}sendResponse({ok:false,stage:safeError(e),version:VERSION});}})();
 return true;
});
