/**
 * One-off backfill: add meetingDateNum (YYYYMMDD number) to every chunk that
 * has a meetingDate, so date-filtered search can run server-side.
 * Safe to re-run; only touches chunks missing the field.
 */
import { getCollection, dateToNum } from '../services/vectordb.js';
import { IncludeEnum } from 'chromadb';

async function main() {
  const coll = await getCollection();
  const pageSize = 1000;
  let offset = 0;
  let updated = 0;
  for (;;) {
    const page = await coll.get({ include: [IncludeEnum.Metadatas], limit: pageSize, offset });
    if (page.ids.length === 0) break;
    const ids: string[] = [];
    const metadatas: Record<string, unknown>[] = [];
    page.ids.forEach((id, i) => {
      const meta = (page.metadatas[i] || {}) as Record<string, unknown>;
      if (typeof meta.meetingDate === 'string' && meta.meetingDateNum == null) {
        ids.push(id);
        metadatas.push({ ...meta, meetingDateNum: dateToNum(meta.meetingDate) });
      }
    });
    if (ids.length > 0) {
      await coll.update({ ids, metadatas: metadatas as any });
      updated += ids.length;
    }
    offset += page.ids.length;
    console.log(`Scanned ${offset}, updated ${updated}`);
  }
  console.log(`Done. Backfilled meetingDateNum on ${updated} chunks.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
