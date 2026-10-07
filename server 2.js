require("dotenv").config();
const express=require("express"), cors=require("cors"), fs=require("fs"), path=require("path"), crypto=require("crypto");
const OpenAI=require("openai");
const {execFile}=require("child_process");
const app=express(); app.use(cors()); app.use(express.json({limit:"2mb"}));
const PORT=process.env.PORT||3000, R=path.join(__dirname,"renders"); fs.mkdirSync(R,{recursive:true});
const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});

app.use("/renders",express.static(R));

app.post("/api/story",async(req,res)=>{
 try{
  const {idea,duration=60,style="Anime",language="Hinglish"}=req.body;
  const prompt=`Create a ${duration}-second ${style} vertical YouTube Short in ${language}. Idea: ${idea}.
Return ONLY JSON with title and scenes. Split into 5-10 second scenes whose durations total approximately ${duration}.
Each scene: scene number, duration, narration, visual_prompt, camera, sound.`;
  const r=await openai.responses.create({model:process.env.OPENAI_TEXT_MODEL||"gpt-5.6-mini",input:prompt});
  let txt=r.output_text.replace(/```json|```/g,"").trim();
  res.json(JSON.parse(txt));
 }catch(e){res.status(500).json({error:e.message})}
});

function provider(){return process.env.VIDEO_PROVIDER||"higgsfield";}
const jobs=new Map();
app.post("/api/video/jobs",async(req,res)=>{
 try{
  const {projectId,scenes}=req.body; const created=[];
  for(const sc of scenes){
   const id=crypto.randomUUID();
   const payload={id,projectId,scene:sc.scene,status:"queued",url:null,createdAt:Date.now()};
   jobs.set(id,payload);
   // Provider adapter: replace submitProviderJob with the official provider API contract.
   await submitProviderJob(payload,sc);
   created.push({id,scene:sc.scene});
  }
  res.json({provider:provider(),jobs:created});
 }catch(e){res.status(500).json({error:e.message})}
});

async function submitProviderJob(job,scene){
 const base=process.env.HIGGSFIELD_API_URL;
 if(!base || !process.env.HIGGSFIELD_API_KEY){
   jobs.get(job.id).status="failed";
   jobs.get(job.id).error="Video provider is not configured. Set HIGGSFIELD_API_URL and HIGGSFIELD_API_KEY.";
   return;
 }
 const r=await fetch(base,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.HIGGSFIELD_API_KEY},
 body:JSON.stringify({model:process.env.HIGGSFIELD_VIDEO_MODEL||"seedance_2_5",prompt:scene.visual_prompt,duration:scene.duration,aspect_ratio:"9:16"})});
 if(!r.ok) throw new Error("Video provider HTTP "+r.status);
 const data=await r.json();
 jobs.get(job.id).providerJobId=data.id||data.job_id;
 jobs.get(job.id).status=data.status||"processing";
 jobs.get(job.id).url=data.url||data.video_url||null;
}

app.get("/api/video/jobs/:id",async(req,res)=>{
 const j=jobs.get(req.params.id); if(!j)return res.status(404).json({error:"Job not found"});
 // Generic adapter: if provider returns a job id, poll its status endpoint.
 if(j.providerJobId && !j.url && process.env.HIGGSFIELD_STATUS_URL){
  const u=process.env.HIGGSFIELD_STATUS_URL.replace("{id}",encodeURIComponent(j.providerJobId));
  const r=await fetch(u,{headers:{Authorization:"Bearer "+process.env.HIGGSFIELD_API_KEY}});
  if(r.ok){const d=await r.json(); j.status=d.status||j.status; j.url=d.url||d.video_url||j.url;}
 }
 if(j.url) j.status="completed";
 res.json({id:j.id,scene:j.scene,status:j.status,url:j.url,error:j.error});
});

app.post("/api/voice",async(req,res)=>{
 try{
  const {text,language="Hinglish"}=req.body;
  const speech=await openai.audio.speech.create({model:process.env.OPENAI_TTS_MODEL||"gpt-4o-mini-tts",voice:process.env.OPENAI_TTS_VOICE||"alloy",input:text,instructions:`Natural ${language} narration. Clear, expressive, short-form video voiceover.`});
  const file=path.join(R,"voice-"+crypto.randomUUID()+".mp3");
  fs.writeFileSync(file,Buffer.from(await speech.arrayBuffer()));
  res.json({url:"/renders/"+path.basename(file)});
 }catch(e){res.status(500).json({error:e.message})}
});

