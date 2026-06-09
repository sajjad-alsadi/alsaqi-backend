import { db } from '../db/index';

export class AnalyticsService {
  private static db = db;

  static async getFindingsByRisk() {
    return await this.db.prepare(`
      SELECT risk_level, COUNT(*) as count 
      FROM audit_findings 
      GROUP BY risk_level
    `).all();
  }

  static async getFindingsByStatus() {
    return await this.db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM audit_findings 
      GROUP BY status
    `).all();
  }

  static async getRecommendationsByStatus() {
    return await this.db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM recommendations 
      GROUP BY status
    `).all();
  }
}
