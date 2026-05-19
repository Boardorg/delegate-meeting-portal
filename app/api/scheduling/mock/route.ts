import { NextResponse } from 'next/server';
import { loadMockData } from '@/lib/scheduling/engine';
import path from 'path';

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), 'data', 'mock', 'attendees.csv');
    const attendees = await loadMockData(filePath);
    return NextResponse.json({ attendees });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
