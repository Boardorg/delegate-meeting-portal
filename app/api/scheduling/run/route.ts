import { NextRequest, NextResponse } from 'next/server';
import { runScheduler } from '@/lib/scheduling/engine';
import { Attendee, MeetingRequest } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { attendees: Attendee[]; requests: MeetingRequest[] };
    const schedule = await runScheduler(body.attendees ?? [], body.requests ?? []);
    return NextResponse.json({ schedule });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
