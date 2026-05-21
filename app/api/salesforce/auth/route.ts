import { NextResponse } from 'next/server';
import { authenticate } from '@/lib/salesforce/client';

export async function GET() {
  try {
    const { instanceUrl } = await authenticate();
    return NextResponse.json({ status: 'connected', instanceUrl });
  } catch (err) {
    return NextResponse.json({ status: 'error', message: String(err) }, { status: 500 });
  }
}
