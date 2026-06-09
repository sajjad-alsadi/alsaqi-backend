import { BaseService } from './BaseService';

export class RiskService extends BaseService {
  static computeRiskScore(data: any) {
    if (data.likelihood_num !== undefined && data.impact_num !== undefined) {
      data.risk_score_calc = data.likelihood_num * data.impact_num;
      const score = data.risk_score_calc;
      data.risk_level_calc = score >= 20 ? 'critical' : score >= 8 ? 'high' : score >= 4 ? 'medium' : score >= 2 ? 'low' : 'negligible';
    }
  }

  static async create(tableName: string, data: any) {
    if (tableName === 'risk_register') {
      this.computeRiskScore(data);
    }
    return super.create(tableName, data);
  }

  static async update(tableName: string, id: string | number, data: any) {
    if (tableName === 'risk_register') {
      this.computeRiskScore(data);
    }
    return super.update(tableName, id, data);
  }
}
