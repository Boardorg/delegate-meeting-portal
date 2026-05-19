import { NextResponse } from 'next/server';
import { authenticate } from '@/lib/salesforce/client';

export async function GET() {
  try {
    const token = await authenticate();
    return NextResponse.json({ status: 'connected', token: token === 'stub-access-token' ? '[stub]' : '[live]' });
  } catch (err) {
    return NextResponse.json({ status: 'error', message: String(err) }, { status: 500 });
  }
}
