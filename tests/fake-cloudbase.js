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
  ], todo_daily_completions:[],todo_daily_notes:[],todo_preferences:[],files:{}
};
let data = JSON.parse(localStorage.getItem(key) || 'null') || structuredClone(initial);
const persist = () => localStorage.setItem(key,JSON.stringify(data));
const controls = {failNext:'', snapshot:()=>structuredClone(data)};
window.__fixture = controls;
function failure(operation) {
  if(controls.failNext===operation){controls.failNext='';return {data:null,error:{message:'模拟断网，请重试'}};}
}
function from(table) {
  let action='select', values, conflict=[], filters=[], offset=0, end=Infinity;
  const query={
    select(){return query;},eq(field,value){filters.push(row=>row[field]===value);return query;},order(){return query;},
    range(a,b){offset=a;end=b;return query;},
    insert(value){action='insert';values=value;return query;},
    upsert(value,options){action='upsert';values=value;conflict=options.onConflict.split(',');return query;},
    update(value){action='update';values=value;return query;},
    delete(){action='delete';return query;},
    then(resolve,reject){return Promise.resolve().then(()=>{
      const failed=failure(`${table}:${action}`);if(failed)return failed;
      const matches=row=>filters.every(filter=>filter(row));
      const rows=data[table];
      if(action==='select')return {data:structuredClone(rows.filter(matches).slice(offset,end+1)),error:null};
      if(action==='delete') {
        const removed=rows.filter(matches);data[table]=rows.filter(row=>!matches(row));
        if(table==='todo_tasks') for(const dependent of ['todo_daily_notes','todo_daily_completions'])data[dependent]=data[dependent].filter(row=>!removed.some(task=>task.id===row.task_id));
      }
      if(action==='update')rows.filter(matches).forEach(row=>Object.assign(row,values));
      if(action==='insert'||action==='upsert')for(const value of Array.isArray(values)?values:[values]) {
        const row={owner_id:uid,...value};
        const existing=action==='upsert'&&rows.find(old=>conflict.every(field=>old[field]===row[field]));
        if(existing)Object.assign(existing,row);else rows.push(row);
      }
      persist();return {data:null,error:null};
    }).then(resolve,reject);}
  };return query;
}
const storage={from:()=>({
  async upload(path,blob){const failed=failure('storage:upload');if(failed)return failed;data.files[path]=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});persist();return {data:{path},error:null};},
  async createSignedUrl(path){return data.files[path]?{data:{fullSignedURL:data.files[path]},error:null}:{data:null,error:{message:'图片不存在'}};},
  async remove(paths){for(const path of paths)delete data.files[path];persist();return {data:paths.map(name=>({name})),error:null};}
})};
export default {init:()=>({rdb:()=>({from}),storage,auth:{
  getSession:async()=>({data:{session:{user:{id:uid,username:'本地预览'}}},error:null}),
  onAuthStateChange(){},signOut:async()=>({error:null})
}})};
