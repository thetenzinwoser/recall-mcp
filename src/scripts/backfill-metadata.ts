/**
 * Backfill metadata on existing chunks: meetingDateNum (YYYYMMDD number) for
 * server-side date filters, and a path-based context for sessions and docs.
 * Safe to re-run; only touches chunks missing the field.
 */
import { getCollection, dateToNum } from '../services/vectordb.js';
import { contextFromPath } from '../services/classifier.js';
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
      const next = { ...meta };
      if (typeof meta.meetingDate === 'string' && meta.meetingDateNum == null) {
        next.meetingDateNum = dateToNum(meta.meetingDate);
      }
      // Sessions and docs get a path-based context; Wispr meetings get theirs
      // from the classifier when they're re-indexed.
      if (
        meta.context == null &&
        (meta.sourceType === 'claude-session' || meta.sourceType === 'strategy-doc')
      ) {
        next.context = contextFromPath(String(meta.filePath || ''), String(meta.meetingTitle || ''));
      }
      if (Object.keys(next).length !== Object.keys(meta).length) {
        ids.push(id);
        metadatas.push(next);
      }
    });
    if (ids.length > 0) {
      await coll.update({ ids, metadatas: metadatas as any });
      updated += ids.length;
    }
    offset += page.ids.length;
    console.log(`Scanned ${offset}, updated ${updated}`);
  }
  console.log(`Done. Backfilled metadata on ${updated} chunks.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
