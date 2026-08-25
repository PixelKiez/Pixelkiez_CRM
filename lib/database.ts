import { batch, prepare } from '@/lib/d1-node';
import seedLeads from '@/data/leads.json';
import type { Lead } from '@/lib/types';

let ready: Promise<void> | null = null;
const createStatements = [
  `CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'Neu', priority TEXT NOT NULL DEFAULT 'Mittel', score INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, category TEXT, street TEXT, zip TEXT, city TEXT, phone TEXT, email TEXT, website TEXT, website_status TEXT NOT NULL DEFAULT 'Prüfen', website_class TEXT, age_score INTEGER NOT NULL DEFAULT 0, problems TEXT, pitch TEXT, source TEXT, last_contact TEXT, next_action TEXT, follow_up TEXT, notes TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status_score ON leads(status, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_website_status ON leads(website_status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads(follow_up)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_lead_id ON activities(lead_id, created_at DESC)`,
];

export async function ensureDatabase() {
  if (ready) return ready;
  ready = (async () => {
    for (const sql of createStatements) prepare(sql).run();
    const count = await prepare('SELECT COUNT(*) AS count FROM leads').first<{ count: number }>();
    if (Number(count?.count || 0) > 0) return;
    const insert = `INSERT INTO leads (id,status,priority,score,name,category,street,zip,city,phone,email,website,website_status,website_class,age_score,problems,pitch,source,last_contact,next_action,follow_up,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const now = new Date().toISOString();
    const statements = (seedLeads as Lead[]).map(lead => prepare(insert).bind(lead.id,lead.status,lead.priority,lead.score,lead.name,lead.category,lead.street,lead.zip,lead.city,lead.phone,lead.email,lead.website,lead.websiteStatus,lead.websiteClass,lead.ageScore,lead.problems,lead.pitch,lead.source,lead.lastContact,lead.nextAction,lead.followUp,lead.notes,now));
    for (let i=0;i<statements.length;i+=60) await batch(statements.slice(i,i+60));
    await prepare('PRAGMA optimize').run();
  })();
  return ready;
}

export function getD1() {
  return {
    prepare(sql: string) {
      return prepare(sql);
    },
    batch,
  };
}

export function rowToLead(row: Record<string, unknown>): Lead {
  return { id:String(row.id),status:String(row.status),priority:String(row.priority),score:Number(row.score),name:String(row.name),category:row.category as string|null,street:row.street as string|null,zip:row.zip as string|null,city:row.city as string|null,phone:row.phone as string|null,email:row.email as string|null,website:row.website as string|null,websiteStatus:String(row.website_status),websiteClass:row.website_class as string|null,ageScore:Number(row.age_score),problems:row.problems as string|null,pitch:row.pitch as string|null,source:row.source as string|null,lastContact:row.last_contact as string|null,nextAction:row.next_action as string|null,followUp:row.follow_up as string|null,notes:row.notes as string|null,updatedAt:String(row.updated_at) };
}
