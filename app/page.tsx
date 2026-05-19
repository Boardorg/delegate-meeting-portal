export default function Home() {
  const routes = [
    { method: 'GET', path: '/api/salesforce/auth', description: 'Trigger Salesforce OAuth and return connection status' },
    { method: 'GET', path: '/api/salesforce/attendees', description: 'Query Attendee object (stub)' },
    { method: 'POST', path: '/api/scheduling/run', description: 'Accept attendee + request data, return scheduled meetings (stub)' },
    { method: 'GET', path: '/api/scheduling/mock', description: 'Load and return parsed mock CSV data' },
  ];

  return (
    <main style={{ fontFamily: 'monospace', maxWidth: 720, margin: '60px auto', padding: '0 24px' }}>
      <h1>Delegate Meeting Portal</h1>
      <p>App is running. Below are the available API routes.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 24 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 12px' }}>Method</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 12px' }}>Route</th>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '6px 12px' }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((r) => (
            <tr key={r.path}>
              <td style={{ padding: '6px 12px', color: '#0070f3' }}>{r.method}</td>
              <td style={{ padding: '6px 12px' }}><code>{r.path}</code></td>
              <td style={{ padding: '6px 12px', color: '#555' }}>{r.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
