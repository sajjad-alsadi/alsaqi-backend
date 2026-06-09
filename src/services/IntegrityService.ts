import { db } from '../db/index';

export class IntegrityService {
  static async getIntegrityStats() {
    const promises = [
      db.prepare("SELECT COUNT(*) as count FROM conflict_of_interest").get(),
      db.prepare("SELECT COUNT(*) as count FROM fraud_log").get(),
      db.prepare("SELECT COUNT(*) as count FROM conflict_of_interest WHERE status = 'pending'").get(),
      db.prepare("SELECT COUNT(*) as count FROM fraud_log WHERE status = 'Open' OR status = 'Pending'").get()
    ];

    const [conflictsTotal, fraudTotal, pendingConflicts, openFraud] = await Promise.all(promises) as any[];

    return {
      conflicts: {
        total: Number(conflictsTotal?.count || 0),
        pending: Number(pendingConflicts?.count || 0)
      },
      fraud: {
        total: Number(fraudTotal?.count || 0),
        open: Number(openFraud?.count || 0)
      },
      summary: {
        total: Number(conflictsTotal?.count || 0) + Number(fraudTotal?.count || 0),
        active: Number(pendingConflicts?.count || 0) + Number(openFraud?.count || 0)
      }
    };
  }
}
