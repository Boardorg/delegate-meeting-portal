import { NextRequest, NextResponse } from 'next/server';
import { getAttendees } from '@/lib/salesforce/client';

export async function GET(request: NextRequest) {
  const eventId = request.nextUrl.searchParams.get('eventId') ?? '';
  try {
    const attendees = await getAttendees(eventId);
    return NextResponse.json({ attendees });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
