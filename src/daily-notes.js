// Notes are attached to a task AND calendar date, regardless of task type.
export function setupDailyNotes({ db, getUid, isBusy, setBusy, onChange }) {
  let cache = new Map();
  let loading = new Map();
  let failures = new Map();
  let generation = 0;
  let active = null;
  let saving = false;
  const dialog = document.createElement('dialog');
  dialog.id = 'noteDialog';
  dialog.setAttribute('aria-labelledby','noteHeading');
  dialog.innerHTML = `<form class="dialog-inner" id="noteForm">
    <div class="feature-heading"><h2 id="noteHeading">当日补充 <small>DAILY NOTE</small></h2><button type="button" class="icon-button" data-cancel aria-label="关闭补充">×</button></div>
    <p class="note-task-heading"></p><p class="form-hint" id="noteDateLabel"></p>
    <label class="sr-only" for="noteContent">补充内容</label><textarea id="noteContent" class="note-input" maxlength="500" rows="6" placeholder="今天推进到哪一步？有什么想留给自己的？" aria-describedby="noteCounter noteError"></textarea>
    <div class="note-counter" id="noteCounter">0 / 500</div>
    <p class="form-error" id="noteError" role="alert"></p>
    <div class="form-actions"><button type="button" class="button" data-clear>清空补充</button><button type="submit" class="button primary">保存补充</button></div>
  </form>`;
  document.body.append(dialog);
  const input = dialog.querySelector('textarea');
  const error = dialog.querySelector('#noteError');
  input.addEventListener('input', () => { dialog.querySelector('#noteCounter').textContent = `${input.value.length} / 500`; });

  async function load(date, force=false) {
    if (!getUid()) throw new Error('请先登录。');
    if (force) { cache.delete(date); failures.delete(date); }
    if (cache.has(date)) return cache.get(date);
    if (loading.has(date)) return loading.get(date);
    const currentGeneration = generation;
    const request = (async () => {
      const { data, error: loadError } = await db.from('todo_daily_notes').select('task_id,content').eq('note_date',date);
      if (loadError) throw loadError;
      const notes = new Map((data || []).map(row=>[row.task_id,row.content]));
      if (generation === currentGeneration) { cache.set(date,notes); failures.delete(date); }
      return notes;
    })().catch(loadError => {
      if (generation === currentGeneration) failures.set(date,loadError);
      throw loadError;
    }).finally(()=> { if (generation === currentGeneration) loading.delete(date); });
    loading.set(date,request);
    return request;
  }

  function mount(container, task, date) {
    const text = cache.get(date)?.get(task.id);
    container.replaceChildren();
    if (text) {
      const p = document.createElement('p'); p.className='daily-note'; p.textContent=text; container.append(p);
    }
    const button=document.createElement('button');
    button.className='note-trigger'; button.type='button'; button.dataset.action='note';
    button.textContent=failures.has(date) ? '补充读取失败 · 点击重试' : text ? '编辑补充' : cache.has(date) ? '＋ 当日补充' : '读取补充…';
    button.disabled=isBusy() || (!cache.has(date) && !failures.has(date));
    button.addEventListener('click', () => { void open(task,date,button); });
    container.append(button);
  }

  function ensure(date) {
    if (!getUid() || cache.has(date) || loading.has(date) || failures.has(date)) return;
    const epoch=generation;
    void load(date).catch(()=> { /* mount shows a retry action; no success is reported. */ }).finally(()=> {
      if (epoch===generation) onChange();
    });
  }

  async function open(task,date,returnTarget) {
    if (isBusy() || !getUid()) return;
    active={taskId:task.id,date,returnTarget,uid:getUid(),generation};
    const context=active;
    dialog.querySelector('.note-task-heading').textContent=task.title;
    dialog.querySelector('#noteDateLabel').textContent=`${date} · 仅记录这一天的补充`;
    input.value=''; error.textContent='正在读取…'; input.disabled=true;
    dialog.querySelector('[type="submit"]').disabled=true;
    dialog.querySelector('[data-clear]').disabled=true;
    dialog.showModal();
    try {
      const rows=await load(date,failures.has(date));
      if (active!==context || context.generation!==generation || !dialog.open) return;
      input.value=rows.get(task.id)||''; input.disabled=false; error.textContent='';
      dialog.querySelector('[type="submit"]').disabled=false;
      dialog.querySelector('[data-clear]').disabled=false;
      input.dispatchEvent(new Event('input')); input.focus(); onChange();
    } catch {
      error.textContent='补充暂时无法读取，请关闭后重试。';
    }
  }

  dialog.querySelector('[data-cancel]').addEventListener('click',()=> {if (!saving) dialog.close();});
  dialog.addEventListener('cancel',event=> {if (saving) event.preventDefault();});
  dialog.addEventListener('close',()=> {
    const target=active?.returnTarget?.isConnected ? active.returnTarget : [...document.querySelectorAll('.task-row')].find(row=>row.dataset.id===active?.taskId)?.querySelector('.note-trigger');
    target?.focus({preventScroll:true}); active=null;
  });
  dialog.querySelector('[data-clear]').addEventListener('click',()=> {
    if (!saving && confirm('清空这一天的补充？其他日期不会改变。')) { input.value=''; dialog.querySelector('form').requestSubmit(); }
  });
  dialog.querySelector('form').addEventListener('submit',async event=> {
    event.preventDefault();
    if (saving || isBusy() || !active || input.disabled) return;
    const context=active;
    const content=input.value.trim();
    if (content.length>500) { error.textContent='补充最多 500 字。'; return; }
    if (!getUid() || getUid()!==context.uid) {error.textContent='登录状态已改变，请重新打开补充。';return;}
    saving=true; setBusy(true); error.textContent='';
    dialog.querySelectorAll('button,textarea').forEach(control=>control.disabled=true);
    try {
      let request;
      if (!content) request=db.from('todo_daily_notes').delete().eq('task_id',context.taskId).eq('note_date',context.date);
      else request=db.from('todo_daily_notes').upsert({task_id:context.taskId,note_date:context.date,content,updated_at:new Date().toISOString()},{onConflict:'owner_id,task_id,note_date'});
      const { error: saveError }=await request;
      if (saveError) throw saveError;
      if (generation!==context.generation) return;
      const notes=cache.get(context.date)||new Map();
      if (content) notes.set(context.taskId,content); else notes.delete(context.taskId);
      cache.set(context.date,notes); dialog.close();
    } catch {
      error.textContent='保存失败，输入内容仍在，请重试。';
    } finally {
      saving=false; setBusy(false);
      dialog.querySelectorAll('button,textarea').forEach(control=>control.disabled=false);
      onChange();
    }
  });
  return {mount,ensure,reset() {generation++;cache=new Map();loading=new Map();failures=new Map();active=null;dialog.close();}};
}
