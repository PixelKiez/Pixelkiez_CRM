import { ensureDatabase, getD1, rowToLead } from '@/lib/database';

export async function GET() {
  await ensureDatabase(); const db=getD1();
  const [{results},totals,statusCounts,recent]=await Promise.all([
    db.prepare('SELECT * FROM leads ORDER BY score DESC, name COLLATE NOCASE ASC').all(),
    db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN website_status='Nein' THEN 1 ELSE 0 END) without_website, SUM(CASE WHEN website_status='Prüfen' THEN 1 ELSE 0 END) checking, SUM(CASE WHEN website_status='Ja' THEN 1 ELSE 0 END) with_website, SUM(CASE WHEN status!='Neu' THEN 1 ELSE 0 END) contacted, SUM(CASE WHEN priority='Hoch' THEN 1 ELSE 0 END) high_priority, SUM(CASE WHEN phone IS NOT NULL AND phone!='' THEN 1 ELSE 0 END) with_phone, SUM(CASE WHEN email IS NOT NULL AND email!='' THEN 1 ELSE 0 END) with_email FROM leads`).first<Record<string,number>>(),
    db.prepare('SELECT status, COUNT(*) count FROM leads GROUP BY status').all<{status:string;count:number}>(),
    db.prepare('SELECT a.id,a.lead_id,a.type,a.detail,a.created_at,l.name FROM activities a LEFT JOIN leads l ON l.id=a.lead_id ORDER BY a.created_at DESC LIMIT 14').all<Record<string,string>>()]);
  return Response.json({leads:results.map(row=>rowToLead(row as Record<string,unknown>)),stats:{total:Number(totals?.total||0),withoutWebsite:Number(totals?.without_website||0),checking:Number(totals?.checking||0),withWebsite:Number(totals?.with_website||0),contacted:Number(totals?.contacted||0),highPriority:Number(totals?.high_priority||0),withPhone:Number(totals?.with_phone||0),withEmail:Number(totals?.with_email||0)},statusCounts:Object.fromEntries(statusCounts.results.map(r=>[r.status,r.count])),activities:recent.results});
}
export async function POST(request:Request){
  await ensureDatabase(); const db=getD1(); const body=await request.json() as Partial<import('@/lib/types').Lead>;
  if(!body.name?.trim())return Response.json({error:'Unternehmensname fehlt.'},{status:400});
  const max=await db.prepare("SELECT MAX(CAST(SUBSTR(id,4) AS INTEGER)) AS max_id FROM leads WHERE id LIKE 'PK-%'").first<{max_id:number}>();
  const id=`PK-${String(Number(max?.max_id||0)+1).padStart(4,'0')}`,now=new Date().toISOString();
  await db.prepare(`INSERT INTO leads (id,status,priority,score,name,category,street,zip,city,phone,email,website,website_status,website_class,age_score,problems,pitch,source,last_contact,next_action,follow_up,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,body.status||'Neu',body.priority||'Mittel',Number(body.score||50),body.name.trim(),body.category||null,body.street||null,body.zip||null,body.city||'Berlin',body.phone||null,body.email||null,body.website||null,body.websiteStatus||'Prüfen',body.websiteClass||null,0,body.problems||null,body.pitch||null,'Manuell angelegt',null,body.nextAction||'Erstkontakt vorbereiten',body.followUp||null,body.notes||null,now).run();
  await db.prepare('INSERT INTO activities (lead_id,type,detail,created_at) VALUES (?,?,?,?)').bind(id,'created','Lead manuell angelegt',now).run();
  const row=await db.prepare('SELECT * FROM leads WHERE id=?').bind(id).first<Record<string,unknown>>();
  return Response.json({lead:rowToLead(row!)},{status:201});
}
