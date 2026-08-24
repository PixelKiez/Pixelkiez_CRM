'use client';

import type { Lead } from '@/lib/types';

const label=(value:string|null)=>value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'Nicht angegeben';
const websiteTone=(value:string)=>value==='Ja'?'yes':value==='Nein'?'no':'check';
const websiteLabel=(value:string)=>value==='Ja'?'Bestätigt':value==='Nein'?'Keine':'Prüfen';
const telHref=(phone:string)=>`tel:${phone.replace(/[^\d+]/g,'')}`;
const smartAction=(lead:Lead)=>lead.websiteStatus==='Nein'&&lead.phone?'Telefonisch anbieten':lead.websiteStatus==='Prüfen'?'Website verifizieren':lead.email?'E-Mail mit Vorschlag':'Daten ergänzen';

export function LeadTable({leads,onOpen,onAskDelete}:{leads:Lead[];onOpen:(l:Lead)=>void;onAskDelete:(lead:Lead)=>void}){
  return <div className="lead-table">
    <div className="table-head"><span>Unternehmen</span><span>Status</span><span>Telefon</span><span>Webseite</span><span>Score</span><span>Nächster Schritt</span><span/></div>
    {leads.map(lead=><div className="lead-row" key={lead.id}>
      <button className="row-open" onClick={()=>onOpen(lead)}>
        <span className="company"><i>{lead.name.charAt(0)}</i><span><strong>{lead.name}</strong><small>{label(lead.category)} · {lead.id}</small></span></span>
        <span><em className={`pill ${lead.status==='Recherche offen'?'checking':websiteTone(lead.websiteStatus)==='no'?'lost':''}`}>{lead.status}</em></span>
        <span className="cell-phone">{lead.phone?<a href={telHref(lead.phone)} onClick={e=>e.stopPropagation()} title={`Anrufen: ${lead.phone}`}>☎ {lead.phone}</a>:<em className="no-data">—</em>}</span>
        <span className={`web-status ${websiteTone(lead.websiteStatus)}`}>● {websiteLabel(lead.websiteStatus)}</span>
        <span className="score"><b>{lead.score}</b><i><u style={{width:`${lead.score}%`}}/></i></span>
        <span className="next">{lead.nextAction||smartAction(lead)}</span>
      </button>
      <button className="row-delete" title={`${lead.name} löschen`} aria-label={`${lead.name} löschen`} onClick={()=>onAskDelete(lead)}>✕</button>
    </div>)}
    {!leads.length&&<div className="empty"><strong>Keine passenden Unternehmen</strong><span>Ändere Suche oder Filter.</span></div>}
  </div>;
}

export default function LeadWorkspace({title,subtitle,leads,websiteFilter,setWebsiteFilter,priorityFilter,setPriorityFilter,statusFilter,setStatusFilter,onOpen,onAskDelete}:{title:string;subtitle:string;leads:Lead[];websiteFilter:string;setWebsiteFilter:(v:string)=>void;priorityFilter:string;setPriorityFilter:(v:string)=>void;statusFilter:string;setStatusFilter:(v:string)=>void;onOpen:(l:Lead)=>void;onAskDelete:(lead:Lead)=>void}){
  return <article className="panel list-workspace">
    <div className="list-title">
      <div><h2>{title}</h2><p>{subtitle}</p></div>
      <div className="filter-row">
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} aria-label="Status filtern">
          <option>Alle</option>{['Neu','E Mail gesendet','Recherche offen','Telefonat geplant','Erstgespräch geplant','Angebot gesendet','Gewonnen','Verloren','Ausgeschlossen'].map(s=><option key={s}>{s}</option>)}
        </select>
        <select value={websiteFilter} onChange={e=>setWebsiteFilter(e.target.value)} aria-label="Website-Status filtern"><option>Alle</option><option value="Nein">Keine Webseite</option><option value="Prüfen">Prüfen</option><option value="Ja">Bestätigt</option></select>
        <select value={priorityFilter} onChange={e=>setPriorityFilter(e.target.value)} aria-label="Priorität filtern"><option>Alle</option><option>Hoch</option><option>Mittel</option><option>Niedrig</option></select>
      </div>
    </div>
    <LeadTable leads={leads.slice(0,80)} onOpen={onOpen} onAskDelete={onAskDelete}/>
    {leads.length>80&&<p className="list-foot">Die ersten 80 von {leads.length} Treffern werden angezeigt. Nutze Suche und Filter zum Eingrenzen.</p>}
  </article>;
}
