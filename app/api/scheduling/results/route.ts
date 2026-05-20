import { NextResponse } from 'next/server';
import { loadMockData, loadMockRequests, runScheduler } from '@/lib/scheduling/engine';
import path from 'path';

export async function GET() {
  try {
    const base = path.join(process.cwd(), 'data', 'mock');
    const [attendees, requests] = await Promise.all([
      loadMockData(path.join(base, 'attendees.csv')),
      loadMockRequests(path.join(base, 'requests.csv')),
    ]);

    const { schedule, attendeeSchedules } = await runScheduler(attendees, requests);

    const byPass: Record<number, number> = {};
    for (const m of schedule) {
      byPass[m.passNumber] = (byPass[m.passNumber] ?? 0) + 1;
    }

    const scheduledIds = new Set(schedule.flatMap(m => [m.attendeeA, m.attendeeB]));
    const unmatchedAttendees = attendees
      .filter(a => !scheduledIds.has(a.id))
      .map(a => `${a.id} (${a.name})`);

    return NextResponse.json({
      summary: { totalMeetings: schedule.length, byPass, unmatchedAttendees },
      attendeeSchedules,
      allMeetings: schedule,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
