'use client';
import useSWR from 'swr';
import { useState } from 'react';
import type { RadarState } from '@/lib/warmap/radar-types';
export function useRadar() {
  const [actionError,setActionError] = useState('');
  const {data,mutate,error} = useSWR<RadarState>('/api/warmap-radar',async url=>{const r=await fetch(url);if(!r.ok)throw new Error('雷达暂不可用');return r.json();},{refreshInterval:state=>state?.run.status==='running'?2000:30000,revalidateOnFocus:true});
  async function act(action:string,extra:Record<string,unknown>={}) {
    setActionError('');
    try {const r=await fetch('/api/warmap-radar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});const result=await r.json();if(!r.ok)throw new Error(result.error||'操作未完成');await mutate(result,{revalidate:false});return true;}
    catch(e){setActionError(e instanceof Error?e.message:'操作未完成');return false;}
  }
  return {data,act,error:actionError||(error?'雷达暂不可用，请稍后重试':'')};
}
