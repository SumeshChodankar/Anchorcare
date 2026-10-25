import {memoryApi} from './memoryApi';
function wait(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{
 if(signal.aborted)return reject(new DOMException('Cancelled','AbortError'));
 const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
 const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});
});}
export async function runCompanionJob(key:string,payload:any,options:{signal:AbortSignal;onJob:(id:string)=>void;onProgress:(message:string)=>void;onInterim?:(result:any)=>void;pollMs?:number},api=memoryApi){
 const signal=AbortSignal.any([options.signal,AbortSignal.timeout(100000)]);
 const started=await api(key,'/asks',payload,signal);options.onJob(started.jobId);
 let pollFailures=0,first=true;
 for(;;){
  signal.throwIfAborted();let snapshot:any;
  // A serverless host answers within the request, so the job may already be finished.
  if(first&&(first=false,started.state!=='pending'))snapshot=started;
  else try{snapshot=await api(key,'/asks/'+started.jobId,undefined,signal);pollFailures=0;}
  catch(e:any){if(signal.aborted)throw e;if((e.status&&![408,429,500,502,503,504].includes(e.status))||pollFailures>=2)throw e;pollFailures++;options.onProgress('Reconnecting to your reply...');await wait((options.pollMs??1000)*pollFailures,signal);continue;}
  if(snapshot.state==='completed'){if(!snapshot.result)throw Error('No checked reply returned. Please ask again.');return snapshot.result;}
  if(snapshot.state==='failed')throw Error(snapshot.error||'Reply unavailable. Please try again.');
  if(snapshot.state==='cancelled')throw new DOMException('Cancelled','AbortError');
  if(snapshot.interim)options.onInterim?.(snapshot.interim);
  options.onProgress(snapshot.phase==='retrying'?'The connection is slow. I am retrying automatically...':snapshot.phase==='generating'?'I found saved information and am preparing your answer...':snapshot.phase==='verifying'?'I am checking that the answer matches your saved information...':'I am checking your saved information...');
  await wait(options.pollMs??1000,signal);
 }
}
