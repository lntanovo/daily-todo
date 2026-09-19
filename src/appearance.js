import { backgroundCatalog } from './background-catalog.js';
import { prepareBackground } from './background-image.js';

const paper=()=>({background_kind:'paper',background_value:''});
export function setupAppearance({app,db,button,getUid,isBusy,setBusy,notify}) {
  const image=document.createElement('img');
  image.className='page-background'; image.alt=''; image.hidden=true;
  document.body.prepend(image);
  const dialog=document.createElement('dialog'); dialog.id='backgroundDialog';
  dialog.setAttribute('aria-labelledby','backgroundTitle');
  dialog.innerHTML=`<div class="dialog-inner">
    <div class="feature-heading"><h2 id="backgroundTitle">我的背景 <small>BACKGROUND</small></h2><button type="button" class="icon-button" data-cancel aria-label="关闭背景设置">×</button></div>
    <div class="background-options"><button type="button" class="background-option" data-paper>原色暖纸</button></div>
    <p class="form-hint" data-gallery-empty>精选背景暂未添加，你可以先上传自己喜欢的图片。</p>
    <div class="field"><label for="backgroundFile">上传自己的图片</label><input id="backgroundFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></div>
    <p class="form-hint">静态原图最大 30MB，会自动压缩；GIF、动态 WebP 最大 10MB，保留动画。</p>
    <p class="form-hint" data-file-info></p><p class="form-error" id="backgroundError" role="alert"></p>
    <div class="form-actions"><button class="button" type="button" data-cancel>取消</button><button class="button primary" type="button" data-save>保存背景</button></div>
  </div>`;
  document.body.append(dialog);
  const error=dialog.querySelector('#backgroundError');
  const fileInput=dialog.querySelector('input');
  let saved=paper(), savedUrl='', draft=paper(), prepared=null, objectUrl='', version=0, preparing=false, saving=false, ready=false, refreshTimer;
  let draftRequest=0;
  const storage=()=>app.storage.from('todo-backgrounds');
  async function result(request) {const {data,error}=await request; if(error) throw error; return data;}
  function display(url='') {if(url)image.src=url;else image.removeAttribute('src');image.hidden=!url;document.body.classList.toggle('has-background',Boolean(url));}
  image.addEventListener('error',()=> {
    image.hidden=true;document.body.classList.remove('has-background');
    if(getUid()) notify('背景暂时无法显示，可以在“背景”中重新选择。','error');
  });
  function clearDraft() {draftRequest++;preparing=false;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl='';prepared=null;fileInput.value='';dialog.querySelector('[data-file-info]').textContent='';}
  async function resolveUrl(pref) {
    if(pref.background_kind==='paper')return '';
    if(pref.background_kind==='preset')return backgroundCatalog.find(x=>x.id===pref.background_value)?.url||'';
    const data=await result(storage().createSignedUrl(pref.background_value,3600));
    if(!data?.fullSignedURL)throw new Error('无法获取背景图片。');
    return data.fullSignedURL;
  }
  function markSelected() {
    dialog.querySelectorAll('[data-paper], [data-preset]').forEach(control=>control.setAttribute('aria-pressed',String(control.hasAttribute('data-paper')?draft.background_kind==='paper':draft.background_kind==='preset'&&draft.background_value===control.dataset.preset)));
  }
  async function refreshSignedUrl(epoch=version) {
    clearTimeout(refreshTimer);
    if(!getUid()||saved.background_kind!=='upload')return;
    try {const url=await resolveUrl(saved);if(epoch!==version)return;savedUrl=url;if(!dialog.open)display(url);}
    catch {if(epoch===version)notify('背景链接刷新失败，稍后会重试。','error');}
    if(epoch===version)refreshTimer=setTimeout(()=>void refreshSignedUrl(epoch),45*60*1000);
  }
  async function load() {
    const epoch=++version;ready=false;clearTimeout(refreshTimer);saved=paper();savedUrl='';display();
    try {
      const rows=await result(db.from('todo_preferences').select('background_kind,background_value'));
      if(epoch!==version)return;
      saved=rows?.[0]||paper();ready=true;
      const url=await resolveUrl(saved);
      if(epoch!==version)return;
      savedUrl=url;
      display(savedUrl);
      if(saved.background_kind==='upload')refreshTimer=setTimeout(()=>void refreshSignedUrl(epoch),45*60*1000);
    } catch {if(epoch===version)notify('个人背景暂时无法读取，可以稍后打开“背景”重试。','error');}
  }
  document.addEventListener('visibilitychange',()=> {if(!document.hidden && !dialog.open)void refreshSignedUrl();});
  dialog.querySelector('[data-paper]').addEventListener('click',()=> {if(saving||preparing)return;clearDraft();draft=paper();display();markSelected();error.textContent='';});
  dialog.querySelector('[data-gallery-empty]').hidden=backgroundCatalog.length>0;
  for(const entry of backgroundCatalog) {
    const choice=document.createElement('button'); choice.type='button';choice.className='background-option';choice.dataset.preset=entry.id;
    const preview=document.createElement('img');preview.src=entry.url;preview.alt='';preview.loading='lazy';
    const name=document.createElement('span');name.textContent=entry.name;choice.append(preview,name);
    choice.addEventListener('click',()=> {if(saving||preparing)return;clearDraft();draft={background_kind:'preset',background_value:entry.id};display(entry.url);markSelected();error.textContent='';});
    dialog.querySelector('.background-options').append(choice);
  }
  fileInput.addEventListener('change',async()=> {
    const file=fileInput.files?.[0]; if(!file)return;
    const request=++draftRequest;preparing=true;error.textContent='正在处理图片…';dialog.querySelector('[data-save]').disabled=true;
    try {
      const next=await prepareBackground(file);
      if(request!==draftRequest||!dialog.open)return;
      if(objectUrl)URL.revokeObjectURL(objectUrl);
      prepared=next;objectUrl=URL.createObjectURL(next.blob);draft={background_kind:'upload',background_value:''};
      display(objectUrl);markSelected();error.textContent='';
      dialog.querySelector('[data-file-info]').textContent=`${file.name} · ${(file.size/1048576).toFixed(1)}MB → ${(next.blob.size/1048576).toFixed(1)}MB${next.animated?' · 动画已保留':''}`;
    } catch(failure) {if(request===draftRequest)error.textContent=failure.message;}
    finally {if(request===draftRequest){preparing=false;dialog.querySelector('[data-save]').disabled=!ready;}}
  });
  async function cleanup(key) {
    const rows=await result(storage().remove([key]));
    if(Array.isArray(rows)&&rows.some(row=>row.error))throw new Error('旧背景清理失败。');
  }
  dialog.querySelector('[data-save]').addEventListener('click',async()=> {
    if(saving||preparing||isBusy()||!ready||!getUid())return;
    const uid=getUid(),epoch=version, previous=saved;
    let uploaded='',committed=false;
    saving=true;setBusy(true);error.textContent='正在保存…';
    dialog.querySelectorAll('button,input').forEach(control=>control.disabled=true);
    try {
      const next={...draft};
      let url=savedUrl;
      if(prepared) {
        const key=`${uid}/${crypto.randomUUID()}.${prepared.extension}`;
        await result(storage().upload(key,prepared.blob,{contentType:prepared.blob.type,upsert:false}));
        uploaded=key;next.background_value=key;
      }
      url=await resolveUrl(next);
      if(epoch!==version||uid!==getUid())throw new Error('登录状态改变，请重新设置。');
      await result(db.from('todo_preferences').upsert({...next,updated_at:new Date().toISOString()},{onConflict:'owner_id'}));
      if(epoch!==version||uid!==getUid())return;
      committed=true;saved=next;savedUrl=url;display(url);dialog.close();
      if(saved.background_kind==='upload')refreshTimer=setTimeout(()=>void refreshSignedUrl(epoch),45*60*1000);
      if(previous.background_kind==='upload'&&previous.background_value!==next.background_value) {
        try {await cleanup(previous.background_value);}
        catch {notify('新背景已保存；旧图片清理失败，可稍后联系管理员清理。','error');}
      }
    } catch(failure) {
      error.textContent=`保存失败：${failure.message||'请重试，当前预览仍保留。'}`;
      // A lost response can still mean the preference committed. Re-read before deleting.
      if(uploaded&&!committed) {
        try {
          const rows=await result(db.from('todo_preferences').select('background_value'));
          if(rows?.[0]?.background_value!==uploaded)await cleanup(uploaded);
        } catch {notify('上传结果暂时无法确认，请联网后重试背景设置。','error');}
      }
    } finally {saving=false;setBusy(false);dialog.querySelectorAll('button,input').forEach(control=>control.disabled=false);}
  });
  dialog.querySelectorAll('[data-cancel]').forEach(control=>control.addEventListener('click',()=> {if(!saving)dialog.close();}));
  dialog.addEventListener('cancel',event=> {if(saving)event.preventDefault();});
  dialog.addEventListener('close',()=> {clearDraft();display(savedUrl);button.focus({preventScroll:true});});
  button.addEventListener('click',async()=> {
    if(isBusy())return;
    const uid=getUid();
    if(!ready)await load();
    if(!uid||uid!==getUid())return;
    draft={...saved};clearDraft();error.textContent=ready?'':'背景暂时无法读取，请关闭后重试。';
    markSelected();dialog.querySelector('[data-save]').disabled=!ready;dialog.showModal();
  });
  return {load,reset(){version++;ready=false;clearTimeout(refreshTimer);saved=paper();savedUrl='';dialog.close();clearDraft();display();}};
}
