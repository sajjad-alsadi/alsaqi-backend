import { db } from '../db/index';

export class RegulatoryService {
  static async getCentralBankInstructions() {
    return await db.prepare("SELECT * FROM central_bank_instructions").all();
  }

  static async getLawBank() {
    return await db.prepare("SELECT * FROM law_bank").all();
  }
}
