import { BaseService } from './BaseService';

/**
 * RiskService — risk_register CRUD.
 *
 * Finding 1.20 → 2.20: `risk_score_calc` and `risk_level_calc` are DB-managed
 * derived columns (computed server-side from `likelihood_num` * `impact_num`).
 * They are intentionally NOT part of the `risk_register` write-schema whitelist
 * (see `columnWhitelist.ts`), so injecting them into the create/update body made
 * `checkWhitelist` reject the entire request and broke risk create/update.
 *
 * The fix is to NOT inject those derived columns into the data passed to
 * `BaseService.create/update`: the database derives them from the writable
 * `likelihood_num`/`impact_num` inputs. This keeps the whitelist check passing
 * while preserving correct, server-computed risk scoring.
 */
export class RiskService extends BaseService {
  static async create(tableName: string, data: any) {
    return super.create(tableName, data);
  }

  static async update(tableName: string, id: string | number, data: any) {
    return super.update(tableName, id, data);
  }
}
