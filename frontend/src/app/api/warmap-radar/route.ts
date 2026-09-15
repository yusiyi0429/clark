import { after, NextResponse } from 'next/server';
import { beginScan, radarState, refreshOntologyMonitoring, scanRadar, updateRadar } from '@/lib/warmap/radar-server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;
export async function GET() { return NextResponse.json(await refreshOntologyMonitoring(), { headers: { 'Cache-Control': 'no-store' } }); }
export async function POST(request: Request) {
  const raw = await request.text(); if (raw.length > 30000) return NextResponse.json({error:'内容过长'}, {status:413});
  try { const body = JSON.parse(raw); if (body.action === 'scan') { if (beginScan()) after(scanRadar); return NextResponse.json(radarState(), {status:202}); }
    return NextResponse.json(updateRadar(body));
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '请求无效' }, {status:400}); }
}
