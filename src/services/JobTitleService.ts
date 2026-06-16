import { db } from '../db/index';
import { NotFoundError, ValidationError } from '../utils/errors';
import { AuditChainService } from './AuditChainService';

export class JobTitleService {
  static async getAll() {
    return await db.prepare(`SELECT * FROM job_titles`).all();
  }

  static async create(data: any, username: string) {
    const { name, department, job_level, description, reporting_to, status } = data;
    const stmt = db.prepare(`INSERT INTO job_titles (name, department, job_level, description, reporting_to, status) VALUES (?, ?, ?, ?, ?, ?)`);
    const info = await stmt.run(name, department, job_level, description, reporting_to || null, status || 'Active');
    
    await AuditChainService.append({
      user: username,
      action: 'Created Job Title',
      module: 'Job Titles',
      details: `Created job title ${name}`,
    });
      
    return { id: info.lastInsertRowid, name, department, job_level, description, reporting_to, status: status || 'Active' };
  }

  static async update(id: string | number, data: any, username: string) {
    const { name, department, job_level, description, reporting_to, status } = data;
    await db.prepare(`UPDATE job_titles SET name = ?, department = ?, job_level = ?, description = ?, reporting_to = ?, status = ? WHERE id = ?`)
      .run(name, department, job_level, description, reporting_to || null, status, id);
    
    await AuditChainService.append({
      user: username,
      action: 'Updated Job Title',
      module: 'Job Titles',
      details: `Updated job title ID ${id}`,
    });
      
    return true;
  }

  static async delete(id: string | number, username: string) {
    // Check if assigned to any users
    const assignedUsers = await db.prepare("SELECT COUNT(*) as count FROM users WHERE job_title_id = ?").get(id) as any;
    if (assignedUsers.count > 0) {
      throw new ValidationError("Cannot delete job title assigned to users. Please mark as Inactive instead.");
    }

    const jobTitle = await db.prepare("SELECT name FROM job_titles WHERE id = ?").get(id) as any;
    if (!jobTitle) throw new NotFoundError("Job title not found");
    
    await db.prepare(`DELETE FROM job_titles WHERE id = ?`).run(id);
    
    await AuditChainService.append({
      user: username,
      action: 'Deleted Job Title',
      module: 'Job Titles',
      details: `Deleted job title ${jobTitle.name}`,
    });
      
    return true;
  }
}
