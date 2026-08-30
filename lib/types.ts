export type Lead = {
  id: string; status: string; priority: string; score: number; name: string;
  category: string | null; street: string | null; zip: string | null; city: string | null;
  phone: string | null; email: string | null; website: string | null;
  websiteStatus: string; websiteClass: string | null; ageScore: number;
  problems: string | null; pitch: string | null; source: string | null;
  lastContact: string | null; nextAction: string | null; followUp: string | null;
  notes: string | null; updatedAt?: string;
  /** Festpreis für die Webseite in Cent. Wird manuell gepflegt. */
  priceCents?: number | null;
  /** Zeitpunkt, zu dem der Kunde auf "Gewonnen" gesetzt wurde. */
  wonAt?: string | null;
  /** Strukturierter Absage-/Verlaufsgrund, siehe LOST_REASONS. */
  lostReason?: string | null;
  /** Wiedervorlage: Kunde bleibt im System, wird zu diesem Datum erneut angegangen. */
  recontactAt?: string | null;
  /** Anzahl erfolgloser Kontaktversuche. */
  contactAttempts?: number;
  /** Wer sich um diesen Kunden kümmert (E-Mail des Nutzers), null = frei. */
  ownerEmail?: string | null;
};

export type UserProfile = {
  email:string; displayName:string; signature:string; phone:string;
  googleEmail:string|null; googleCalendarId:string; googleConnected:boolean;
};

export type Invoice = {
  id:number; leadId:string; number:string; issuedAt:string; serviceDate:string|null;
  netCents:number; vatRate:number; vatCents:number; grossCents:number;
  title:string|null; status:string; paidAt:string|null; notes:string|null;
  createdAt:string; updatedAt:string;
  /** 'anzahlung' (50 %), 'schluss' (Restbetrag) oder 'komplett'. */
  kind:string; sharePercent:number;
  leadName?:string;
};

/** Kunden je Bezirk und Ortsteil, für Übersicht und Filterung. */
export type RegionRow = {
  bezirk:string; ortsteil:string; count:number; gewonnen:number; offen:number; verloren:number; revenueCents:number;
};

/** Kennzahlen für das interne Dashboard. */
export type DashboardData = {
  buckets: { gewonnen:number; verloren:number; offen:number; wiedervorlage:number };
  revenue: {
    totalCents:number; wonCount:number; averageCents:number;
    byWeek: Array<{ key:string; label:string; cents:number; count:number }>;
    byMonth: Array<{ key:string; label:string; cents:number; count:number }>;
  };
  invoices: { openCents:number; paidCents:number; openCount:number; paidCount:number };
  lostReasons: Array<{ reason:string; label:string; count:number }>;
  dueRecontacts: number;
  /** Aufschlüsselung nach Bezirk und Ortsteil. */
  regions: RegionRow[];
  districts: Array<{ bezirk:string; count:number; gewonnen:number; revenueCents:number }>;
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
