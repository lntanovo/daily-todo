// Development fixture only. Not imported by the production entry or build.
const key = 'daily-todo.FEATURE-FIXTURE.v1';
const uid = 'fixture-user';
const iso = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const today = iso(new Date());
const future = new Date(); future.setDate(future.getDate()+40);
const initial = {
  todo_tasks: [
    {owner_id:uid,id:'fixture-range',title:'给自己的计划，一点点添上细节',type:'range',start_date:today,end_date:iso(future),priority:'normal',created_at:new Date().toISOString()},
    {owner_id:uid,id:'fixture-single',title:'把今天的小事，好好完成',type:'single',task_date:today,priority:'urgent',start_time:'14:00',end_time:'15:30',created_at:new Date().toISOString()}
  ], todo_daily_completions:[],todo_completion_history:[],todo_daily_notes:[],todo_preferences:[],todo_task_recurrences:[],todo_task_templates:[],todo_focus_sessions:[],files:{}
};
let data = JSON.parse(localStorage.getItem(key) || 'null') || structuredClone(initial);
data.todo_completion_history ||= [];
data.todo_task_recurrences ||= [];
data.todo_task_templates ||= [];
data.todo_focus_sessions ||= [];
const persist = () => localStorage.setItem(key,JSON.stringify(data));
const controls = {failNext:'', snapshot:()=>structuredClone(data),replaceTable(table,rows){data[table]=structuredClone(rows);persist();}};
window.__fixture = controls;
function failure(operation) {
  if(controls.failNext===operation){controls.failNext='';return {data:null,error:{message:'模拟断网，请重试'}};}
}
function from(table) {
  let action='select', values, conflict=[], filters=[], offset=0, end=Infinity, orderField='', orderAscending=true;
  const query={
    select(){return query;},eq(field,value){filters.push(row=>row[field]===value);return query;},in(field,values){filters.push(row=>values.includes(row[field]));return query;},gte(field,value){filters.push(row=>row[field]>=value);return query;},lte(field,value){filters.push(row=>row[field]<=value);return query;},order(field,options={}){orderField=field;orderAscending=options.ascending!==false;return query;},
    range(a,b){offset=a;end=b;return query;},
    insert(value){action='insert';values=value;return query;},
    upsert(value,options){action='upsert';values=value;conflict=options.onConflict.split(',');return query;},
    update(value){action='update';values=value;return query;},
    delete(){action='delete';return query;},
    then(resolve,reject){return Promise.resolve().then(()=>{
      const failed=failure(`${table}:${action}`);if(failed)return failed;
      const matches=row=>filters.every(filter=>filter(row));
      const rows=data[table];
      if(action==='select'){
        const selected=rows.filter(matches);
        if(orderField)selected.sort((a,b)=>String(a[orderField]).localeCompare(String(b[orderField]))*(orderAscending?1:-1));
        return {data:structuredClone(selected.slice(offset,end+1)),error:null};
      }
      if(action==='delete') {
        const removed=rows.filter(matches);data[table]=rows.filter(row=>!matches(row));
        if(table==='todo_tasks') for(const dependent of ['todo_daily_notes','todo_daily_completions'])data[dependent]=data[dependent].filter(row=>!removed.some(task=>task.id===row.task_id));
        if(table==='todo_daily_completions') for(const old of removed){const history=data.todo_completion_history.find(row=>row.task_id===old.task_id&&row.completion_date===old.completion_date);if(history)history.is_active=false;}
      }
      if(action==='update')rows.filter(matches).forEach(row=>Object.assign(row,values));
      if(action==='insert'||action==='upsert')for(const value of Array.isArray(values)?values:[values]) {
        const row={owner_id:uid,...value};
        const existing=action==='upsert'&&rows.find(old=>conflict.every(field=>old[field]===row[field]));
        if(existing)Object.assign(existing,row);else rows.push(row);
        if(table==='todo_daily_completions'){
          const task=data.todo_tasks.find(task=>task.id===row.task_id);
          const history=data.todo_completion_history.find(item=>item.task_id===row.task_id&&item.completion_date===row.completion_date);
          const snapshot={owner_id:uid,task_id:row.task_id,task_title_snapshot:task?.title||'已删除任务',completion_date:row.completion_date,is_active:row.completed!==false,updated_at:new Date().toISOString()};
          if(history)Object.assign(history,snapshot);else data.todo_completion_history.push(snapshot);
        }
      }
      persist();return {data:null,error:null};
    }).then(resolve,reject);}
  };return query;
}
async function rpc(name,{p_data}={}) {
  if(name!=='restore_todo_backup_v1')return {data:null,error:{message:'未知数据库函数'}};
  const next=structuredClone(data);
  const order=['todo_tasks','todo_task_recurrences','todo_daily_notes','todo_daily_completions','todo_completion_history','todo_focus_sessions','todo_task_templates','todo_preferences'];
  let inserted=0;
  try {
    for(const table of order)for(const item of p_data[table]||[]){
      if(table==='todo_preferences'&&!['paper','preset'].includes(item.background_kind))continue;
      const row={...item,owner_id:uid};
      const key=entry=>table==='todo_preferences'?entry.owner_id:entry.id||`${entry.task_id}:${entry.completion_date||entry.note_date||''}`;
      if(next[table].some(existing=>key(existing)===key(row)))continue;
      if(table==='todo_focus_sessions'&&['running','paused'].includes(row.status)&&next[table].some(existing=>['running','paused'].includes(existing.status)))throw new Error('同一账号已有活动专注');
      if(['todo_task_recurrences','todo_daily_notes','todo_daily_completions'].includes(table)&&!next.todo_tasks.some(task=>task.id===row.task_id))throw new Error('任务不存在');
      next[table].push(row);inserted++;
    }
    data=next;persist();return {data:{inserted},error:null};
  }catch(error){return {data:null,error:{message:error.message}};}
}
const storage={from:()=>({
  async upload(path,blob){const failed=failure('storage:upload');if(failed)return failed;data.files[path]=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});persist();return {data:{path},error:null};},
  async createSignedUrl(path){return data.files[path]?{data:{fullSignedURL:data.files[path]},error:null}:{data:null,error:{message:'图片不存在'}};},
  async remove(paths){for(const path of paths)delete data.files[path];persist();return {data:paths.map(name=>({name})),error:null};}
})};
export default {init:()=>({rdb:()=>({from,rpc}),storage,auth:{
  getSession:async()=>({data:{session:{user:{id:uid,username:'本地预览'}}},error:null}),
  onAuthStateChange(){},signOut:async()=>({error:null})
}})};
