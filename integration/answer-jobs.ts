import {randomUUID} from 'node:crypto';
import {ApiError} from '../engram-retrieval/src/validation.js';
type Job={id:string;actor:string;state:string;phase:string;expires:number;controller:AbortController;result?:any;interim?:any;error?:string;memoryInput?:any;timer?:ReturnType<typeof setTimeout>;done?:Promise<void>};
export class AnswerJobs{
 private jobs=new Map<string,Job>();
 constructor(private lifetimeMs=10*60000,private deadlineMs=90000){}
 start(actor:string,run:(signal:AbortSignal,progress:(phase:string)=>void,onContext:(input:any)=>void,onInterim:(result:any)=>void)=>Promise<any>){
  for(const [id,j]of this.jobs)if(j.expires<Date.now()){j.controller.abort();if(j.timer)clearTimeout(j.timer);this.jobs.delete(id);}
  if([...this.jobs.values()].filter(j=>j.actor===actor&&j.state==='pending').length>=2)throw new ApiError(429,'Two replies are already in progress; cancel one before asking again');
  if(this.jobs.size>=100)throw new ApiError(503,'Too many active conversations. Please retry shortly.');
  const job:Job={id:randomUUID(),actor,state:'pending',phase:'checking',expires:Date.now()+this.lifetimeMs,controller:new AbortController()};
  this.jobs.set(job.id,job);
  job.timer=setTimeout(()=>{if(job.state==='pending'){job.controller.abort();job.state='failed';job.error='The reply is taking too long. Please try again; reminders are still running.';}},this.deadlineMs);
  job.done=run(job.controller.signal,p=>{if(job.state==='pending')job.phase=p;},input=>{job.memoryInput=input;},result=>{if(job.state==='pending')job.interim=result;}).then(result=>{
   if(job.controller.signal.aborted||job.state!=='pending')return;
   job.result=result;job.state='completed';job.phase='ready';
  }).catch((e:any)=>{
   if(job.state!=='pending')return;
   job.state=job.controller.signal.aborted?'cancelled':'failed';
   job.error=e.status&&e.status<500?e.message:'The reply is unavailable right now. Please try again. Reminders continue separately.';
  }).finally(()=>{if(job.timer)clearTimeout(job.timer);});
  return {jobId:job.id,state:job.state,phase:job.phase};
 }
 get(id:string,actor:string){const j=this.jobs.get(id);if(!j||j.actor!==actor||j.expires<Date.now())throw new ApiError(404,'Reply request not found');return j;}
 cancel(id:string,actor:string){const j=this.get(id,actor);j.controller.abort();j.state='cancelled';if(j.timer)clearTimeout(j.timer);j.result=undefined;j.interim=undefined;return {jobId:j.id,state:j.state};}
 snapshot(j:Job){return {jobId:j.id,state:j.state,phase:j.phase,...(j.error?{error:j.error}:{}),...(j.result?{result:j.result}:{}),...(j.state==='pending'&&j.interim?{interim:j.interim}:{})};}
 close(){for(const j of this.jobs.values()){j.controller.abort();if(j.timer)clearTimeout(j.timer);}this.jobs.clear();}
}
