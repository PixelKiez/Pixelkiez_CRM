export type Lead = {
  id: string; status: string; priority: string; score: number; name: string;
  category: string | null; street: string | null; zip: string | null; city: string | null;
  phone: string | null; email: string | null; website: string | null;
  websiteStatus: string; websiteClass: string | null; ageScore: number;
  problems: string | null; pitch: string | null; source: string | null;
  lastContact: string | null; nextAction: string | null; followUp: string | null;
  notes: string | null; updatedAt?: string;
};
export type LeadStats = { total:number; withoutWebsite:number; checking:number; withWebsite:number; contacted:number; highPriority:number; withPhone:number; withEmail:number };
export type Activity = { id:number|string; lead_id:string; type:string; detail:string|null; created_at:string; name?:string };
export type SettingsView = {
  smtp_host:string; smtp_port:number|''; smtp_user:string; smtp_from:string; smtp_sender_name:string; smtp_pass_set:boolean;
  agent_key_set:boolean; agent_key_preview?:string;
  google_connected:boolean; google_email?:string; google_calendar_id?:string;
};
export type EmailTemplate = {
  id:number; slug:string; name:string; kind:string; subject:string; bodyHtml:string; updatedAt:string;
};
export type Appointment = {
  id:number; leadId:string; title:string; startTs:string; endTs:string;
  location:string|null; notes:string|null;
  gcalEventId:string|null; gcalLink:string|null;
  status:string; createdAt:string; updatedAt:string;
  leadName?:string;
};
