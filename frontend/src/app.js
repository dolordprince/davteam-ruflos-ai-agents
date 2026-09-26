const $ = s => document.querySelector(s);
const state = {
  taskId: null,
  source: null,
  events: [],
  stages: [
    "INTERPRET","PLAN","TASK_SPLIT","EXECUTE","BUILD","TEST",
    "VERIFY","BROWSER_INSPECT","RUNTIME_INSPECT","ERROR_DETECT",
    "ANALYZE","FIX","REBUILD","REGRESSION","FINAL_INSPECT",
    "MEMORY","COMPLETE"
  ]
};

function log(message, type="info"){
  const item = {time:new Date().toLocaleTimeString(), message, type};
  state.events.unshift(item);
  $("#activityLog").innerHTML = state.events.map(e =>
    `<div class="event"><time>${e.time}</time>${escapeHtml(e.message)}</div>`
  ).join("");
}

function escapeHtml(v){
  return String(v ?? "").replace(/[&<>"']/g,c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function renderPipeline(active=-1){
  $("#pipeline").innerHTML = state.stages.map((s,i)=>{
    let cls = i < active ? "stage done" : i === active ? "stage active" : "stage";
    return `<div class="${cls}">${i+1}. ${s}</div>`;
  }).join("");
}

async function api(path, options={}){
  const response = await fetch(path,{
    ...options,
    headers:{"Content-Type":"application/json",...(options.headers||{})}
  });
  const text = await response.text();
  let data;
  try{data=JSON.parse(text)}catch{data={raw:text}}
  if(!response.ok) throw new Error(data.error || data.message || text || response.statusText);
  return data;
}

async function health(){
  try{
    const data = await api("/health");
    $("#runtimeStatus").textContent = "Online";
    log("Ruflo backend health check passed");
    return data;
  }catch(e){
    $("#runtimeStatus").textContent = "Offline";
    log("Health check failed: "+e.message);
  }
}

async function loadCapabilities(){
  try{
    const data = await api("/api/tools");
    $("#agentsOutput").textContent = JSON.stringify(data,null,2);
  }catch(e){
    $("#agentsOutput").textContent = "Tools endpoint unavailable: "+e.message;
  }
}

async function loadMemory(){
  try{
    const data = await api("/api/agent/knowledge");
    $("#memoryOutput").textContent = JSON.stringify(data,null,2);
  }catch(e){
    $("#memoryOutput").textContent = "Knowledge endpoint unavailable: "+e.message;
  }
}

async function runTask(goal){
  if(state.source){ state.source.close(); state.source=null; }

  $("#taskState").textContent = "Starting";
  $("#taskOutput").textContent = "";
  log("Submitting autonomous task: "+goal);

  let result;
  try{
    result = await api("/api/agent/run",{
      method:"POST",
      body:JSON.stringify({goal})
    });
  }catch(e){
    $("#taskState").textContent = "Error";
    $("#taskOutput").textContent = e.message;
    log("Task start failed: "+e.message,"error");
    return;
  }

  state.taskId = result.taskId || result.id || result.task_id;
  log("Task created: "+(state.taskId || "server-managed"));

  if(result.streamUrl){
    connectSSE(result.streamUrl);
  }else if(state.taskId){
    connectSSE(`/api/agent/stream/${encodeURIComponent(state.taskId)}`);
  }

  $("#taskState").textContent = "Running";
}

function connectSSE(url){
  try{
    state.source = new EventSource(url);

    state.source.onmessage = event=>{
      try{
        const data = JSON.parse(event.data);
        handleEvent(data);
      }catch{
        $("#taskOutput").textContent += event.data+"\n";
      }
    };

    state.source.onerror = ()=>{
      if(state.source){
        log("Stream disconnected; task remains server-side and can reconnect");
        state.source.close();
        state.source=null;
      }
    };
  }catch(e){
    log("SSE unavailable: "+e.message);
  }
}

function handleEvent(data){
  const message = data.message || data.output || data.event || JSON.stringify(data);
  $("#taskOutput").textContent += message+"\n";

  const stage = String(data.stage || data.phase || "").toUpperCase();
  const index = state.stages.indexOf(stage);
  if(index >= 0){
    renderPipeline(index);
    $("#pipelineState").textContent = stage;
  }

  if(data.status){
    $("#taskState").textContent = data.status;
  }

  log(message);

  if(["complete","completed","failed","cancelled"].includes(String(data.status||"").toLowerCase())){
    if(state.source){state.source.close();state.source=null}
  }
}

async function control(action){
  if(!state.taskId){
    log("No active task");
    return;
  }

  try{
    await api(`/api/agent/${encodeURIComponent(state.taskId)}/${action}`,{method:"POST"});
    log(`Task ${action} requested`);
  }catch(e){
    log(`Task ${action} failed: ${e.message}`,"error");
  }
}

document.querySelectorAll(".nav").forEach(button=>{
  button.onclick=()=>{
    document.querySelectorAll(".nav").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));
    button.classList.add("active");
    $("#"+button.dataset.panel).classList.add("active");
  };
});

$("#taskForm").onsubmit=e=>{
  e.preventDefault();
  const goal=$("#goal").value.trim();
  if(goal) runTask(goal);
};

$("#newTask").onclick=()=>{
  $("#goal").focus();
  $("#goal").value="";
  $("#taskState").textContent="Idle";
  $("#taskOutput").textContent="Waiting for a task…";
  renderPipeline(-1);
};

$("#refresh").onclick=()=>{health();loadCapabilities();loadMemory()};
$("#health").onclick=health;
$("#pause").onclick=()=>control("pause");
$("#resume").onclick=()=>control("resume");
$("#cancel").onclick=()=>control("cancel");
$("#clearActivity").onclick=()=>{
  state.events=[];
  $("#activityLog").innerHTML="";
};

renderPipeline(-1);
health();
loadCapabilities();
loadMemory();
log("Osiri workspace initialized");
