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