app.post("/api/captions",(req,res)=>{
 const {scenes=[]}=req.body; let t=0,srt="";
 for(const sc of scenes){
  const start=fmt(t), end=fmt(t+Number(sc.duration||5)); t+=Number(sc.duration||5);
  srt+=`${sc.scene}\n${start} --> ${end}\n${String(sc.narration||"").replace(/\\n/g," ")}\n\n`;
 }
 res.json({srt});
});
function fmt(sec){const ms=Math.round((sec%1)*1000); const z=Math.floor(sec); const h=String(Math.floor(z/3600)).padStart(2,"0"),m=String(Math.floor(z%3600/60)).padStart(2,"0"),s=String(z%60).padStart(2,"0");return `${h}:${m}:${s},${String(ms).padStart(3,"0")}`}

function run(cmd,args){return new Promise((resolve,reject)=>execFile(cmd,args,{maxBuffer:1024*1024*20},(e,stdout,stderr)=>e?reject(new Error(stderr||e.message)):resolve(stdout)));}
async function download(url,file){
 if(url.startsWith("/renders/")) {fs.copyFileSync(path.join(R,path.basename(url)),file);return;}
 const r=await fetch(url); if(!r.ok)throw new Error("Clip download failed "+r.status);
 fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));
}
app.post("/api/render",async(req,res)=>{
 const tmp=path.join(R,"tmp-"+crypto.randomUUID()); fs.mkdirSync(tmp);
 try{
  const {clips=[],voiceUrl=null,musicUrl=null,captions=""}=req.body;
  if(!clips.length)throw new Error("No clips supplied");
  const normalized=[];
  for(let i=0;i<clips.length;i++){
   const f=path.join(tmp,`c${i}.mp4`); await download(clips[i].url,f);
   const n=path.join(tmp,`n${i}.mp4`);
   await run("ffmpeg",["-y","-i",f,"-vf","scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2","-r","30","-c:v","libx264","-pix_fmt","yuv420p","-an",n]);
   normalized.push(n);
  }
  const list=path.join(tmp,"list.txt"); fs.writeFileSync(list,normalized.map(x=>`file '${x.replace(/'/g,"'\\\\''")}'`).join("\n"));
  const joined=path.join(tmp,"joined.mp4");
  await run("ffmpeg",["-y","-f","concat","-safe","0","-i",list,"-c","copy",joined]);
  let current=joined;
  if(voiceUrl){
   const vf=path.join(tmp,"voice.mp3"); await download(voiceUrl,vf);
   const out=path.join(tmp,"voice.mp4");
   await run("ffmpeg",["-y","-i",current,"-i",vf,"-filter_complex","[1:a]apad[a]","-map","0:v:0","-map","[a]","-c:v","copy","-c:a","aac","-shortest",out]);
   current=out;
  }
  if(musicUrl){
   const mf=path.join(tmp,"music.mp3"); await download(musicUrl,mf);
   const out=path.join(tmp,"music.mp4");
   await run("ffmpeg",["-y","-i",current,"-i",mf,"-filter_complex","[1:a]volume=0.12,aloop=loop=-1:size=2e+09[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=2[a]","-map","0:v:0","-map","[a]","-c:v","copy","-c:a","aac","-shortest",out]);
   current=out;
  }
  if(captions){
   const sf=path.join(tmp,"captions.srt"); fs.writeFileSync(sf,captions);
   const out=path.join(tmp,"captioned.mp4");
   await run("ffmpeg",["-y","-i",current,"-vf",`subtitles=${sf.replace(/:/g,"\\:")}:force_style='FontSize=18,Outline=2,Alignment=2,MarginV=90'`,"-c:v","libx264","-c:a","copy",out]);
   current=out;
  }
  const final="final-"+crypto.randomUUID()+".mp4"; fs.copyFileSync(current,path.join(R,final));
  res.json({url:"/renders/"+final});
 }catch(e){res.status(500).json({error:e.message})}
 finally{fs.rmSync(tmp,{recursive:true,force:true})}
});

app.get("/health",(req,res)=>res.json({ok:true,app:"GlitchMind AI",login:false}));
app.listen(PORT,"0.0.0.0",()=>console.log(`GlitchMind AI server on ${PORT}`));
