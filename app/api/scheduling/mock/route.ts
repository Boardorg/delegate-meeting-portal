import { NextResponse } from 'next/server';
import { loadMockData, loadMockRequests } from '@/lib/scheduling/engine';
import path from 'path';

export async function GET() {
  try {
    const base = path.join(process.cwd(), 'data', 'mock');
    const [attendees, requests] = await Promise.all([
      loadMockData(path.join(base, 'attendees.csv')),
      loadMockRequests(path.join(base, 'requests.csv')),
    ]);
    return NextResponse.json({ attendees, requests });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
