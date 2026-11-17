// The new shared views also work without MongoDB (file storage, current production
// behaviour), and the MongoDB-only actions say so instead of failing oddly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { SAMPLE_ROWS, fakeTransport, makeMailer, makeTempDir, makeWorkbookBuffer, startTestServer } from './helpers.js';

let n = 0;
const rid = () => `file-views-${Date.now()}-${(n += 1)}`;

test('file mode: config, Sent Emails, statistics and Excel export from sent-emails.xlsx', async () => {
  const dataDir = await makeTempDir();
  const smtp = fakeTransport();
  const srv = await startTestServer({ dataDir, mailer: makeMailer(smtp) });
  try {
    const cfg = (await srv.request('GET', '/api/app/config')).data.data;
    assert.equal(cfg.storage, 'file');
    assert.equal(cfg.features.operatorRequired, false, 'no operator prompt without the shared database');
    assert.equal(cfg.features.manualMarking, false);
    await srv.upload(makeWorkbookBuffer(SAMPLE_ROWS));
    // Sending works exactly as before (no operator needed).
    assert.equal((await srv.request('POST', '/api/send', { json: { rowNumber: 2, subject: 'S', body: 'B', requestId: rid() } })).status, 200);
    const sent = (await srv.request('GET', '/api/sent')).data.data;
    assert.equal(sent.total, 1);
    assert.equal(sent.items[0].sendMethod, 'SMTP');
    assert.match(sent.items[0].sentAtUtc, /Z$/, 'new rows carry a UTC timestamp');
    const stats = (await srv.request('GET', '/api/stats')).data.data;
    assert.equal(stats.totalSent, 1);
    assert.equal(stats.smtp, 1);
    assert.deepEqual(stats.inProgress, []);
    const act = (await srv.request('GET', '/api/activity')).data.data;
    assert.equal(act.available, false);
    const mark = await srv.request('POST', '/api/attorneys/mark-sent', { json: { rowNumber: 3 } });
    assert.equal(mark.data.error.code, 'NOT_AVAILABLE');
    const res = await fetch(`${srv.base}/api/history/export`);
    const rows = XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await res.arrayBuffer())).Sheets['Sent Emails']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]['Send Method'], 'SMTP');
  } finally {
    await srv.close();
  }
});
